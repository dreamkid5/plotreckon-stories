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
import {
  PRESENTER_ASSETS,
  extractNarratorAge,
  installAgeMatchedPresenter,
  selectPresenterForAge
} from "./presenter.mjs";
import {
  makeHook,
  THUMBNAIL_HOOK_MAX_WORDS,
  THUMBNAIL_HOOK_MIN_WORDS
} from "./thumbnail.mjs";

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

test("narrator age is read from current first-person statements", () => {
  assert.equal(extractNarratorAge("My name is Rachel. I'm thirty four years old."), 34);
  assert.equal(extractNarratorAge("I’m fifty-three years old, and this is my story."), 53);
  assert.equal(extractNarratorAge("The twins are six. I am 42 years old."), 42);
  assert.equal(extractNarratorAge("I am a 68-year-old woman."), 68);
  assert.equal(extractNarratorAge("I am 39 and this happened last year."), 39);
  assert.equal(extractNarratorAge("It has been two years now. I am thirty eight."), 38);
  assert.equal(extractNarratorAge("I'm forty now, and the kids are grown."), 40);
});

test("third-person and casual past mentions cannot choose the presenter", () => {
  assert.equal(extractNarratorAge("I was twenty five when we met. My husband is 40 years old."), null);
  assert.equal(extractNarratorAge("My daughter is eighteen years old."), null);
});

test("present-tense age wins; a stated past age is only a fallback", () => {
  // Present tense always chosen, even when a past age is mentioned first.
  assert.equal(
    extractNarratorAge("I was twenty five years old when we married. I am thirty eight years old."),
    38
  );
  // Falls back to a deliberate past age when no present-tense age is given.
  assert.equal(extractNarratorAge("I was thirty six years old that October."), 36);
  assert.equal(extractNarratorAge("Back then I was 42 years old."), 42);
});

test("adult narrator ages select the matching decade portrait", () => {
  const expectations = [
    [18, 20], [29, 20], [30, 30], [39, 30], [40, 40], [49, 40],
    [50, 50], [59, 50], [60, 60], [69, 60], [70, 70], [79, 70],
    [80, 80], [89, 80], [90, 90], [99, 90]
  ];
  for (const [age, decade] of expectations) {
    assert.equal(selectPresenterForAge(age).decade, decade);
  }
});

test("every age range has a reviewed high-resolution portrait asset", async () => {
  assert.deepEqual(
    Object.keys(PRESENTER_ASSETS),
    ["20", "30", "40", "50", "60", "70", "80", "90"]
  );
  for (const imagePath of Object.values(PRESENTER_ASSETS)) {
    const image = await fs.readFile(imagePath);
    assert.ok(image.length >= 100000, imagePath);
    assert.deepEqual([...image.subarray(0, 3)], [255, 216, 255], imagePath);
  }
});

test("presenter installs the fixed host even when no age is stated", async () => {
  await withTempDir(async (dir) => {
    const selected = await installAgeMatchedPresenter({ script: "I was twenty five when we met." }, dir);
    assert.equal(selected.label, "fixed host");
    assert.deepEqual(
      await fs.readFile(selected.path),
      await fs.readFile(PRESENTER_ASSETS[30])
    );
  });
});

test("the same fixed presenter is installed regardless of the stated age", async () => {
  await withTempDir(async (dir) => {
    const selected = await installAgeMatchedPresenter(
      { script: "My children are seven years old. I am fifty three years old." },
      dir
    );
    // The age is still parsed (kept as a label) but no longer picks the portrait.
    assert.equal(selected.age, 53);
    assert.equal(selected.label, "fixed host");
    assert.deepEqual(
      await fs.readFile(selected.path),
      await fs.readFile(PRESENTER_ASSETS[30])
    );
  });
});

test("thumbnail hook stays wordy and preserves the catchy opening", () => {
  const script = "I found the preschool tuition receipt by accident. It was tucked inside a jacket pocket, the kind of thing you find when you're doing laundry on a Tuesday night, half tired, half thinking about what to make for dinner tomorrow. A payment revealed the family secret.";
  const hook = makeHook({ script });
  const words = hook.split(/\s+/).length;
  assert.ok(words >= THUMBNAIL_HOOK_MIN_WORDS);
  assert.ok(words <= THUMBNAIL_HOOK_MAX_WORDS);
  assert.match(hook, /^I found the preschool tuition receipt by accident\./);
});

test("short explicit thumbnail hook is expanded instead of becoming a headline", () => {
  const hook = makeHook({
    hook: "My sister took over my home.",
    script: "She moved in across the hall and within a week she was wearing my clothes and eating my food. When she said I never shared anything, I stopped paying her rent and told the whole family why."
  });
  assert.match(hook, /^My sister took over my home\./);
  assert.ok(hook.split(/\s+/).length >= THUMBNAIL_HOOK_MIN_WORDS);
  assert.ok(hook.split(/\s+/).length <= THUMBNAIL_HOOK_MAX_WORDS);
});

test("thumbnail hook never exceeds the dense reference limit", () => {
  const longHook = Array.from({ length: 70 }, (_, i) => "word" + i).join(" ");
  const hook = makeHook({ hook: longHook });
  assert.equal(hook.split(/\s+/).length, THUMBNAIL_HOOK_MAX_WORDS);
  assert.match(hook, /\.\.\.$/);
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
