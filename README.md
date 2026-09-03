# Vaktha — voice dictation for OpenCode

> *Vaktha* (वक्था, Sanskrit: "speech") — stop typing, start speaking.

Vaktha gives OpenCode ears two ways:

1. **Talk in the TUI (recommended):** press `Ctrl+R`, speak, press again — the transcript lands in your prompt box. No typing, no round-trip through the agent.
2. **Agent dictation (MCP):** say *"dictate"* and the agent records + transcribes via MCP tools.

## How it works

```
you: "dictate"  →  agent calls vaktha_listen  →  ffmpeg records mic (N sec)
→  whisper transcribes  →  transcript returned as text  →  agent acts on it
```

No audio ever leaves your machine unless you choose the OpenAI backend.

## Talk in the TUI — Ctrl+R (the mic button equivalent)

OpenCode has no clickable mic button, so Vaktha wires up the next best thing:
a **push-to-talk keybind with a live indicator** in the prompt bar
(`ctrl+r voice input` → `● listening` → `transcribing`).

It uses the community [`opencode-stt`](https://github.com/cgarrot/opencode-stt)
TUI plugin for recording + prompt insertion, with Vaktha's local
`vaktha serve` as its transcription engine (your installed `mlx-whisper`,
nothing leaves the machine).

Setup (already done on this machine — for reference / fresh installs):

```bash
git clone https://github.com/cgarrot/opencode-stt.git ~/opencode-stt
cd ~/opencode-stt && bun install --frozen-lockfile && bun run ci
cp <vaktha>/examples/stt.config.local.json ~/opencode-stt/config.local.json
# edit capture.input to your mic (see vaktha status / ffmpeg device list)
```

`~/.config/opencode/tui.json`:

```json
{
  "plugin": [
    ["/Users/you/opencode-stt/voxtral-stt.tsx",
     {"configPath": "/Users/you/opencode-stt/config.local.json",
      "keybinds": {"record": "ctrl+r"}}]
  ],
  "keybinds": {"session_rename": "none"}
}
```

Start the transcription server (auto-starts on login via LaunchAgent
`com.vaktha.serve` once installed):

```bash
node dist/cli.js serve --port 8765
```

Then restart OpenCode and: `Ctrl+R` = start/stop recording,
`Enter` while recording = transcribe + send immediately,
`Esc` = cancel. If the wrong mic records, change `capture.input`
(`":0"`, `":1"`, …) in `~/opencode-stt/config.local.json`.

## MCP server (agent dictation)

The `vaktha` MCP exposes 4 tools (kept small on purpose):

| Tool | What it does |
|---|---|
| `vaktha_listen` | Record mic for N seconds (default 15, max 180) and return transcription. **This is the dictation tool.** |
| `vaktha_transcribe` | Transcribe an existing audio file (`file` = absolute path). |
| `vaktha_status` | Readiness check: ffmpeg, mic devices, transcription backends, env. Run this first when setting up. |
| `vaktha_speak` | Read text aloud via system TTS (macOS `say`). For hands-free replies. |

## Prerequisites

- **Node 18+**
- **ffmpeg** — recording: `brew install ffmpeg` (macOS) / `sudo apt install ffmpeg` (Linux)
- **One transcription backend** (pick one):
  1. `export OPENAI_API_KEY=sk-...` — easiest, uses `whisper-1` in the cloud
  2. `pip install mlx-whisper` — local, fastest on Apple Silicon, no API key
  3. `pip install openai-whisper` — local, any platform (`whisper` CLI)
  4. whisper.cpp binary (`whisper-cpp`) + model file via `VAKTHA_MODEL_PATH` — fully offline

Or run the helper: `bash scripts/install.sh` (macOS: ffmpeg + mlx-whisper).

## Install

```bash
git clone https://github.com/Ramprasad4121/vaktha.git
cd vaktha
npm install && npm run build
```

## Connect to OpenCode

Add to your OpenCode config (`~/.config/opencode/opencode.json` for global, or `./opencode.json` per project):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vaktha": {
      "type": "local",
      "command": ["node", "/absolute/path/to/vaktha/dist/index.js"],
      "enabled": true,
      "environment": {
        "OPENAI_API_KEY": "{env:OPENAI_API_KEY}"
      }
    }
  }
}
```

A ready-made file is in [`opencode.json.example`](./opencode.json.example) — copy the `mcp.vaktha` block into your config and fix the path.

Verify inside OpenCode:

```
check vaktha_status and tell me if my mic is ready
```

## Usage

- **Dictate:** *"listen for 20 seconds"* / *"dictate my next task"* — the agent calls `vaktha_listen`, gets your words as text, and continues.
- **Transcribe a file:** *"transcribe /tmp/meeting.m4a with vaktha"*.
- **Voice replies:** *"read the summary back with vaktha_speak"*.
- Tip: add to your `AGENTS.md`: `When I say dictate/listen, use vaktha_listen and treat the transcript as my message.`

## Configuration (env vars)

| Var | Default | Meaning |
|---|---|---|
| `OPENAI_API_KEY` | — | Enables the OpenAI (`whisper-1`) backend |
| `VAKTHA_BACKEND` | auto | `openai` \| `mlx-whisper` \| `whisper` \| `whisper.cpp` |
| `VAKTHA_LANG` | `en` | Transcription language (`hi`, `kn`, …) |
| `VAKTHA_MODEL` | backend default | Model override (`whisper-1`, `base/small/medium`, `mlx-community/whisper-base-mlx`, …) |
| `VAKTHA_MODEL_PATH` | — | whisper.cpp `.bin` model file |
| `VAKTHA_AUDIO_DEVICE` | `0` (macOS) | Mic index from `vaktha_status` (e.g. your headset vs built-in mic) |
| `VAKTHA_TMPDIR` | OS tmp | Where short-lived recordings go (auto-deleted) |

macOS mic permission: Terminal / OpenCode needs **Microphone** access (System Settings → Privacy & Security → Microphone). If recording fails with an empty file, that's the first thing to check.

## Privacy

Recordings are short-lived WAVs in the temp dir and deleted after transcription. With local backends (`mlx-whisper`, `whisper`, whisper.cpp) nothing leaves your machine. The `openai` backend sends audio to OpenAI's transcription API.

## CLI

```bash
node dist/cli.js status                 # readiness check
node dist/cli.js listen --seconds 20    # record mic + print transcript (--copy for clipboard)
node dist/cli.js transcribe /tmp/note.m4a
node dist/cli.js speak "done"           # read aloud
node dist/cli.js serve --port 8765      # localhost STT server (TUI plugin engine)
```

After `npm run build` you can link it globally with `npm link` and just run `vaktha …`.

## Dev

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc → dist/
npm test            # smoke tests (handshake + tools/list)
```

## License

MIT — see [LICENSE](./LICENSE).
