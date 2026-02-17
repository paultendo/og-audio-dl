# og-audio-dl

**Download audio from any webpage using Open Graph metadata.**

Websites publish `og:audio` meta tags to tell search engines and social media platforms where their audio files live. This tool reads those publicly available tags and gives you a direct link to the audio.

No scraping. No authentication bypass. No DRM circumvention. No audio ever touches our server. Just reading the metadata that sites already serve to every visitor.

## **[Use it now at og-audio-dl.paultendo.workers.dev](https://og-audio-dl.paultendo.workers.dev)**

---

## How it works

The [Open Graph protocol](https://ogp.me) defines standard HTML meta tags that websites use to describe their content. When a page includes an audio file, it can declare it like this:

```html
<meta property="og:audio" content="https://cdn.example.com/track.mp3">
```

This tool fetches the page, reads that tag (or `twitter:player:stream` as a fallback), and returns the audio URL. That's it.

## Supported tags

Checked in order of priority:

| Tag | Protocol |
|---|---|
| `og:audio` | Open Graph |
| `og:audio:url` | Open Graph |
| `og:audio:secure_url` | Open Graph |
| `twitter:player:stream` | Twitter Cards |

## Web app

The web app runs as a [Cloudflare Worker](https://workers.cloudflare.com/) - no server to maintain, globally distributed, free tier.

Features:

- Single or batch URL lookup (one per line)
- Editable filename before download
- Audio preview player
- Recent history (stored locally in your browser)
- Installable as a PWA (Add to Home Screen)
- WCAG 2.2 AA accessible
- Rate limited (15 requests/min per IP)

### API

**Get audio info:**
```
GET /api/info?url=https://example.com/some-song-page
```

Returns JSON:
```json
{
  "audioUrl": "https://cdn.example.com/track.mp3",
  "title": "Artist - Track Name",
  "filename": "Artist - Track Name.mp3",
  "image": "https://cdn.example.com/artwork.jpg",
  "sourceTag": "og:audio",
  "pageUrl": "https://example.com/some-song-page"
}
```

Downloads happen client-side - your browser fetches the audio directly from the source. No audio data ever passes through the server.

## CLI

There's also a standalone bash script that does the same thing from your terminal.

```bash
# Single URL
./og-audio-dl.sh https://example.com/some-song-page

# Save to a specific directory
./og-audio-dl.sh https://example.com/some-song-page ./my-music

# Batch mode - one URL per line
./og-audio-dl.sh --batch urls.txt ./my-music
```

Requirements: `curl` and `grep` (both pre-installed on macOS and most Linux distros).

## Deploy your own

```bash
# Clone the repo
git clone https://github.com/paultendo/og-audio-dl.git
cd og-audio-dl

# Install dependencies
npm install

# Set your Cloudflare account ID in wrangler.toml
# Then deploy
CLOUDFLARE_API_TOKEN=your_token npx wrangler deploy
```

## Disclaimer

This tool reads publicly available Open Graph metadata that websites voluntarily publish in their HTML. No audio files are downloaded, stored, cached, or proxied by the server - all audio downloads occur directly between your browser and the original source. It does not circumvent any technical protection measures, authentication systems, or access controls. Users are solely responsible for ensuring their use complies with applicable laws and third-party terms of service.

See the full [terms of use](https://og-audio-dl.paultendo.workers.dev) on the live site.

## Licence

[MIT](LICENSE) - do what you want, just keep the copyright notice.

If you build something with this, I'd love to hear about it - drop me a message on [Buy Me a Coffee](https://buymeacoffee.com/paultendo) or open an [issue](https://github.com/paultendo/og-audio-dl/issues).

Made by [paultendo](https://buymeacoffee.com/paultendo).
