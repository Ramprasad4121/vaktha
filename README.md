# Vaktha — talk to OpenCode instead of typing

Press `Ctrl+R` in the OpenCode TUI, speak, and the text lands in your prompt.
Transcription runs on your machine (local Whisper) — audio never leaves it.
Works on macOS, Linux, and Windows.

## Setup

1. Open [`PROMPT.md`](PROMPT.md), copy the whole prompt.
2. Paste it into a new OpenCode chat, hit enter. The agent does everything.
3. When it's done: restart OpenCode, press `Ctrl+R`, speak.
   Allow **Microphone** access if macOS asks (System Settings → Privacy & Security).

That's it.

## What you get

- `Ctrl+R` voice agent in the TUI: press once and just talk — it listens,
  sends, and speaks replies back, hands-free until you press `Ctrl+R`/Esc.
  Mute speech: `VAKTHA_VOICE_REPLIES=0`
- `vaktha` MCP tools for agent-driven dictation (`vaktha_listen`, `vaktha_transcribe`, `vaktha_status`, `vaktha_speak`)
- `vaktha` CLI: `status`, `listen`, `transcribe`, `speak`, `serve`
- `vaktha voice` — Codex-style voice agent: SPACE talk/send, interrupts,
  spoken replies, one persistent session (spawns its own brain tab server).
  Try: `node dist/cli.js voice` (or `--text "hi"` for a mic-free test)
