import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  LOCKED_SCENE_SECONDS,
  atempoFiltersForDuration,
  lockNarrationDuration,
  scaleWordTimings
} from "./render.mjs";

const execFileAsync = promisify(execFile);
const bundledFfmpegPath = fileURLToPath(new URL("./tools/ffmpeg", import.meta.url));
const bundledFfprobePath = fileURLToPath(new URL("./tools/ffprobe", import.meta.url));
const bundledFfmpeg = existsSync(bundledFfmpegPath) ? bundledFfmpegPath : "ffmpeg";
const bundledFfprobe = existsSync(bundledFfprobePath) ? bundledFfprobePath : "ffprobe";

async function withTempDir(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plotreckon-scene-"));
  try { await run(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test("production scene duration is permanently locked to 5.5 seconds", () => {
  assert.equal(LOCKED_SCENE_SECONDS, 5.5);
  assert.deepEqual(atempoFiltersForDuration(11, LOCKED_SCENE_SECONDS), [
    "atempo=2.00000000"
  ]);
  assert.deepEqual(atempoFiltersForDuration(1.375, LOCKED_SCENE_SECONDS), [
    "atempo=0.5",
    "atempo=0.50000000"
  ]);
});

test("caption word timings scale to the locked scene duration", () => {
  const scaled = scaleWordTimings([
    { w: "hello", t: 1, d: 0.5 },
    { w: "world", t: 4, d: 1 }
  ], 5, LOCKED_SCENE_SECONDS);
  assert.deepEqual(scaled, [
    { w: "hello", t: 1.1, d: 0.55 },
    { w: "world", t: 4.4, d: 1.1 }
  ]);
});

test("real narration audio is rendered to exactly 5.5 seconds", async () => {
  await withTempDir(async (dir) => {
    const audioPath = path.join(dir, "scene.wav");
    const wordsPath = audioPath + ".words.json";
    await execFileAsync(bundledFfmpeg, [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", audioPath
    ]);
    await fs.writeFile(wordsPath, JSON.stringify([
      { w: "locked", t: 1, d: 0.5 }
    ]));

    await lockNarrationDuration(audioPath, wordsPath, 2, {
      ffmpeg: bundledFfmpeg,
      ffprobe: bundledFfprobe
    });

    const { stdout } = await execFileAsync(bundledFfprobe, [
      "-v", "error", "-show_entries", "format=duration",
      "-of", "default=nw=1:nk=1", audioPath
    ]);
    assert.ok(Math.abs(Number(stdout.trim()) - LOCKED_SCENE_SECONDS) <= 0.06);
    assert.deepEqual(JSON.parse(await fs.readFile(wordsPath, "utf8")), [
      { w: "locked", t: 2.75, d: 1.375 }
    ]);
  });
});
