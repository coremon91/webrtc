#!/usr/bin/env bash
# Download a YouTube news video for Shin cut-editing.
# Requires either Chrome login cookies or a Netscape cookies.txt.
set -euo pipefail
URL="${1:-https://www.youtube.com/watch?v=gjAKR_lH3Ic}"
OUT_DIR="${2:-samples/youtube}"
mkdir -p "$OUT_DIR"

ARGS=(
  --js-runtimes node
  -f "bv*[height<=720][ext=mp4]+ba[ext=m4a]/b[height<=720]/b"
  --merge-output-format mp4
  -o "${OUT_DIR}/%(id)s.%(ext)s"
  --write-info-json
  --no-playlist
)

if [[ -n "${YOUTUBE_COOKIES_TXT:-}" ]]; then
  COOKIE_FILE="$(mktemp)"
  printf '%s\n' "$YOUTUBE_COOKIES_TXT" > "$COOKIE_FILE"
  ARGS+=(--cookies "$COOKIE_FILE")
elif [[ -f "${YOUTUBE_COOKIES_FILE:-}" ]]; then
  ARGS+=(--cookies "$YOUTUBE_COOKIES_FILE")
elif [[ -f cookies.txt ]]; then
  ARGS+=(--cookies cookies.txt)
else
  ARGS+=(--cookies-from-browser chrome)
fi

yt-dlp "${ARGS[@]}" "$URL"
ls -lah "$OUT_DIR"
