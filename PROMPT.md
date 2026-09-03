# Vaktha setup prompt — paste everything below into a new OpenCode chat

> Copy from the next line to the end of the file. The agent does the full
> install and wiring. You only restart OpenCode at the end.

---

Set up Vaktha (https://github.com/Ramprasad4121/vaktha) on this machine so I
can dictate into OpenCode with Ctrl+R. Do every step, verify as you go, and
report what you did plus anything I must do manually.

Safety rules:
- Never write API keys or secrets into any file. Use env vars.
- Never overwrite my existing configs — always read first, then merge.
- Do not run a real microphone recording test unless I explicitly ask.
- If a step needs my input (e.g. which mic, install permission), stop and ask.

Steps:

1. Clone or update repos:
   - `git clone https://github.com/Ramprasad4121/vaktha.git` (or `git pull --ff-only` if present) at a stable path.
   - `git clone https://github.com/cgarrot/opencode-stt.git ~/opencode-stt` (or pull if present).
2. Build Vaktha: `npm install && npm run typecheck && npm run build && npm test` inside the vaktha dir. All must pass.
3. Ensure `ffmpeg` exists. If missing on macOS: `brew install ffmpeg`. On Linux: `apt install ffmpeg`.
4. Ensure a transcription backend exists (pick the first that applies):
   - If `OPENAI_API_KEY` is set, use backend `openai`.
   - Else on Apple Silicon Macs: `pip install mlx-whisper`.
   - Else: `pip install openai-whisper`.
   - Confirm with `vaktha status` (or `node dist/cli.js status`): backends must not be empty.
5. MCP wiring: read `~/.config/opencode/opencode.json` (or `opencode.jsonc` if that's what exists), then MERGE in:
   `"mcp": { "vaktha": { "type": "local", "command": ["node", "<ABSOLUTE>/vaktha/dist/index.js"], "enabled": true } }`
   using the real absolute path. Validate the file still parses.
6. TUI plugin: in `~/opencode-stt` run `bun install --frozen-lockfile && bun run ci`. All must pass.
7. Mic detection — list devices with the OS-appropriate command, then pick a mic index/name. Prefer a built-in mic (always present) over Bluetooth. If unsure, ask me.
   - macOS: `ffmpeg -hide_banner -f avfoundation -list_devices true -i ""` → `capture.input` is `":<N>"`.
   - Windows: `ffmpeg -hide_banner -f dshow -list_devices true -i dummy` → `capture.input` is `"audio=<Exact Device Name>"`. Note: Vaktha's own `vaktha_listen` auto-detects the first mic, but the TUI plugin needs the explicit value.
   - Linux: `arecord -l` → configure the pulse/alsa source.
8. Write `~/opencode-stt/config.local.json`:
   `{"capture": {"type": "ffmpeg", "inputFormat": "avfoundation", "input": ":<N>", "sampleRate": 16000, "channels": 1, "maxSeconds": 120, "minBytes": 4096}, "provider": {"type": "openai-compatible", "endpoint": "http://127.0.0.1:8765/v1/audio/transcriptions", "model": "whisper-1", "apiKeyEnv": "", "language": "en"}, "output": {"appendTrailingSpace": true}}`
9. TUI wiring: read `~/.config/opencode/tui.json` if it exists, then MERGE (never replace) the plugin entry
   `["/Users/<me>/opencode-stt/voxtral-stt.tsx", {"configPath": "/Users/<me>/opencode-stt/config.local.json", "keybinds": {"record": "ctrl+r"}}]`
   and `"keybinds": {"session_rename": "none"}`. Use my real `$HOME`. Validate the file still parses.
10. Transcription server: start `node <vaktha>/dist/cli.js serve --port 8765` and make it permanent:
    - macOS: write `~/Library/LaunchAgents/com.vaktha.serve.plist` (KeepAlive + RunAtLoad, stable node binary — NEVER an fnm multishell path; prefer `/opt/homebrew/bin/node` if present) with mlx/ffmpeg on PATH, then `launchctl bootstrap`.
    - Linux: a user systemd unit doing the same.
    - Windows: `schtasks /create /tn VakthaServe /tr "node <vaktha>\dist\cli.js serve --port 8765" /sc onlogon` (use the real node.exe path).
    - Verify with `curl http://127.0.0.1:8765/health` → `{"ok":true,...}`.
11. Final verification, all must hold:
    - `curl http://127.0.0.1:8765/health` returns ok.
    - `opencode mcp list` shows `vaktha` connected.
    - `bun run ci` in `~/opencode-stt` passes.
12. Tell me, briefly: what you installed, which mic you picked, and the 3 manual steps: (a) restart OpenCode TUI, (b) press Ctrl+R and speak (Ctrl+R again to stop, Enter to send, Esc to cancel), (c) allow Microphone access for my terminal if macOS asks.

---

*End of prompt. Maintainer note: this file is the canonical setup prompt; README.md stays minimal and points here.*
