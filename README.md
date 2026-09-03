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

- `Ctrl+R` push-to-talk in the TUI (`Ctrl+R` stop, `Enter` send, `Esc` cancel)
- `vaktha` MCP tools for agent-driven dictation (`vaktha_listen`, `vaktha_transcribe`, `vaktha_status`, `vaktha_speak`)
- `vaktha` CLI: `status`, `listen`, `transcribe`, `speak`, `serve`
