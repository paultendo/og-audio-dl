/**
 * og-audio-dl — Download audio from any webpage using Open Graph metadata
 *
 * The Open Graph protocol (ogp.me) defines standard meta tags that websites
 * use to describe their content. The og:audio tag specifies a URL to an audio
 * file. This worker reads that public metadata and helps download the file.
 *
 * Endpoints:
 *   GET /           — Serves the frontend UI
 *   GET /api/info?url=<url>  — Returns JSON with extracted audio metadata
 */

// --- Rate limiting (per-IP, in-memory) ---
const RATE_LIMIT_WINDOW = 60_000; // 1 minute
const RATE_LIMIT_MAX = 15;        // max requests per window
const rateLimitMap = new Map();

function checkRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip);
  if (!entry || now - entry.start > RATE_LIMIT_WINDOW) {
    rateLimitMap.set(ip, { start: now, count: 1 });
    return true;
  }
  entry.count++;
  return entry.count <= RATE_LIMIT_MAX;
}

// --- Response cache (in-memory, 5 min TTL) ---
const CACHE_TTL = 5 * 60_000;
const cache = new Map();

function getCached(url) {
  const entry = cache.get(url);
  if (entry && Date.now() - entry.time < CACHE_TTL) return entry.data;
  if (entry) cache.delete(url);
  return null;
}

function setCache(url, data) {
  cache.set(url, { data, time: Date.now() });
  // Evict old entries if cache grows too large
  if (cache.size > 200) {
    const now = Date.now();
    for (const [k, v] of cache) {
      if (now - v.time > CACHE_TTL) cache.delete(k);
    }
  }
}

const META_TAGS = [
  'og:audio',
  'og:audio:url',
  'og:audio:secure_url',
  'twitter:player:stream',
];

const TITLE_TAGS = ['og:title', 'twitter:title'];

/**
 * Extract the value of a meta tag from HTML.
 * Handles both property="..." and name="..." attributes.
 */
function extractMeta(html, tag) {
  // Match <meta property="tag" content="value"> or <meta name="tag" content="value">
  // Also handle content before property/name
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${tag}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${tag}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return match[1];
  }
  return null;
}

/**
 * Extract the <title> tag content as a fallback.
 */
function extractTitle(html) {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : null;
}

/**
 * Extract artist from meta description.
 * Handles formats like:
 *   "Title by Artist (@handle). ..."  (Suno)
 *   "Title by Artist on ..."
 */
function extractArtist(html) {
  const desc = extractMeta(html, 'description');
  if (!desc) return null;
  const match = desc.match(/\bby\s+([^(@]+?)(?:\s*\(@[^)]+\))?[.\s]+(Listen|on\s)/i);
  if (match) return decodeEntities(match[1].trim()) || null;
  return null;
}

// --- Suno lyrics extraction ---

function normaliseSunoEscapes(str) {
  return str
    .replace(/\\"/g, '"')
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&')
    .replace(/\\n/g, '\n');
}

function extractSunoFlightChunks(html) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,"([\s\S]*?)"\]\)<\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    chunks.push(normaliseSunoEscapes(m[1]));
  }
  return chunks;
}

function looksLikeSunoLyrics(text) {
  const t = text.trim();
  if (t.length < 80) return false;
  if (t.includes('{"')) return false;
  if (t.includes(':["$')) return false;
  if (t.includes('"$L')) return false;
  if (/^[a-z0-9]+:/i.test(t)) return false;
  const lines = t.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 4) return false;
  const words = (t.match(/[A-Za-z]{2,}/g) ?? []).length;
  return words >= 20;
}

