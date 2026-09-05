#!/usr/bin/env node
/** Vaktha CLI: status | listen | transcribe | speak | serve | voice */
import { execFile } from "node:child_process";
import { rmSync } from "node:fs";
import { defaultDevice, recordWav, tmpWavPath } from "./audio.js";
import { detectBackends } from "./transcribe.js";
import { transcribeFile } from "./transcribe.js";
import { speak } from "./speak.js";
import { startServer } from "./serve.js";
import { voiceLoop, voiceOnce } from "./voice.js";

function arg(name: string, short?: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || (short && a === `-${short}`));
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const pref = process.argv.find((a) => a.startsWith(`--${name}=`));
  return pref ? pref.slice(name.length + 3) : undefined;
}
function flag(name: string, short?: string): boolean {
  return process.argv.includes(`--${name}`) || (short ? process.argv.includes(`-${short}`) : false);
}
const num = (v: string | undefined, d: number) => {
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};

function usage(): never {
  console.error(`vaktha — voice dictation for OpenCode
Usage: vaktha <command> [options]
  status                          readiness check (mic, ffmpeg, backends)
  listen [--seconds 15] [--lang en] [--model M] [--backend B] [--device D] [--copy]
                                  record mic + print transcript (--copy also copies to clipboard)
  transcribe <file> [opts]         transcribe an audio file
  speak <text...> [--voice V]      read text aloud
  serve [--port 8765]              localhost OpenAI-compatible STT server (for the TUI plugin)
  voice [--url URL] [--port 4173] [--lang en] [--device D] [--voice V] [--text "..."]
                                  persistent voice agent: SPACE talk/send, interruptable, spoken replies`);
  process.exit(1);
}

async function cmdStatus(): Promise<void> {
  const { available, openaiKey, ffmpeg } = await detectBackends();
  console.log(`ffmpeg: ${ffmpeg ? "ok" : "MISSING (brew install ffmpeg)"}`);
  console.log(`mic device: ${defaultDevice()}`);
  console.log(`OPENAI_API_KEY: ${openaiKey ? "set" : "unset"}`);
  console.log(`backends: ${available.join(", ") || "(none)"}`);
}

async function cmdListen(): Promise<void> {
  const wav = tmpWavPath();
  try {
    const rec = await recordWav(wav, num(arg("seconds", "s"), 15), arg("device", "d"));
    const { text, backend } = await transcribeFile(wav, {
      language: arg("lang", "l"),
      model: arg("model", "m"),
      backend: arg("backend", "b"),
    });
    console.error(`[${backend}, ${rec.seconds}s audio]`);
    console.log(text);
    if (flag("copy", "c") && process.platform === "darwin") {
      await new Promise<void>((resolve, reject) => {
        const p = execFile("pbcopy", (e) => (e ? reject(e) : resolve()));
        p.stdin?.end(text);
      });
      console.error("(copied to clipboard)");
    }
  } finally {
    rmSync(wav, { force: true });
  }
}

async function main(): Promise<void> {
  const cmd = process.argv[2];
  try {
    if (cmd === "status") return await cmdStatus();
    if (cmd === "listen") return await cmdListen();
    if (cmd === "transcribe") {
      const file = process.argv[3];
      if (!file) throw new Error("transcribe needs a file path");
      const { text, backend } = await transcribeFile(file, {
        language: arg("lang", "l"),
        model: arg("model", "m"),
        backend: arg("backend", "b"),
      });
      console.error(`[${backend}]`);
      console.log(text);
      return;
    }
    if (cmd === "speak") {
      const text = process.argv.slice(3).filter((a) => !a.startsWith("-")).join(" ");
      if (!text) throw new Error("speak needs text");
      await speak(text, arg("voice", "v"), num(arg("rate", "r"), NaN) || undefined);
      return;
    }
    if (cmd === "serve") {
      const port = Math.round(num(arg("port", "p"), 8765));
      const { backend } = await startServer(port);
      console.error(`vaktha serve on http://127.0.0.1:${port} (backend=${backend})`);
      await new Promise(() => {}); // run forever
      return;
    }
    if (cmd === "voice") {
      const voiceOpts = {
        url: arg("url"),
        port: num(arg("port", "p"), NaN) || undefined,
        lang: arg("lang", "l"),
        model: arg("model", "m"),
        backend: arg("backend", "b"),
        device: arg("device", "d"),
        voice: arg("voice", "v"),
      };
      const text = arg("text", "t");
      if (text) {
        const reply = await voiceOnce({ ...voiceOpts, text });
        console.log(reply || "(empty reply)");
        return;
      }
      await voiceLoop(voiceOpts);
      return;
    }
    usage();
  } catch (e) {
    console.error(`vaktha ${cmd || ""} failed: ${(e as Error).message}`);
    process.exit(1);
  }
}

main();
