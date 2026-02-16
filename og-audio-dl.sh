#!/usr/bin/env bash
#
# og-audio-dl — Download audio from any webpage using Open Graph metadata
#
# The Open Graph protocol (ogp.me) defines standard meta tags that websites
# use to describe their content to social media crawlers, search engines, and
# other machines. The og:audio tag specifies a URL to an audio file associated
# with the page. This script simply reads that public metadata and downloads
# the linked audio file.
#
# Usage:
#   ./og-audio-dl.sh <url> [output-directory]
#   ./og-audio-dl.sh --batch <file-with-urls> [output-directory]
#
# Examples:
#   ./og-audio-dl.sh https://example.com/some-song-page
#   ./og-audio-dl.sh https://example.com/some-song-page ./my-music
#   ./og-audio-dl.sh --batch urls.txt ./my-music
#
# Supported meta tags (checked in order):
#   1. og:audio          — Open Graph audio URL
#   2. og:audio:url      — Open Graph audio URL (alternate)
#   3. og:audio:secure_url — Open Graph audio URL (HTTPS)
#   4. twitter:player:stream — Twitter card audio stream
#
# The filename is derived from og:title (or <title>) and the audio file
# extension. If no title is found, the URL's hostname and path are used.

set -euo pipefail

VERSION="1.0.0"

# --- Helpers ---

usage() {
    echo "og-audio-dl v${VERSION} — Download audio from any webpage via Open Graph metadata"
    echo ""
    echo "Usage:"
    echo "  $0 <url> [output-directory]"
    echo "  $0 --batch <file-with-urls> [output-directory]"
    echo ""
    echo "Options:"
    echo "  --batch <file>   Read URLs from a file (one per line)"
    echo "  --help           Show this help message"
    echo "  --version        Show version"
    echo ""
    echo "Examples:"
    echo "  $0 https://example.com/some-song-page"
    echo "  $0 https://example.com/some-song-page ./my-music"
    echo "  $0 --batch urls.txt ./my-music"
}

extract_meta() {
    local page="$1"
    local property="$2"
    # Handle both property="og:X" and name="twitter:X" attributes
    echo "$page" | grep -oiE "<meta[^>]+(property|name)=\"${property}\"[^>]+>" | head -1 | grep -oiE 'content="[^"]*"' | head -1 | sed 's/content="//;s/"$//'
}

# Guess file extension from a URL
guess_extension() {
    local url="$1"
    # Strip query string, then get extension
    local path="${url%%\?*}"
    local ext="${path##*.}"
    # Validate it looks like an audio extension
    case "$ext" in
        mp3|mp4|m4a|wav|ogg|flac|aac|opus|wma|webm) echo "$ext" ;;
        *) echo "mp3" ;; # sensible default
    esac
}

# Make a string safe for use as a filename
sanitise_filename() {
    echo "$1" | sed 's/[\/\\:*?"<>|]/_/g' | sed 's/^[. ]*//' | sed 's/[. ]*$//'
}

download_one() {
    local url="$1"
    local output_dir="$2"

    # Validate URL format
    if [[ ! "$url" =~ ^https?:// ]]; then
        echo "  Skipping (not a valid URL): $url"
        return 1
    fi

    echo "Fetching: $url"

    # Fetch the page
    local page
    page=$(curl -s -L "$url" \
        -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' \
        --max-time 30)

    # Try each supported meta tag in order
    local audio_url=""
    local tags=("og:audio" "og:audio:url" "og:audio:secure_url" "twitter:player:stream")
    for tag in "${tags[@]}"; do
        audio_url=$(extract_meta "$page" "$tag")
        if [ -n "$audio_url" ]; then
            break
        fi
    done

    if [ -z "$audio_url" ]; then
        echo "  No og:audio or twitter:player:stream found on this page."
        return 1
    fi

    # Get the page title for the filename
    local title=""
    title=$(extract_meta "$page" "og:title")
    if [ -z "$title" ]; then
        # Fallback: try <title> tag
        title=$(echo "$page" | grep -oiE '<title[^>]*>[^<]+</title>' | head -1 | sed 's/<[^>]*>//g')
    fi

    # Clean up common suffixes that sites append to titles
    # e.g. " | Udio", " - SoundCloud", " on Spotify"
    title=$(echo "$title" | sed -E 's/ [|·–—-] [^|·–—-]+$//')

    if [ -z "$title" ]; then
        # Last resort: use hostname + path
        title=$(echo "$url" | sed -E 's|https?://||;s|/+$||;s|[/?#].*||')
    fi

    local ext
    ext=$(guess_extension "$audio_url")
    local filename
    filename=$(sanitise_filename "$title")
    local output_file="${output_dir}/${filename}.${ext}"

    # Avoid overwriting
    if [ -f "$output_file" ]; then
        local i=1
        while [ -f "${output_dir}/${filename} (${i}).${ext}" ]; do
            i=$((i + 1))
        done
        output_file="${output_dir}/${filename} (${i}).${ext}"
    fi

    echo "  Title: $title"
    echo "  Audio: $audio_url"
    echo "  Saving: $output_file"

    curl -s -L -o "$output_file" "$audio_url" --max-time 120

    # Verify
    local file_size
    file_size=$(wc -c < "$output_file" | tr -d ' ')
    if [ "$file_size" -lt 1000 ]; then
        echo "  Warning: File is very small (${file_size} bytes) — may not be valid."
        return 1
    fi

    echo "  Done (${file_size} bytes)"
    return 0
}

# --- Main ---

if [ $# -lt 1 ]; then
    usage
    exit 1
fi

case "$1" in
    --help|-h)
        usage
        exit 0
        ;;
    --version|-v)
        echo "og-audio-dl v${VERSION}"
        exit 0
        ;;
    --batch)
        if [ $# -lt 2 ]; then
            echo "Error: --batch requires a file argument"
            exit 1
        fi
        URL_FILE="$2"
        OUTPUT_DIR="${3:-.}"
        mkdir -p "$OUTPUT_DIR"

        if [ ! -f "$URL_FILE" ]; then
            echo "Error: File not found: $URL_FILE"
            exit 1
        fi

        TOTAL=0
        OK=0
        FAIL=0

        while IFS= read -r line || [ -n "$line" ]; do
            # Skip blank lines and comments
            line=$(echo "$line" | sed 's/#.*$//' | xargs)
            [ -z "$line" ] && continue

            TOTAL=$((TOTAL + 1))
            echo ""
            echo "[$TOTAL] $line"
            if download_one "$line" "$OUTPUT_DIR"; then
                OK=$((OK + 1))
            else
                FAIL=$((FAIL + 1))
            fi
        done < "$URL_FILE"

        echo ""
        echo "Batch complete: $OK downloaded, $FAIL failed, $TOTAL total"
        ;;
    *)
        URL="$1"
        OUTPUT_DIR="${2:-.}"
        mkdir -p "$OUTPUT_DIR"
        echo ""
        download_one "$URL" "$OUTPUT_DIR"
        ;;
esac