function extractJsonObject(src, start) {
  if (src[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') { depth++; continue; }
    if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function resolveSunoPromptToken(html, token) {
  if (!/^\$\d+$/.test(token)) return null;
  const chunks = extractSunoFlightChunks(html);
  const id = token.slice(1);
  const ti = chunks.findIndex(c => c.includes(`${id}:T`) || c.includes(`${id}:`));
  if (ti !== -1) {
    for (let i = ti + 1; i < Math.min(chunks.length, ti + 8); i++) {
      if (looksLikeSunoLyrics(chunks[i])) return chunks[i].trim();
    }
  }
  const ci = chunks.findIndex(c => c.includes('"clip":{'));
  if (ci > 0 && looksLikeSunoLyrics(chunks[ci - 1])) return chunks[ci - 1].trim();
  const fallback = chunks.find(c => looksLikeSunoLyrics(c));
  return fallback ? fallback.trim() : null;
}

function extractSunoLyrics(html) {
  const norm = normaliseSunoEscapes(html);
  const clipIdx = norm.indexOf('"clip":{');
  if (clipIdx === -1) return null;
  const objStart = norm.indexOf('{', clipIdx + '"clip":'.length);
  if (objStart === -1) return null;
  const clipJson = extractJsonObject(norm, objStart);
  if (!clipJson) return null;
  try {
    const clip = JSON.parse(clipJson);
    const meta = (clip.metadata && typeof clip.metadata === 'object') ? clip.metadata : {};
    const displayed = (clip.displayed_lyrics || meta.displayed_lyrics || '').trim() || null;
    if (displayed && !/^\$\d+$/.test(displayed) && !/^\[instrumental\]$/i.test(displayed)) {
      return displayed.slice(0, 20000);
    }
    const prompt = (meta.prompt || '').trim() || null;
    if (!prompt) return null;
    if (/^\[instrumental\]$/i.test(prompt)) return null;
    const resolved = /^\$\d+$/.test(prompt) ? resolveSunoPromptToken(html, prompt) : prompt;
    if (!resolved || /^\$\d+$/.test(resolved)) return null;
    return resolved.slice(0, 20000);
  } catch {
    return null;
  }
}

/**
 * Fetch Suno embed page and extract lyrics for a given song URL.
 * Only attempted for suno.com URLs.
 */
async function fetchSunoLyrics(pageUrl) {
  try {
    const u = new URL(pageUrl);
    if (u.hostname !== 'suno.com' && u.hostname !== 'www.suno.com') return null;
    const parts = u.pathname.split('/').filter(Boolean);
    if (parts.length < 2 || parts[0] !== 'song') return null;
    const id = parts[1];
    if (!/^[0-9a-fA-F-]{36}$/.test(id)) return null;
    const res = await fetch(`https://suno.com/embed/${id}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    return extractSunoLyrics(html);
  } catch {
    return null;
  }
}

/**
 * Guess file extension from a URL.
 */
function guessExtension(url) {
  const path = url.split('?')[0];
  const ext = path.split('.').pop().toLowerCase();
  const valid = ['mp3', 'mp4', 'm4a', 'wav', 'ogg', 'flac', 'aac', 'opus', 'wma', 'webm'];
  return valid.includes(ext) ? ext : 'mp3';
}

/**
 * Decode HTML entities in a string.
 */
function decodeEntities(str) {
  if (!str) return null;
  return str
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

/**
 * Sanitise a string for use as a filename.
 */
function sanitiseFilename(str) {
  return str.replace(/[\/\\:*?"<>|]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
}

/**
 * Validate a URL is safe to fetch (HTTPS, public hostname).
 */
function validateUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return 'Invalid URL'; }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return 'Only HTTP/HTTPS URLs are supported';
  }

  const host = parsed.hostname.toLowerCase();

  // Block private/reserved IP ranges
  if (/^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|::1|fc|fd|fe80)/.test(host)) {
    return 'Private or reserved addresses are not allowed';
  }
  if (host === 'localhost' || host === '[::1]') {
    return 'Private or reserved addresses are not allowed';
  }

  return null;
}

const MAX_HTML_SIZE = 2 * 1024 * 1024; // 2 MB

/**
 * Fetch a page and extract audio metadata.
 */
async function extractAudioInfo(url) {
  const cached = getCached(url);
  if (cached) return cached;

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    redirect: 'follow',
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch page: HTTP ${response.status}`);
  }

  // Check content length before reading body
  const contentLength = parseInt(response.headers.get('content-length') || '0', 10);
  if (contentLength > MAX_HTML_SIZE) {
    throw new Error('Page too large to process');
  }

  const html = await response.text();
  if (html.length > MAX_HTML_SIZE) {
    throw new Error('Page too large to process');
  }

  // Find audio URL
  let audioUrl = null;
  let foundTag = null;
  for (const tag of META_TAGS) {
    audioUrl = extractMeta(html, tag);
    if (audioUrl) {
      foundTag = tag;
      break;
    }
  }

  if (!audioUrl) {
    return null;
  }

  // Find title
  let title = null;
  for (const tag of TITLE_TAGS) {
    title = extractMeta(html, tag);
    if (title) break;
  }
  if (!title) {
    title = extractTitle(html);
  }
  title = decodeEntities(title) || 'audio';

  // Get image if available
  const image = extractMeta(html, 'og:image');

  // Extract artist if available
  const artist = extractArtist(html);

  // Extract lyrics (Suno only - fetches embed page in parallel-ish)
  const lyrics = await fetchSunoLyrics(url);

  const ext = guessExtension(audioUrl);
  const filenameBase = artist
    ? `${sanitiseFilename(artist)} - ${sanitiseFilename(title)}`
    : sanitiseFilename(title);
  const filename = `${filenameBase}.${ext}`;

  const result = { audioUrl, title, artist, lyrics, filename, image, sourceTag: foundTag, pageUrl: url };
  setCache(url, result);
  return result;
}

/**
 * Handle API info requests.
 */
async function handleInfo(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!checkRateLimit(ip)) {
    return Response.json({ error: 'Too many requests. Please wait a moment and try again.' }, { status: 429 });
  }

  const url = new URL(request.url);
  const targetUrl = url.searchParams.get('url');

  if (!targetUrl) {
    return Response.json({ error: 'Missing ?url= parameter' }, { status: 400 });
  }

  // Auto-prepend https:// if no protocol given
  const normalizedUrl = /^https?:\/\//i.test(targetUrl) ? targetUrl : 'https://' + targetUrl;

  const urlError = validateUrl(normalizedUrl);
  if (urlError) {
    return Response.json({ error: urlError }, { status: 400 });
  }

  try {
    const info = await extractAudioInfo(normalizedUrl);
    if (!info) {
      return Response.json({ error: 'No og:audio or twitter:player:stream meta tag found on this page' }, { status: 404 });
    }
    return Response.json(info);
  } catch (err) {
    return Response.json({ error: err.message }, { status: 502 });
  }
}

/**
 * Serve the frontend HTML.
 */
function handleFrontend() {
  return new Response(FRONTEND_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

// --- Frontend HTML ---

const FRONTEND_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>og-audio-dl</title>
<meta property="og:title" content="og-audio-dl">
<meta property="og:description" content="Download audio from any webpage using Open Graph metadata. No scraping, no auth bypass - just reading the tags sites already publish.">
<meta property="og:type" content="website">
<meta property="og:url" content="https://og-audio-dl.paultendo.workers.dev">
<meta property="og:image" content="https://og-audio-dl.paultendo.workers.dev/og-image.png">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="og-audio-dl">
<meta name="twitter:description" content="Download audio from any webpage using Open Graph metadata. No scraping, no auth bypass - just reading the tags sites already publish.">
<meta name="twitter:image" content="https://og-audio-dl.paultendo.workers.dev/og-image.png">
<meta name="description" content="Download audio from any webpage using Open Graph metadata. No scraping, no auth bypass - just reading the tags sites already publish.">
<link rel="canonical" href="https://og-audio-dl.paultendo.workers.dev">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#0a0a0a">
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebApplication",
  "name": "og-audio-dl",
  "url": "https://og-audio-dl.paultendo.workers.dev",
  "description": "Download audio from any webpage using Open Graph metadata. No scraping, no auth bypass - just reading the tags sites already publish.",
  "applicationCategory": "UtilitiesApplication",
  "operatingSystem": "Any",
  "offers": {
    "@type": "Offer",
    "price": "0",
    "priceCurrency": "USD"
  },
  "author": {
    "@type": "Person",
    "name": "paultendo",
    "url": "https://buymeacoffee.com/paultendo"
  }
}
</script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=Syne:wght@400..800&display=swap" rel="stylesheet">
<script src="https://cdn.jsdelivr.net/npm/browser-id3-writer@4.4.0/dist/browser-id3-writer.min.js"></script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .skip-link {
    position: absolute;
    top: -100%;
    left: 1rem;
    background: #2563eb;
    color: #fff;
    padding: 0.5rem 1rem;
    border-radius: 0 0 8px 8px;
    font-size: 0.875rem;
    text-decoration: none;
    z-index: 100;
  }
  .skip-link:focus { top: 0; }

  body {
    font-family: 'Instrument Sans', -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    background: #0a0a0a;
    color: #e0e0e0;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 2rem 1rem;
  }

  .container {
    width: 100%;
    max-width: 540px;
  }

  h1, h2 {
    font-family: 'Syne', sans-serif;
  }

  h1 {
    font-size: 1.5rem;
    font-weight: 800;
    color: #fff;
    margin-bottom: 0.25rem;
    letter-spacing: -0.02em;
  }

  .subtitle {
    color: #888;
    font-size: 0.875rem;
    margin-bottom: 2rem;
    line-height: 1.5;
  }

  .input-group {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  input[type="url"] {
    flex: 1;
    padding: 0.75rem 1rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    color: #fff;
    font-size: 0.9375rem;
    outline: none;
    transition: border-color 0.2s;
  }

  input[type="url"]:focus {
    border-color: #555;
  }

  input[type="url"]::placeholder {
    color: #8a8a8a;
  }

  button {
    padding: 0.75rem 1.25rem;
    background: #fff;
    color: #000;
    border: none;
    border-radius: 8px;
    font-size: 0.9375rem;
    font-weight: 500;
    cursor: pointer;
    transition: opacity 0.2s;
    white-space: nowrap;
  }

  button:hover { opacity: 0.85; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Focus indicators - WCAG 2.4.7 / 2.4.11 */
  :focus-visible {
    outline: 2px solid #6ea8fe;
    outline-offset: 2px;
  }
  textarea:focus-visible, input:focus-visible {
    outline: none;
    border-color: #6ea8fe;
    box-shadow: 0 0 0 1px #6ea8fe;
  }
  .agree-row input[type="checkbox"]:focus-visible {
    outline: 2px solid #6ea8fe;
    outline-offset: 2px;
    box-shadow: none;
  }

  .result {
    display: none;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 12px;
    padding: 1.25rem;
    margin-top: 1rem;
    animation: fadeIn 0.3s ease;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .result.visible { display: block; }

  .result-header {
    display: flex;
    gap: 1rem;
    align-items: start;
    margin-bottom: 1rem;
  }

  .result-art {
    width: 80px;
    height: 80px;
    border-radius: 8px;
    object-fit: cover;
    background: #333;
    flex-shrink: 0;
  }

  .result-info { flex: 1; min-width: 0; }

  .result-title {
    font-family: 'Syne', sans-serif;
    font-weight: 700;
    color: #fff;
    font-size: 1rem;
    margin-bottom: 0.25rem;
    word-wrap: break-word;
    letter-spacing: -0.01em;
  }

  .result-meta {
    color: #888;
    font-size: 0.8125rem;
  }

  .result-audio {
    width: 100%;
    margin: 0.75rem 0;
    height: 40px;
    border-radius: 8px;
  }

  .download-btn {
    width: 100%;
    padding: 0.875rem;
    background: #2563eb;
    color: #fff;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    text-align: center;
    text-decoration: none;
    display: block;
  }

  .download-btn:hover { opacity: 0.85; }

  .lyrics-section {
    margin-top: 0.75rem;
    border-top: 1px solid #222;
    padding-top: 0.75rem;
  }

  .lyrics-section summary {
    cursor: pointer;
    font-size: 0.875rem;
    color: #888;
    user-select: none;
  }

  .lyrics-section summary:hover { color: #aaa; }

  .lyrics-text {
    margin-top: 0.75rem;
    font-family: inherit;
    font-size: 0.875rem;
    color: #ccc;
    white-space: pre-wrap;
    line-height: 1.6;
  }

  .error {
    color: #ef4444;
    font-size: 0.875rem;
    margin-top: 0.75rem;
    display: none;
  }

  .error.visible { display: block; }

  .loading {
    display: none;
    text-align: center;
    padding: 2rem 0;
    color: #888;
  }

  .loading.visible { display: block; }

  .spinner {
    display: inline-block;
    width: 20px;
    height: 20px;
    border: 2px solid #333;
    border-top-color: #888;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    margin-right: 0.5rem;
    vertical-align: middle;
  }

  @keyframes spin { to { transform: rotate(360deg); } }

  .promo-card {
    margin-top: 2rem;
    padding: 1.25rem;
    background: linear-gradient(135deg, #0c1018, #081122);
    border: 1px solid #1a2a3a;
    border-radius: 12px;
    text-align: center;
    transition: border-color 0.3s;
  }

  .promo-card:hover {
    border-color: #1ed760;
  }

  .promo-card a {
    text-decoration: none;
    color: inherit;
    display: block;
  }

  .promo-card .promo-title {
    font-family: 'Syne', sans-serif;
    font-weight: 700;
    font-size: 1.125rem;
    color: #fff;
    margin-bottom: 0.375rem;
    letter-spacing: -0.01em;
  }

  .promo-card .promo-title span {
    color: #1ed760;
  }

  .promo-card .promo-desc {
    color: #778;
    font-size: 0.8125rem;
    line-height: 1.5;
    margin-bottom: 0.75rem;
  }

  .promo-card .promo-cta {
    display: inline-block;
    padding: 0.5rem 1rem;
    background: #1ed760;
    color: #000;
    font-size: 0.8125rem;
    font-weight: 600;
    border-radius: 6px;
    transition: opacity 0.2s;
  }

  .promo-card .promo-cta:hover {
    opacity: 0.85;
  }

  .share-card {
    margin-top: 1.25rem;
    padding: 1.25rem;
    background: #1a1a1a;
    border: 1px solid #282828;
    border-radius: 12px;
    text-align: center;
  }

  .share-card p {
    color: #888;
    font-size: 0.8125rem;
    margin-bottom: 0.875rem;
  }

  .share-links {
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    flex-wrap: wrap;
  }

  .share-links a, .share-links button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.5rem 0.875rem;
    background: #252525;
    border: 1px solid #333;
    border-radius: 8px;
    color: #ccc;
    font-size: 0.8125rem;
    text-decoration: none;
    cursor: pointer;
    transition: background 0.2s, border-color 0.2s;
    font-family: inherit;
  }

  .share-links a:hover, .share-links button:hover {
    background: #303030;
    border-color: #444;
    color: #fff;
  }

  .share-links svg {
    width: 16px;
    height: 16px;
    fill: currentColor;
    flex-shrink: 0;
  }

  .share-links .copied {
    color: #4ade80;
    border-color: #4ade80;
  }

  .bmc {
    display: inline-block;
    margin-top: 1.5rem;
    padding: 0.625rem 1.25rem;
    background: #ffdd00;
    color: #000;
    font-size: 0.875rem;
    font-weight: 600;
    border-radius: 8px;
    text-decoration: none;
    transition: opacity 0.2s;
  }

  .bmc:hover { opacity: 0.85; }

  footer {
    margin-top: 3rem;
    text-align: center;
    color: #8a8a8a;
    font-size: 0.75rem;
    line-height: 1.8;
  }

  footer a {
    color: #888;
    text-decoration: none;
  }

  footer a:hover { color: #aaa; }

  .section {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #222;
  }

  .section h2 {
    font-size: 0.875rem;
    font-weight: 600;
    color: #aaa;
    margin-bottom: 0.5rem;
    letter-spacing: -0.01em;
  }

  .section p {
    color: #8a8a8a;
    font-size: 0.8125rem;
    line-height: 1.6;
    margin-bottom: 0.5rem;
  }

  .section a {
    color: #aaa;
    text-decoration: underline;
    text-decoration-color: #444;
    text-underline-offset: 2px;
  }

  .section a:hover {
    color: #ccc;
    text-decoration-color: #666;
  }

  .section code {
    background: #1a1a1a;
    padding: 0.15em 0.4em;
    border-radius: 4px;
    font-size: 0.8em;
    color: #999;
  }

  .terms-toggle {
    background: none;
    border: none;
    color: #8a8a8a;
    font-size: 0.8125rem;
    cursor: pointer;
    padding: 0.25rem 0;
    text-decoration: underline;
    text-decoration-color: #555;
    text-underline-offset: 2px;
  }

  .terms-toggle:hover { color: #bbb; }

  .terms-content {
    display: none;
    margin-top: 0.75rem;
  }

  .terms-content.visible { display: block; }

  .terms-content p {
    color: #929292;
    font-size: 0.75rem;
    line-height: 1.7;
    margin-bottom: 0.75rem;
  }

  .agree-row {
    display: flex;
    align-items: start;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .agree-row input[type="checkbox"] {
    appearance: none;
    -webkit-appearance: none;
    width: 24px;
    height: 24px;
    min-width: 24px;
    border: 1px solid #444;
    border-radius: 4px;
    background: #1a1a1a;
    cursor: pointer;
    margin-top: 0;
    position: relative;
    transition: background 0.15s, border-color 0.15s;
  }

  .agree-row input[type="checkbox"]:checked {
    background: #2563eb;
    border-color: #2563eb;
  }

  .agree-row input[type="checkbox"]:checked::after {
    content: '';
    position: absolute;
    left: 7px;
    top: 3px;
    width: 6px;
    height: 11px;
    border: solid #fff;
    border-width: 0 2px 2px 0;
    transform: rotate(45deg);
  }

  .agree-row label {
    color: #8a8a8a;
    font-size: 0.8125rem;
    line-height: 1.4;
    cursor: pointer;
    user-select: none;
  }

  .agree-row label a {
    color: #aaa;
    text-decoration: underline;
    text-decoration-color: #444;
    text-underline-offset: 2px;
  }

  .agree-row label a:hover {
    color: #ccc;
  }

  textarea {
    flex: 1;
    padding: 0.75rem 1rem;
    background: #1a1a1a;
    border: 1px solid #333;
    border-radius: 8px;
    color: #fff;
    font-size: 0.9375rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
    resize: vertical;
    min-height: 42px;
    max-height: 200px;
    line-height: 1.4;
  }

  textarea:focus { border-color: #555; }
  textarea::placeholder { color: #8a8a8a; }

  .batch-hint {
    color: #8a8a8a;
    font-size: 0.75rem;
    margin-top: -0.5rem;
    margin-bottom: 1rem;
  }

  .filename-row {
    display: flex;
    gap: 0.5rem;
    margin: 0.75rem 0;
  }

  .filename-input {
    flex: 1;
    padding: 0.5rem 0.75rem;
    background: #111;
    border: 1px solid #333;
    border-radius: 6px;
    color: #ccc;
    font-size: 0.8125rem;
    font-family: inherit;
    outline: none;
    transition: border-color 0.2s;
  }

  .filename-input:focus { border-color: #555; }

  .results-list {
    display: none;
    margin-top: 1rem;
  }

  .results-list.visible { display: block; }

  .results-list .result {
    display: block;
    margin-bottom: 0.75rem;
    animation: fadeIn 0.3s ease;
  }

  .batch-progress {
    display: none;
    text-align: center;
    padding: 1rem 0;
    color: #888;
    font-size: 0.875rem;
  }

  .batch-progress.visible { display: block; }

  .history-section {
    margin-top: 2rem;
    padding-top: 1.5rem;
    border-top: 1px solid #222;
    display: none;
  }

  .history-section.visible { display: block; }

  .history-section h2 {
    font-family: 'Syne', sans-serif;
    font-size: 0.875rem;
    font-weight: 600;
    color: #aaa;
    margin-bottom: 0.75rem;
    letter-spacing: -0.01em;
    display: flex;
    justify-content: space-between;
    align-items: center;
  }

  .history-clear {
    background: none;
    border: none;
    color: #8a8a8a;
    font-size: 0.75rem;
    cursor: pointer;
    padding: 0.25rem 0;
  }

  .history-clear:hover { color: #bbb; }

  .history-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.625rem;
    background: #1a1a1a;
    border: 1px solid #282828;
    border-radius: 8px;
    margin-bottom: 0.5rem;
    cursor: pointer;
    transition: border-color 0.2s;
  }

  .history-item:hover { border-color: #444; }

  .history-item img {
    width: 40px;
    height: 40px;
    border-radius: 6px;
    object-fit: cover;
    background: #333;
    flex-shrink: 0;
  }

  .history-item .history-info {
    flex: 1;
    min-width: 0;
  }

  .history-item .history-title {
    color: #ddd;
    font-size: 0.8125rem;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .history-item .history-url {
    color: #929292;
    font-size: 0.6875rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 480px) {
    .input-group {
      flex-direction: column;
    }

    .input-group button {
      width: 100%;
    }

    .result-header {
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .share-links {
      flex-direction: column;
      align-items: stretch;
    }

    .share-links a, .share-links button {
      justify-content: center;
    }
  }
</style>
</head>
<body>
<a href="#main-content" class="skip-link">Skip to content</a>
<main id="main-content" class="container" role="main">
  <h1>og-audio-dl</h1>
  <p class="subtitle">Download audio from any webpage that uses Open Graph metadata. Suno downloads include artist, lyrics and cover art embedded in the file.</p>

  <div class="agree-row">
    <input type="checkbox" id="agree" aria-describedby="agree-desc">
    <label for="agree" id="agree-desc">I have read and agree to the <a href="#terms-section" onclick="event.preventDefault(); document.getElementById('terms').classList.add('visible'); document.getElementById('terms-section').scrollIntoView({behavior:'smooth'});">terms of use</a> and accept full responsibility for my use of this service.</label>
  </div>

  <div class="input-group" role="search">
    <label for="url" class="sr-only">Paste one or more song page URLs</label>
    <textarea id="url" placeholder="Paste a song page URL..." autocomplete="off" spellcheck="false" disabled rows="1" aria-describedby="batch-hint"></textarea>
    <button id="go" onclick="lookup()" disabled aria-label="Fetch audio metadata">Fetch</button>
  </div>
  <p class="batch-hint" id="batch-hint">Paste multiple URLs (one per line) to batch download.</p>

  <div class="error" id="error" role="alert" aria-live="assertive"></div>

  <div class="loading" id="loading" role="status" aria-live="polite">
    <span class="spinner" aria-hidden="true"></span> Fetching page metadata...
  </div>

  <div class="batch-progress" id="batch-progress" role="status" aria-live="polite"></div>

  <div class="results-list" id="results-list" aria-live="polite" aria-label="Batch results"></div>

  <div class="result" id="result" aria-live="polite">
    <div class="result-header">
      <img class="result-art" id="result-art" src="" alt="Album artwork" style="display:none">
      <div class="result-info">
        <div class="result-title" id="result-title"></div>
        <div class="result-meta" id="result-meta"></div>
        <div class="result-meta" id="result-suno-badge" style="display:none;color:#6ea8fe;font-size:0.75rem;margin-top:2px">Enhanced for Suno - artist, lyrics and cover art embedded</div>
      </div>
    </div>
    <audio class="result-audio" id="result-audio" controls preload="none" aria-label="Audio preview"></audio>
    <div class="filename-row">
      <label for="result-filename" class="sr-only">Filename</label>
      <input class="filename-input" type="text" id="result-filename" spellcheck="false" aria-label="Edit filename before download">
    </div>
    <button class="download-btn" id="result-download" onclick="downloadCurrent()">Download</button>
    <details class="lyrics-section" id="result-lyrics-section" style="display:none">
      <summary>Lyrics</summary>
      <pre class="lyrics-text" id="result-lyrics"></pre>
    </details>
  </div>

  <nav class="history-section" id="history-section" aria-label="Recent lookups">
    <h2>Recent <button class="history-clear" onclick="clearHistory()" aria-label="Clear history">Clear</button></h2>
    <div id="history-list" role="list"></div>
  </nav>

  <div class="section">
    <h2>How it works</h2>
    <p>
      The <a href="https://ogp.me" target="_blank">Open Graph protocol</a> defines
      standard meta tags that websites use to describe their content to search engines
      and social media. The <code>og:audio</code> tag specifies a public URL to an
      audio file associated with the page.
    </p>
    <p>
      This tool reads that publicly available metadata and gives you a direct link to
      the audio file the website has already chosen to make available.
      No audio data ever passes through our server - your browser downloads
      directly from the original source.
    </p>
  </div>

  <div class="section">
    <h2>Privacy and safety</h2>
    <p>
      <strong style="color:#888;">No audio touches this server.</strong> Downloads go directly from
      your browser to the original source. You can verify this yourself in your browser's
      Network tab.
    </p>
    <p>
      <strong style="color:#888;">No accounts, no cookies, no tracking.</strong> This site collects
      nothing. Your recent lookup history is stored in your browser's local storage and never
      leaves your device.
    </p>
    <p>
      <strong style="color:#888;">Fully open source.</strong> The entire codebase is public on
      <a href="https://github.com/paultendo/og-audio-dl" target="_blank" rel="noopener">GitHub</a>.
      What you see is what gets deployed.
    </p>
  </div>

  <div class="section" id="terms-section">
    <h2>Terms of use</h2>
    <button class="terms-toggle" onclick="document.getElementById('terms').classList.toggle('visible')">Read full terms</button>
    <div class="terms-content" id="terms">
      <p>
        This service ("og-audio-dl") is provided as-is, without warranty of any kind,
        express or implied. By using this service, you acknowledge and agree to the following:
      </p>
      <p>
        <strong style="color:#888;">Your responsibility.</strong> You are solely responsible for
        your use of this service and for ensuring that your use complies with all applicable laws,
        regulations, and third-party terms of service. You represent and warrant that you have the
        legal right to access and download any content you retrieve using this service, including
        but not limited to content you have created, content you are licensed to use, or content
        that is otherwise lawfully available to you.
      </p>
      <p>
        <strong style="color:#888;">No endorsement or liability.</strong> This service, its developer
        ("paultendo"), and its hosting infrastructure do not endorse, encourage, or facilitate the
        infringement of any copyright, trademark, or other intellectual property right. Neither the
        service, its developer, nor its hosting provider shall be liable for any direct, indirect,
        incidental, special, consequential, or punitive damages arising out of or relating to your
        use of this service, including but not limited to any claims of intellectual property
        infringement, breach of contract, or violation of any third-party terms of service.
      </p>
      <p>
        <strong style="color:#888;">How it works.</strong> This service reads publicly available
        Open Graph metadata (<code>og:audio</code>, <code>twitter:player:stream</code>, and related
        tags) that websites voluntarily publish in their HTML for consumption by search engines,
        social media platforms, and other automated systems. No audio files are downloaded, stored,
        cached, or proxied by this service - all audio downloads occur directly between your
        browser and the original hosting server. This service does not circumvent any technical
        protection measures, authentication systems, or access controls.
      </p>
      <p>
        <strong style="color:#888;">No guarantee of availability.</strong> This service may be
        modified, suspended, or discontinued at any time without notice. The developer assumes no
        obligation to maintain, update, or support this service.
      </p>
      <p>
        <strong style="color:#888;">Indemnification.</strong> You agree to indemnify and hold harmless
        the developer and any associated parties from and against any claims, damages, losses, or
        expenses (including reasonable legal fees) arising out of or relating to your use of this
        service.
      </p>
    </div>
  </div>

  <div class="promo-card">
    <a href="https://oncor.io" target="_blank" rel="noopener">
      <div class="promo-title">Sell your music on <span>Oncor</span></div>
      <p class="promo-desc">
        A new storefront for independent artists and labels. Human, AI-assisted, or
        AI-generated - if you hold the rights and attribute honestly, you belong here.
      </p>
      <span class="promo-cta">Join the waitlist</span>
    </a>
  </div>

  <div class="share-card" aria-label="Share this tool">
    <p>Found this useful? Share it.</p>
    <div class="share-links">
      <a href="https://x.com/intent/tweet?text=og-audio-dl%20-%20download%20audio%20from%20any%20page%20using%20Open%20Graph%20metadata&url=https%3A%2F%2Fog-audio-dl.paultendo.workers.dev" target="_blank" rel="noopener" aria-label="Share on X (Twitter)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        X
      </a>
      <a href="https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fog-audio-dl.paultendo.workers.dev" target="_blank" rel="noopener" aria-label="Share on Facebook">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/></svg>
        Facebook
      </a>
      <a href="https://reddit.com/submit?url=https%3A%2F%2Fog-audio-dl.paultendo.workers.dev&title=og-audio-dl%20-%20download%20audio%20from%20any%20page%20using%20Open%20Graph%20metadata" target="_blank" rel="noopener" aria-label="Share on Reddit">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.52c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 0-.463.327.327 0 0 0-.462 0c-.545.533-1.684.73-2.512.73-.828 0-1.953-.21-2.498-.73a.327.327 0 0 0-.219-.094z"/></svg>
        Reddit
      </a>
      <button id="copy-link" onclick="copyLink(this)" aria-label="Copy link to clipboard">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z"/></svg>
        <span>Copy link</span>
      </button>
    </div>
  </div>

  <footer role="contentinfo">
    <a class="bmc" href="https://buymeacoffee.com/paultendo" target="_blank" rel="noopener">Buy me a coffee</a>
    <br><br>
    Built on the <a href="https://ogp.me" target="_blank" rel="noopener">Open Graph protocol</a>
    <br>
    Built by <a href="https://buymeacoffee.com/paultendo" target="_blank" rel="noopener">paultendo</a>
    <br>
    <a href="https://github.com/paultendo/og-audio-dl" target="_blank" rel="noopener">View source on GitHub</a>
  </footer>
</main>

<script>
const urlInput = document.getElementById('url');
const goBtn = document.getElementById('go');
const errorEl = document.getElementById('error');
const loadingEl = document.getElementById('loading');
const resultEl = document.getElementById('result');
const resultsListEl = document.getElementById('results-list');
const batchProgressEl = document.getElementById('batch-progress');
const agreeBox = document.getElementById('agree');

agreeBox.addEventListener('change', () => {
  urlInput.disabled = !agreeBox.checked;
  goBtn.disabled = !agreeBox.checked;
  if (agreeBox.checked) urlInput.focus();
});

urlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); lookup(); }
});

// Auto-resize textarea
urlInput.addEventListener('input', () => {
  urlInput.style.height = 'auto';
  urlInput.style.height = Math.min(urlInput.scrollHeight, 200) + 'px';
});

// Auto-paste URL from clipboard on focus
urlInput.addEventListener('focus', async () => {
  if (urlInput.value.trim()) return;
  try {
    const text = await navigator.clipboard.readText();
    const t = text ? text.trim() : '';
    if (t && (t.startsWith('http') || t.includes('.'))) {
      urlInput.value = t;
      urlInput.select();
    }
  } catch {}
});

function normalizeUrl(s) {
  s = s.trim();
  if (s && !/^https?:\\/\\//i.test(s)) s = 'https://' + s;
  return s;
}

function parseUrls(text) {
  return text.split('\\n').map(s => normalizeUrl(s)).filter(s => s && s.startsWith('http'));
}

async function fetchOne(url) {
  const res = await fetch('/api/info?url=' + encodeURIComponent(url));
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

let currentAudioUrl = '';
let currentData = null;

function showSingleResult(data, url) {
  document.getElementById('result-title').textContent = data.title;
  document.getElementById('result-meta').textContent = 'Found via ' + data.sourceTag;

  const art = document.getElementById('result-art');
  if (data.image) { art.src = data.image; art.style.display = 'block'; }
  else { art.style.display = 'none'; }

  document.getElementById('result-audio').src = data.audioUrl;

  const fnInput = document.getElementById('result-filename');
  fnInput.value = data.filename;

  currentAudioUrl = data.audioUrl;
  currentData = data;

  const sunoBadge = document.getElementById('result-suno-badge');
  sunoBadge.style.display = data.lyrics ? '' : 'none';

  const lyricsSection = document.getElementById('result-lyrics-section');
  if (data.lyrics) {
    document.getElementById('result-lyrics').textContent = data.lyrics;
    lyricsSection.style.display = '';
  } else {
    lyricsSection.style.display = 'none';
  }

  resultEl.classList.add('visible');
  saveHistory(data, url);
}

async function writeId3Tags(arrayBuffer, meta) {
  try {
    if (typeof ID3Writer === 'undefined') return null;
    const writer = new ID3Writer(arrayBuffer);
    if (meta.title) writer.setFrame('TIT2', meta.title);
    if (meta.artist) writer.setFrame('TPE1', [meta.artist]);
    if (meta.lyrics) writer.setFrame('USLT', { description: '', lyrics: meta.lyrics, language: 'eng' });
    if (meta.image) {
      try {
        const imgRes = await fetch(meta.image);
        if (imgRes.ok) {
          const imgBuf = await imgRes.arrayBuffer();
          const mime = imgRes.headers.get('content-type') || 'image/jpeg';
          writer.setFrame('APIC', { type: 3, data: imgBuf, description: 'Cover', useUnicodeEncoding: false, mimeType: mime });
        }
      } catch {}
    }
    writer.addTag();
    return writer.arrayBuffer;
  } catch {
    return null;
  }
}

async function clientDownload(audioUrl, filename, btn, meta) {
  const origText = btn.textContent;
  btn.textContent = 'Downloading...';
  btn.disabled = true;
  try {
    const res = await fetch(audioUrl);
    if (!res.ok) throw new Error('Download failed');
    let buf = await res.arrayBuffer();
    // Write ID3 tags for MP3s if metadata available
    if (meta && filename.endsWith('.mp3')) {
      const tagged = await writeId3Tags(buf, meta);
      if (tagged) buf = tagged;
    }
    const blob = new Blob([buf], { type: 'audio/mpeg' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
    btn.textContent = origText;
  } catch (err) {
    // CORS or network error - fall back to direct link (browser handles download)
    const a = document.createElement('a');
    a.href = audioUrl;
    a.download = filename;
    a.target = '_blank';
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    btn.textContent = origText;
  } finally {
    btn.disabled = false;
  }
}

function downloadCurrent() {
  const fn = document.getElementById('result-filename').value;
  const btn = document.getElementById('result-download');
  clientDownload(currentAudioUrl, fn, btn, currentData);
}

function buildResultCard(data, url) {
  const card = document.createElement('div');
  card.className = 'result';
  card.style.display = 'block';
  card.style.animation = 'fadeIn 0.3s ease';

  const imgHtml = data.image
    ? '<img class="result-art" src="' + data.image + '" alt="' + escHtml(data.title) + ' artwork" style="width:80px;height:80px;border-radius:8px;object-fit:cover;background:#333;flex-shrink:0">'
    : '';

  card.innerHTML =
    '<div class="result-header">' +
      imgHtml +
      '<div class="result-info">' +
        '<div class="result-title">' + escHtml(data.title) + '</div>' +
        '<div class="result-meta">Found via ' + escHtml(data.sourceTag) + '</div>' +
      '</div>' +
    '</div>' +
    '<audio class="result-audio" controls preload="none" src="' + escHtml(data.audioUrl) + '" aria-label="Preview ' + escHtml(data.title) + '"></audio>' +
    '<div class="filename-row">' +
      '<input class="filename-input" type="text" value="' + escHtml(data.filename) + '" spellcheck="false" aria-label="Filename for ' + escHtml(data.title) + '">' +
    '</div>' +
    '<button class="download-btn" aria-label="Download ' + escHtml(data.title) + '">Download</button>';

  const fnInput = card.querySelector('.filename-input');
  const dlBtn = card.querySelector('.download-btn');
  dlBtn.onclick = () => clientDownload(data.audioUrl, fnInput.value, dlBtn, data);

  saveHistory(data, url);
  return card;
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function lookup() {
  const raw = urlInput.value.trim();
  if (!raw) return;

  const urls = parseUrls(raw);
  if (urls.length === 0) return;

  errorEl.classList.remove('visible');
  resultEl.classList.remove('visible');
  resultsListEl.classList.remove('visible');
  resultsListEl.innerHTML = '';
  batchProgressEl.classList.remove('visible');
  goBtn.disabled = true;

  if (urls.length === 1) {
    loadingEl.classList.add('visible');
    try {
      const data = await fetchOne(urls[0]);
      loadingEl.classList.remove('visible');
      showSingleResult(data, urls[0]);
    } catch (err) {
      loadingEl.classList.remove('visible');
      errorEl.textContent = err.message;
      errorEl.classList.add('visible');
    } finally {
      goBtn.disabled = false;
    }
  } else {
    // Batch mode
    batchProgressEl.classList.add('visible');
    resultsListEl.classList.add('visible');
    let done = 0;
    const total = urls.length;
    batchProgressEl.textContent = 'Fetching 0 / ' + total + '...';

    for (const url of urls) {
      try {
        const data = await fetchOne(url);
        resultsListEl.appendChild(buildResultCard(data, url));
      } catch (err) {
        const errCard = document.createElement('div');
        errCard.className = 'result';
        errCard.style.display = 'block';
        errCard.innerHTML = '<div style="color:#ef4444;font-size:0.875rem"><strong>Failed:</strong> ' + escHtml(url) + '<br>' + escHtml(err.message) + '</div>';
        resultsListEl.appendChild(errCard);
      }
      done++;
      batchProgressEl.textContent = 'Fetching ' + done + ' / ' + total + '...';
    }
    batchProgressEl.textContent = 'Done - ' + done + ' URLs processed.';
    goBtn.disabled = false;
  }
}

// --- History ---
const HISTORY_KEY = 'og-audio-dl-history';
const MAX_HISTORY = 10;

function getHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY)) || []; }
  catch { return []; }
}

function saveHistory(data, url) {
  const history = getHistory().filter(h => h.pageUrl !== url);
  history.unshift({ title: data.title, image: data.image || '', pageUrl: url, time: Date.now() });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  renderHistory();
}

function clearHistory() {
  localStorage.removeItem(HISTORY_KEY);
  renderHistory();
}

function renderHistory() {
  const history = getHistory();
  const section = document.getElementById('history-section');
  const list = document.getElementById('history-list');

  if (history.length === 0) {
    section.classList.remove('visible');
    return;
  }

  section.classList.add('visible');
  list.innerHTML = history.map(h =>
    '<div class="history-item" role="listitem" tabindex="0" aria-label="' + escHtml(h.title) + '" onclick="urlInput.value=\\'' + escHtml(h.pageUrl).replace(/'/g, "\\\\'") + '\\';lookup()" onkeydown="if(event.key===\\'Enter\\'){urlInput.value=\\'' + escHtml(h.pageUrl).replace(/'/g, "\\\\'") + '\\';lookup()}">' +
      (h.image ? '<img src="' + escHtml(h.image) + '" alt="' + escHtml(h.title) + ' artwork">' : '') +
      '<div class="history-info">' +
        '<div class="history-title">' + escHtml(h.title) + '</div>' +
        '<div class="history-url">' + escHtml(h.pageUrl) + '</div>' +
      '</div>' +
    '</div>'
  ).join('');
}

renderHistory();

function copyLink(btn) {
  navigator.clipboard.writeText('https://og-audio-dl.paultendo.workers.dev').then(() => {
    btn.classList.add('copied');
    btn.querySelector('span').textContent = 'Copied!';
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('span').textContent = 'Copy link';
    }, 2000);
  });
}
</script>
</body>
</html>`;

// --- Router ---

export default {
  async fetch(request) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    if (url.pathname === '/api/info') {
      return handleInfo(request);
    }

    // Everything else serves the frontend
    return handleFrontend();
  },
};
