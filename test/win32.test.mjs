// Windows DirectShow device-name parser tests (pure function, runs anywhere).
import { test } from "node:test";
import assert from "node:assert";
import { parseDshowFirstAudioDevice } from "../dist/audio.js";

const SAMPLE = `[dshow @ 0000023a4b5fe3c0] DirectShow video devices (some may be both video and audio devices)
[dshow @ 0000023a4b5fe3c0]  "Integrated Camera"
[dshow @ 0000023a4b5fe3c0] DirectShow audio devices
[dshow @ 0000023a4b5fe3c0]  "Microphone (Realtek Audio)"
[dshow @ 0000023a4b5fe3c0]  "Headset (Hands-Free AG Audio)"
`;

test("picks the first DirectShow audio device, skipping video devices", () => {
  assert.strictEqual(parseDshowFirstAudioDevice(SAMPLE), "Microphone (Realtek Audio)");
});

test("returns null when no audio devices are listed", () => {
  assert.strictEqual(
    parseDshowFirstAudioDevice('[dshow @ 000] DirectShow video devices\n[dshow @ 000]  "Cam"\n'),
    null
  );
  assert.strictEqual(parseDshowFirstAudioDevice(""), null);
});
