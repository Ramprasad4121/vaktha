#!/usr/bin/env bash
# Vaktha setup helper (macOS-first, best effort on Linux).
set -euo pipefail

echo "==> vaktha setup"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "==> installing ffmpeg..."
  if command -v brew >/dev/null 2>&1; then
    brew install ffmpeg
  elif command -v apt-get >/dev/null 2>&1; then
    sudo apt-get update && sudo apt-get install -y ffmpeg
  else
    echo "ERROR: install ffmpeg manually (https://ffmpeg.org/download.html)" >&2
    exit 1
  fi
else
  echo "==> ffmpeg ok ($(command -v ffmpeg))"
fi

if [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "==> OPENAI_API_KEY is set — OpenAI backend ready, no local model needed."
else
  echo "==> no OPENAI_API_KEY — installing local whisper (mlx-whisper on Apple Silicon)..."
  if [ "$(uname)" = "Darwin" ] && [ "$(uname -m)" = "arm64" ]; then
    pip3 install -q mlx-whisper || python3 -m pip install -q mlx-whisper
  else
    pip3 install -q openai-whisper || python3 -m pip install -q openai-whisper
  fi
fi

echo "==> building vaktha..."
npm install --no-audit --no-fund
npm run build

echo ""
echo "vaktha ready. Next:"
echo "  1. node dist/index.js smoke-test via: npm test"
echo "  2. copy the mcp.vaktha block from opencode.json.example into ~/.config/opencode/opencode.json"
echo "     (fix the absolute path to dist/index.js)"
echo "  3. in opencode: 'check vaktha_status and tell me if my mic is ready'"
echo "  4. grant Microphone permission to your terminal (macOS Privacy & Security) if recording fails"
