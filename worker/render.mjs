// Rendering engine for the worker. Uses ffmpeg to turn scene images plus
// optional narration and music into a finished MP4. No browser required.

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { splitScript, buildPrompt } from "./csv.mjs";
import { buildCharacterBible, sceneCharacterNote } from "./characters.mjs";
import { buildSceneVisuals } from "./visuals.mjs";
import { buildThumbnail } from "./thumbnail.mjs";
import { installAgeMatchedPresenter } from "./presenter.mjs";
import {
  LOCKED_VOICE,
  LOCKED_VOICE_PITCH,
  LOCKED_VOICE_RATE
} from "./voice.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(HERE, "assets", "fonts");
const BACKGROUNDS_DIR = path.join(HERE, "assets", "backgrounds");
const DEFAULT_BACKGROUND = path.join(BACKGROUNDS_DIR, "mountains-day.jpg");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Resolve the fixed background reused for every scene. On by default (the
// committed daytime mountain), which the per-scene Ken Burns motion turns into a
// smooth slow zoom, and which removes the slow per-scene image generation. Set
// CF_BACKGROUND=0 to go back to a unique AI image per scene; CF_BACKGROUND=/path
// to point at a different background file.
async function resolveBackgroundImage(cfg) {
  const setting = cfg.background;
  if (setting === "0" || setting === "off" || setting === "false") return null;
  const file = (setting && setting !== "1" && setting !== "on") ? setting : DEFAULT_BACKGROUND;
  const st = await fs.stat(file).catch(() => null);
  if (st && st.isFile() && st.size > 1000) return file;
  // A configured/default background that is missing should not fail the whole
  // render; fall back to per-scene images instead.
  cfg.log("  background image not found (" + file + "), falling back to per-scene images");
  return null;
}

// Target scene length used only to size the caption / Ken-Burns segments when the
// script is split. The narration itself plays at its natural speed (see
// lockNarrationDuration), so a scene's real length follows the voice, not this value.
export const LOCKED_SCENE_SECONDS = 5.5;

// Escape a file path for use inside the ffmpeg subtitles filter argument.
function ffEscapePath(p) {
  return p.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    let err = "";
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", rej);
    p.on("close", (code) => code === 0 ? res() : rej(new Error(cmd + " exited " + code + ": " + err.slice(-600))));
  });
}

function probeDuration(file, cfg) {
  return new Promise((res) => {
    const p = spawn(cfg.ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => res(null));
    p.on("close", () => { const n = parseFloat(out.trim()); res(isFinite(n) && n > 0 ? n : null); });
  });
}

export function atempoFiltersForDuration(sourceDuration, targetDuration) {
  const source = Number(sourceDuration);
  const target = Number(targetDuration);
  if (!Number.isFinite(source) || source <= 0 || !Number.isFinite(target) || target <= 0) {
    throw new Error("audio timing requires positive source and target durations");
  }
  let ratio = source / target;
  const filters = [];
  // Keep each atempo stage inside ffmpeg's portable 0.5..2 range.
  while (ratio < 0.5) {
    filters.push("atempo=0.5");
    ratio /= 0.5;
  }
  while (ratio > 2) {
    filters.push("atempo=2");
    ratio /= 2;
  }
  filters.push("atempo=" + ratio.toFixed(8));
  return filters;
}

export function scaleWordTimings(words, sourceDuration, targetDuration) {
  const scale = Number(targetDuration) / Number(sourceDuration);
  if (!Array.isArray(words) || !words.length || !Number.isFinite(scale) || scale <= 0) {
    throw new Error("word timing scale is invalid");
  }
  return words.map((word) => {
    const t = Number(Math.min(
      Number(targetDuration),
      Math.max(0, Number(word.t || 0) * scale)
    ).toFixed(6));
    const d = Number(Math.min(
      Math.max(0, Number(targetDuration) - t),
      Math.max(0, Number(word.d || 0) * scale)
    ).toFixed(6));
    return { ...word, t, d };
  });
}

async function readWordTimings(file) {
  const words = JSON.parse(await fs.readFile(file, "utf8"));
  if (!Array.isArray(words) || !words.length) throw new Error("word timings were empty");
  return words;
}

// Scene-length guardrails. Narration plays at its NATURAL speed, so a scene runs
// for as long as the voice naturally takes (plus a short tail for breathing room),
// clamped to this range. This is what keeps Ava from ever sounding rushed or slowed.
export const MIN_SCENE_SECONDS = 2.5;
export const MAX_SCENE_SECONDS = 14;
const SCENE_TAIL_SECONDS = 0.25;

// Fit a scene's narration WITHOUT changing its speed. Earlier this time-stretched
// (atempo) the voice to a fixed 5.5s, which sped up wordy scenes (rushed) and slowed
// sparse ones (draggy). Instead we keep the audio at its natural speed and only pad
// it with a little trailing silence, so the scene length follows the voice. Word
// timings stay natural (no rescaling), so captions still line up. Returns the final
// scene duration in seconds.
export async function lockNarrationDuration(audioPath, wordsPath, sourceDuration, cfg) {
  const natural = Number(sourceDuration);
  const base = (Number.isFinite(natural) && natural > 0 ? natural : MIN_SCENE_SECONDS) + SCENE_TAIL_SECONDS;
  const target = Math.min(MAX_SCENE_SECONDS, Math.max(MIN_SCENE_SECONDS, base));
  const timedPath = audioPath + ".padded.wav";
  const filters = [
    "apad=whole_dur=" + target.toFixed(6),
    "atrim=duration=" + target.toFixed(6)
  ].join(",");
  try {
    await run(cfg.ffmpeg, [
      "-y", "-i", audioPath,
      "-filter:a", filters,
      "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le",
      timedPath
    ]);
    const duration = await probeDuration(timedPath, cfg);
    if (!duration || Math.abs(duration - target) > 0.12) {
      throw new Error("scene audio was " + duration + " seconds instead of " + target);
    }
    await fs.rename(timedPath, audioPath);
    return target;
  } finally {
    await fs.rm(timedPath, { force: true }).catch(() => {});
  }
}

// ---------- asset fetching ----------
async function fetchImage(prompt, seed, outPath, cfg, opts = {}) {
  const token = cfg.imageToken ? "&token=" + encodeURIComponent(cfg.imageToken) : "";
  const w = Number(opts.width) || Number(cfg.width) || 1920;
  const h = Number(opts.height) || Number(cfg.height) || 1080;
  const attempts = Number(opts.attempts) || 6;
  // Prompt enhancement improves the first try but adds a step that can fail. So we use
  // it only on the FIRST attempt (best quality) and drop it on retries (more reliable),
  // which lifts the success rate without losing quality when things go smoothly.
  const enhanceOn = opts.enhance !== undefined ? opts.enhance : (cfg.imageEnhance !== false);
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Vary the seed on every attempt so a retry generates a genuinely NEW image for
    // this scene, rather than re-requesting the same one that just failed.
    const s = seed + attempt * 104729;
    const enhance = (enhanceOn && attempt === 0) ? "&enhance=true" : "";
    const url = cfg.imageBase + "/" + encodeURIComponent(prompt) +
      "?width=" + w + "&height=" + h + "&nologo=true" + enhance + "&model=" + cfg.imageModel + "&seed=" + s + token;
    try {
      const r = await fetch(url);
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 1000) { await fs.writeFile(outPath, buf); return true; }
      } else if (r.status === 429 || r.status === 503) {
        // rate limited or busy, wait longer and try again
        const ra = parseInt(r.headers.get("retry-after") || "0", 10);
        await sleep(ra > 0 ? Math.min(60000, ra * 1000) : Math.min(45000, 6000 * (attempt + 1)));
        continue;
      }
    } catch (e) { /* network hiccup, retry */ }
    await sleep(2500 * (attempt + 1));
  }
  return false;
}

async function fetchTTS(script, _voice, outPath, cfg) {
  const textFile = outPath + ".txt";
  const wordsFile = outPath + ".words.json";
  const attempts = Math.max(1, Number(process.env.CF_TTS_ATTEMPTS || 8));
  let lastError = new Error("unknown Ava narration error");

  for (let attempt = 1; attempt <= attempts; attempt++) {
    await fs.rm(outPath, { force: true }).catch(() => {});
    await fs.rm(wordsFile, { force: true }).catch(() => {});
    await fs.writeFile(textFile, script);
    try {
      await run(cfg.edgeCmd || "python3", [
        path.join(HERE, "tts_words.py"),
        textFile,
        LOCKED_VOICE,
        outPath,
        wordsFile,
        LOCKED_VOICE_RATE,
        LOCKED_VOICE_PITCH
      ]);
      const audio = await fs.stat(outPath).catch(() => null);
      const timings = await fs.stat(wordsFile).catch(() => null);
      const duration = await probeDuration(outPath, cfg);
      if (!audio || audio.size <= 1000) throw new Error("audio output was empty");
      if (!timings || timings.size <= 2) throw new Error("word timings were empty");
      if (!duration) throw new Error("audio duration was invalid");
      return true;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < attempts) {
        const waitMs = Math.min(30000, 2500 * (2 ** (attempt - 1)));
        cfg.log(
          "  Ava narration attempt " + attempt + "/" + attempts +
          " failed (" + lastError.message.slice(0, 120) + "); retrying"
        );
        await sleep(waitMs);
      }
    } finally {
      await fs.rm(textFile, { force: true }).catch(() => {});
    }
  }

  throw new Error(
    "Ava narration failed after " + attempts + " attempts: " + lastError.message
  );
}

async function fetchMusic(url, outPath) {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("audio") && !/\.(mp3|m4a|ogg|wav)($|\?)/i.test(url)) return null;
    await fs.writeFile(outPath, Buffer.from(await r.arrayBuffer()));
    return outPath;
  } catch (e) { return null; }
}

// ---------- ffmpeg steps ----------
// A single still becomes a gently drifting clip (Ken Burns).
// Uses a scale based zoom rather than the zoompan filter, which is dozens of
// times faster, so videos with many scenes render in minutes, not hours.
// The zoom is kept subtle (default 6%) and alternates direction per scene so the
// motion feels natural and cinematic rather than pushed in too far. Tune with CF_ZOOM.
function kenBurnsVf(dur, cfg, idx) {
  const D = Math.max(0.1, dur);
  const W = Number(cfg.width) || 1920, H = Number(cfg.height) || 1080;
  const zoom = Math.min(0.2, Math.max(0, Number(cfg.zoom) || 0.06));
  const hi = (1 + zoom).toFixed(3);
  const z = (idx % 2 === 0) ? "(1+" + zoom + "*t/" + D + ")" : "(" + hi + "-" + zoom + "*t/" + D + ")";
  return "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," +
    "scale=w='" + W + "*" + z + "':h='" + H + "*" + z + "':eval=frame,crop=" + W + ":" + H + ",format=yuv420p";
}

function kenBurnsClip(imgPath, outPath, dur, cfg, idx = 0) {
  const crf = String(Number(cfg.crf) || 20);
  return run(cfg.ffmpeg, ["-y", "-loop", "1", "-t", String(dur), "-i", imgPath, "-vf", kenBurnsVf(dur, cfg, idx), "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p", outPath]);
}

// A self-contained scene clip: the image (with Ken Burns motion) plus THIS scene's
// own narration muxed in, both the same length. Because each image and its narration
// live in the same clip, they can never drift apart when the clips are joined, so the
// pictures stay locked to the voice for the whole video. If a scene has no narration,
// a matching stretch of silence is used so every clip has an identical audio layout.
function sceneClipWithAudio(imgPath, audioPath, outPath, dur, cfg, idx = 0) {
  const crf = String(Number(cfg.crf) || 20);
  const args = ["-y", "-loop", "1", "-t", String(dur), "-i", imgPath];
  if (audioPath) args.push("-i", audioPath);
  else args.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=channel_layout=mono:sample_rate=24000");
  args.push(
    "-vf", kenBurnsVf(dur, cfg, idx),
    "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-ar", "24000", "-ac", "1",
    "-map", "0:v:0", "-map", "1:a:0", "-t", String(dur), outPath
  );
  return run(cfg.ffmpeg, args);
}

// Ken Burns filter for an arbitrary panel size (used for the story panel that sits
// beside the presenter, so it is narrower than the full frame).
function kenBurnsVfSize(dur, cfg, idx, W, H) {
  const D = Math.max(0.1, dur);
  const zoom = Math.min(0.2, Math.max(0, Number(cfg.zoom) || 0.06));
  const hi = (1 + zoom).toFixed(3);
  const z = (idx % 2 === 0) ? "(1+" + zoom + "*t/" + D + ")" : "(" + hi + "-" + zoom + "*t/" + D + ")";
  return "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," +
    "scale=w='" + W + "*" + z + "':h='" + H + "*" + z + "':eval=frame,crop=" + W + ":" + H + ",setsar=1";
}

// The presenter panel. By default it is STILL (zoom 0) — only the scene photos zoom.
// If CF_PRESENTER_ZOOM is set it gets a gentle centred Ken Burns push-in that alternates
// direction per scene (like the story panel) so the zoom level carries across hard cuts.
function presenterKenBurns(dur, cfg, idx, W, H) {
  const D = Math.max(0.1, dur);
  const zoom = Math.min(0.12, Math.max(0, cfg.presenterZoom == null ? 0 : Number(cfg.presenterZoom)));
  if (!zoom) return "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + ",setsar=1";
  const hi = (1 + zoom).toFixed(3);
  const z = (idx % 2 === 0) ? "(1+" + zoom + "*t/" + D + ")" : "(" + hi + "-" + zoom + "*t/" + D + ")";
  return "scale=" + W + ":" + H + ":force_original_aspect_ratio=increase,crop=" + W + ":" + H + "," +
    "scale=w='" + W + "*" + z + "':h='" + H + "*" + z + "':eval=frame,crop=" + W + ":" + H + ",setsar=1";
}

// Layout fractions for the storytime composite: a full-screen background, the
// presenter in a bordered box bottom-right, and the karaoke caption centred in the
// area to the left of that box.
const BOX_W_FRAC = 0.30;         // presenter box width, fraction of the frame
const BOX_H_FRAC = 0.60;         // presenter box height (portrait, so a head-and-
                                 // shoulders portrait fits without cropping the head)
const BOX_MARGIN_FRAC = 0.022;   // gap from the frame edges
const CAPTION_CX_FRAC = (1 - BOX_W_FRAC - BOX_MARGIN_FRAC) / 2; // centre of the area left of the box
const CAPTION_Y_FRAC = 0.82;

// A storytime scene clip in the "reaction" layout: the background photo fills the
// whole frame with a slow zoom, the age-matched presenter sits in a white-bordered
// box in the bottom-right, a live waveform reacts to the narration on the left, a
// SUBSCRIBE badge sits top-left, and karaoke captions burn in along the bottom.
// presenter and assPath are optional; without a presenter it is a full-frame photo.
async function sceneClipComposite(presenter, story, audioPath, assPath, outPath, dur, cfg, idx = 0) {
  const crf = String(Number(cfg.crf) || 20);
  const W = Number(cfg.width) || 1920, H = Number(cfg.height) || 1080;
  const useComposite = !!presenter;

  const inputs = ["-y"];
  if (useComposite) inputs.push("-loop", "1", "-t", String(dur), "-i", presenter);
  inputs.push("-loop", "1", "-t", String(dur), "-i", story);
  const audioIdx = useComposite ? 2 : 1;
  if (audioPath) inputs.push("-i", audioPath);
  else inputs.push("-f", "lavfi", "-t", String(dur), "-i", "anullsrc=channel_layout=mono:sample_rate=24000");

  const subs = assPath ? "subtitles='" + ffEscapePath(assPath) + "':fontsdir='" + ffEscapePath(FONTS_DIR) + "'" : null;
  const badgeFont = path.join(FONTS_DIR, "Montserrat-ExtraBold.ttf");

  // Presenter box (bottom-right) and waveform (mid-left) geometry.
  const bord = Math.max(4, Math.round(W * 0.004));
  const Pbw = Math.round(W * BOX_W_FRAC), Pbh = Math.round(H * BOX_H_FRAC);
  const Pbiw = Pbw - 2 * bord, Pbih = Pbh - 2 * bord;
  const margin = Math.round(W * BOX_MARGIN_FRAC);
  const X0 = W - Pbw - margin, Y0 = H - Pbh - margin;
  const Ww = Math.round(W * 0.27), Wh = Math.round(H * 0.11);
  const Wx = Math.round(W * 0.037), Wy = Math.round(H * 0.42);
  const badgeSize = Math.round(H * 0.037);

  // The full "reaction" composite. Returns the filtergraph and which stream to map
  // as audio (the waveform consumes the audio, so it is split first).
  function fullGraph() {
    let f = "";
    if (useComposite) {
      f += "[1:v]" + kenBurnsVf(dur, cfg, idx) + "[bg];";
      // Crop from the TOP (y=0), not the centre, so a tall head-to-torso portrait
      // keeps the whole head (with headroom) and is trimmed at the chest instead.
      f += "[0:v]scale=" + Pbiw + ":" + Pbih + ":force_original_aspect_ratio=increase,crop=" + Pbiw + ":" + Pbih + ":(iw-" + Pbiw + ")/2:0" +
        ",pad=" + Pbw + ":" + Pbh + ":" + bord + ":" + bord + ":color=white,setsar=1[pbox];";
      f += "[bg][pbox]overlay=" + X0 + ":" + Y0 + "[c1];";
    } else {
      f += "[1:v]" + kenBurnsVf(dur, cfg, idx) + "[c1];";
    }
    f += "[" + audioIdx + ":a]asplit=2[a_out][a_wav];";
    f += "[a_wav]showwaves=s=" + Ww + "x" + Wh + ":mode=cline:colors=white:rate=30:scale=sqrt,format=rgba,colorkey=0x000000:0.30:0.10[wave];";
    f += "[c1][wave]overlay=" + Wx + ":" + Wy + "[c2];";
    f += "[c2]drawtext=fontfile='" + ffEscapePath(badgeFont) + "':text=SUBSCRIBE:fontcolor=white:fontsize=" + badgeSize +
      ":box=1:boxcolor=0xE01B10:boxborderw=" + Math.round(badgeSize * 0.5) + ":x=" + margin + ":y=" + margin + "[c3];";
    f += "[c3]" + (subs || "null") + "[v]";
    return { filter: f, audioMap: "[a_out]" };
  }
  // Fallback used only if the full graph errors, so a scene never fails outright:
  // background + presenter box + captions, no waveform or badge.
  function simpleGraph() {
    let f = "";
    if (useComposite) {
      f += "[1:v]" + kenBurnsVf(dur, cfg, idx) + "[bg];";
      // Crop from the TOP (y=0), not the centre, so a tall head-to-torso portrait
      // keeps the whole head (with headroom) and is trimmed at the chest instead.
      f += "[0:v]scale=" + Pbiw + ":" + Pbih + ":force_original_aspect_ratio=increase,crop=" + Pbiw + ":" + Pbih + ":(iw-" + Pbiw + ")/2:0" +
        ",pad=" + Pbw + ":" + Pbh + ":" + bord + ":" + bord + ":color=white,setsar=1[pbox];";
      f += "[bg][pbox]overlay=" + X0 + ":" + Y0 + (subs ? "," + subs : "") + "[v]";
    } else {
      f += "[1:v]" + kenBurnsVf(dur, cfg, idx) + (subs ? "," + subs : "") + "[v]";
    }
    return { filter: f, audioMap: audioIdx + ":a:0" };
  }

  function build(graph) {
    const g = graph();
    return inputs.concat([
      "-filter_complex", g.filter, "-map", "[v]", "-map", g.audioMap,
      "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", crf, "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "24000", "-ac", "1", "-t", String(dur), outPath
    ]);
  }

  try {
    await run(cfg.ffmpeg, build(fullGraph));
  } catch (e) {
    cfg.log("  scene composite fell back to the simple layout (" + String(e.message).slice(0, 80) + ")");
    await run(cfg.ffmpeg, build(simpleGraph));
  }
}

// Generate the per-scene ASS caption file from that scene's word timings.
async function buildSceneCaptions(wordsFile, assPath, cfg) {
  const W = Number(cfg.width) || 1920, H = Number(cfg.height) || 1080;
  const fontSize = Math.round(H * (Number(cfg.capSizeFrac) || 0.062));
  await run(cfg.edgeCmd || "python3", [
    path.join(HERE, "captions.py"),
    wordsFile, assPath, String(W), String(H),
    path.join(FONTS_DIR, cfg.capFontFile || "Montserrat-ExtraBold.ttf"),
    cfg.capFontName || "Montserrat ExtraBold",
    String(fontSize), cfg.capHighlight || "#6A12C0",
    String(Number(cfg.capMaxWords) || 4),
    String(Number(cfg.capYFrac) || CAPTION_Y_FRAC),
    String(Number(cfg.capCxFrac) || CAPTION_CX_FRAC)
  ]);
}

// Mix looping background music UNDER a video that already has a narration track.
async function mixMusicUnder(videoWithNarration, music, total, outPath, cfg) {
  const args = ["-y", "-i", videoWithNarration, "-stream_loop", "-1", "-i", music,
    "-filter_complex", "[1:a]volume=0.3[m];[0:a][m]amix=inputs=2:duration=first:dropout_transition=0[a]",
    "-map", "0:v", "-map", "[a]", "-c:v", "copy", "-c:a", "aac", "-b:a", "160k", "-t", String(total), outPath];
  await run(cfg.ffmpeg, args);
  const st = await fs.stat(outPath).catch(() => null);
  if (!st || st.size < 1000) throw new Error("music mix produced no output");
  return outPath;
}

// Join clips with clean hard cuts, no re-encode. Scales to any number of clips.
async function fastConcat(clips, outPath, cfg) {
  // keep only clips that actually exist and are non trivial
  const good = [];
  for (const c of clips) { try { const st = await fs.stat(c); if (st.size > 1000) good.push(c); } catch (e) {} }
  if (!good.length) throw new Error("no valid clips to join");
  const listFile = path.join(path.dirname(outPath), "concat_list.txt");
  // absolute paths so the concat demuxer resolves them correctly regardless of cwd
  await fs.writeFile(listFile, good.map((c) => "file '" + path.resolve(c).replace(/'/g, "'\\''") + "'").join("\n"));
  try {
    await run(cfg.ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outPath]);
  } catch (e) {
    // fallback: re-encode on join, which tolerates any small differences between clips.
    // Keep the audio track (scene clips carry narration) so sound is never dropped.
    cfg.log("  fast join fell back to a re-encode");
    await run(cfg.ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", String(Number(cfg.crf) || 20), "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k", outPath]);
  }
  const st = await fs.stat(outPath).catch(() => null);
  if (!st || st.size < 1000) throw new Error("join produced no output");
  return outPath;
}

// Chain the clips together. Crossfades for a handful of scenes; clean hard cuts
// for many short scenes, which is fast, reliable, and the standard punchy look.
async function crossfadeConcat(clips, outPath, dur, TR, cfg) {
  if (clips.length === 1) return run(cfg.ffmpeg, ["-y", "-i", clips[0], "-c", "copy", outPath]);
  const maxXfade = Number(process.env.CF_MAX_CROSSFADE || 60);
  if (clips.length > maxXfade) return fastConcat(clips, outPath, cfg);
  const args = ["-y"];
  clips.forEach((c) => args.push("-i", c));
  let filter = "", last = "";
  for (let k = 0; k < clips.length - 1; k++) {
    const off = ((k + 1) * (dur - TR)).toFixed(3);
    const outLbl = "vx" + k;
    const inLbl = k === 0 ? "[0:v][1:v]" : "[" + last + "][" + (k + 1) + ":v]";
    filter += inLbl + "xfade=transition=fade:duration=" + TR + ":offset=" + off + "[" + outLbl + "];";
    last = outLbl;
  }
  filter = filter.replace(/;$/, "");
  args.push("-filter_complex", filter, "-map", "[" + last + "]", "-r", "30", "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p", outPath);
  try {
    await run(cfg.ffmpeg, args);
  } catch (e) {
    // if the crossfade graph ever errors, fall back to the simple, always-works join
    cfg.log("  crossfade failed, using the simple join instead");
    return fastConcat(clips, outPath, cfg);
  }
  const st = await fs.stat(outPath).catch(() => null);
  if (!st || st.size < 1000) return fastConcat(clips, outPath, cfg);
  return outPath;
}

// True only if the file has an audio stream.
function hasAudioStream(file, cfg) {
  return new Promise((res) => {
    const p = spawn(cfg.ffprobe, ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file]);
    let out = "";
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.on("error", () => res(false));
    p.on("close", () => res(out.includes("audio")));
  });
}

// Lay narration and music under the finished visuals. A narrated documentary MUST
// end up with audio, so this retries with a re-encode and then verifies the output
// truly has an audio stream. If narration cannot be attached, it throws, and the
// caller fails the video (to be retried) rather than ever saving a silent one.
async function muxAudio(video, narration, music, outPath, total, cfg) {
  function build(reencode) {
    const args = ["-y", "-i", video];
    if (narration) args.push("-i", narration);
    if (music) args.push("-stream_loop", "-1", "-i", music);
    const nIdx = narration ? 1 : null;
    const mIdx = music ? (narration ? 2 : 1) : null;
    let filter = null, audioMap = null;
    if (narration && music) {
      filter = "[" + mIdx + ":a]volume=0.35[m];[" + nIdx + ":a][m]amix=inputs=2:duration=first:dropout_transition=0[aout]";
      audioMap = "[aout]";
    } else if (narration) {
      audioMap = nIdx + ":a";
    } else if (music) {
      filter = "[" + mIdx + ":a]volume=0.5[aout]";
      audioMap = "[aout]";
    }
    if (filter) args.push("-filter_complex", filter);
    args.push("-map", "0:v");
    if (audioMap) args.push("-map", audioMap);
    args.push("-c:v", reencode ? "libx264" : "copy");
    if (reencode) args.push("-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p");
    if (audioMap) args.push("-c:a", "aac", "-b:a", "160k");
    args.push("-t", String(total), outPath);
    return args;
  }
  try {
    await run(cfg.ffmpeg, build(false));
  } catch (e) {
    cfg.log("  audio step retrying with a re-encode");
    await run(cfg.ffmpeg, build(true));
  }
  const st = await fs.stat(outPath).catch(() => null);
  if (!st || st.size < 1000) throw new Error("the audio step produced no output");
  // a narrated video with no audio is useless, so treat that as a failure
  if (narration && !(await hasAudioStream(outPath, cfg))) {
    throw new Error("the narration did not attach to the video");
  }
  return outPath;
}

// ---------- orchestration ----------
export async function renderJob(job, cfg, workDir, outFile) {
  await fs.mkdir(workDir, { recursive: true });
  // Production format is locked so CSV style/presenter overrides cannot remove
  // the required female presenter or change the Storytime composition.
  const style = "story";

  // Cut the script into scene-sized narration segments. Audio and captions are
  // time-fitted below so every resulting scene occupies exactly 5.5 seconds.
  const wps = Number(cfg.wps) || 2.4;
  const totalWords = job.script.trim().split(/\s+/).filter(Boolean).length;
  const estMinutes = totalWords / wps / 60;

  // Two tiers, decided by how long the finished video will be:
  //   Short/normal videos  -> snappier scenes at full 1080p (the batch is small
  //                           enough that a 1080p render always finishes in time).
  //   Long videos          -> slightly longer scenes and 720p, because the image
  //                           count grows with length and a huge 1080p batch can
  //                           outrun a CI time limit on a bad day.
  const HD_MAX_MIN = Number(process.env.CF_HD_MAX_MINUTES || 35);
  const isShort = estMinutes <= HD_MAX_MIN;
  const targetSec = LOCKED_SCENE_SECONDS;
  cfg.log("  ~" + estMinutes.toFixed(0) + " min video: " + (isShort
    ? "1080p, locked to " + targetSec + "s scenes"
    : "long video, 720p, locked to " + targetSec + "s scenes"));

  // Scene budget. This is the safety valve that stops very long scripts from needing
  // more images than a render can finish. Rather than CUTTING the story short, a script
  // that would overflow the budget gets LONGER scenes instead, so the whole story is
  // still told, just with each picture held a little longer. Bounded images => bounded
  // render time => a run can never grind past a CI time limit.
  const MAX_SCENES = Math.max(20, Number(process.env.CF_MAX_SCENES || 600));
  let targetWords = Math.max(3, Math.round(targetSec * wps));
  if (Math.ceil(totalWords / targetWords) > MAX_SCENES) {
    targetWords = Math.ceil(totalWords / MAX_SCENES);
    cfg.log("  long script (" + totalWords + " words): stretching scenes so the whole story fits in " + MAX_SCENES + " scenes");
  }
  let scenes = splitScript(job.script, targetWords);
  // Scenes are built from whole clauses, so they always land a little OVER the word
  // target. Measure the real average and correct once so narration needs only a
  // small timing adjustment to fit the locked 5.5-second window.
  const firstAvg = scenes.length ? totalWords / wps / scenes.length : targetSec;
  if (firstAvg > targetSec * 1.12) {
    targetWords = Math.max(3, Math.round(targetWords * (targetSec / firstAvg)));
    scenes = splitScript(job.script, targetWords);
  }
  // Then enforce the scene budget (stretch, never truncate).
  if (scenes.length > MAX_SCENES) {
    targetWords = Math.ceil(targetWords * (scenes.length / MAX_SCENES) + 1);
    scenes = splitScript(job.script, targetWords);
  }
  const avgSec = scenes.length ? (totalWords / wps / scenes.length) : targetSec;
  cfg.log("  " + scenes.length + " scenes, about " + avgSec.toFixed(1) + "s each, synced to the voice");

  // Resolution follows the same tier: full 1080p for short/normal videos, 720p for
  // long ones, so the image batch always stays small enough to finish in time.
  if (!isShort && (Number(cfg.width) || 1920) > 1280) {
    cfg = { ...cfg, width: 1280, height: 720 };
    cfg.log("  over " + HD_MAX_MIN + " min: rendering at 720p so it finishes safely");
  }

  // Storytime mode: an age-matched female presenter portrait on the left of every
  // scene, plus karaoke captions burned on.
  const storyMode = true;
  let presenter = null;
  if (storyMode) {
    const gender = "female";
    job.gender = gender;
    const presenterMatch = await installAgeMatchedPresenter(job, workDir);
    presenter = presenterMatch.path;
    job.presenterFile = presenter;
    job.presenterAge = presenterMatch.age;
    job.presenterAgeBucket = presenterMatch.label;
    job.presenterSource = "reviewed-real-camera-photo-fixed-host";
    cfg.log("  presenter: the fixed reviewed host (same woman in every video)");
  }

  const results = new Array(scenes.length).fill(null);
  const bgImage = await resolveBackgroundImage(cfg);
  if (bgImage) {
    // Fixed-background mode: every scene reuses ONE image, which the per-scene Ken
    // Burns motion turns into a smooth continuous slow zoom. This skips all
    // per-scene image generation (the main render bottleneck) and the Claude
    // character/scene-matching calls that only exist to make those images fit.
    results.fill(bgImage);
    cfg.log("  fixed background: " + path.basename(bgImage) + " reused for all " + scenes.length + " scenes (no per-scene image generation)");
  } else {
    // Character bible: keep the main characters looking the same across scenes.
    let bible = null;
    if (cfg.anthropicKey && cfg.characters !== false) {
      bible = await buildCharacterBible(job.script, cfg);
      if (bible && bible.characters.length) cfg.log("  character bible: " + bible.characters.map((c) => c.name).join(", "));
    }

    // Scene matching: turn each stretch of narration into a concrete VISUAL prompt so
    // the image matches the meaning, not the literal words. Falls back to raw text.
    let visuals = null;
    if (cfg.anthropicKey && cfg.sceneVisuals !== false) {
      visuals = await buildSceneVisuals(scenes, bible, cfg);
      if (visuals) cfg.log("  scene matching: on (" + visuals.filter(Boolean).length + "/" + scenes.length + " scenes visualized)");
    }
    // Build each scene's image prompt first (sequentially, so the character carry
    // forward stays correct), then fetch the images several at a time for speed.
    const charState = { active: null };
    const prompts = scenes.map((s, i) =>
      (visuals && visuals[i]) ? visuals[i] : (s + sceneCharacterNote(s, bible, charState)));

    const CONC = Math.max(1, Number(process.env.CF_IMG_CONCURRENCY || 2));
    let next = 0, done = 0;
    async function imgWorker() {
      while (true) {
        const i = next++;
        if (i >= scenes.length) return;
        const p = path.join(workDir, "img" + i + ".jpg");
        if (await fetchImage(buildPrompt(prompts[i], style), 3000 + i * 7, p, cfg)) results[i] = p;
        done++;
        if (done % 20 === 0 || done === scenes.length) cfg.log("  images " + done + "/" + scenes.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONC, scenes.length) }, imgWorker));

    // Regeneration pass: any scene whose image failed is generated fresh, with a NEW
    // seed each time (never a reused neighbour). Runs one at a time to be gentle on the
    // image service; later rounds fall back to 720p, which it almost never refuses, so
    // every scene ends up with its OWN generated picture.
    const repairRounds = Number(process.env.CF_IMG_REPAIR_ROUNDS || 8);
    for (let round = 1; round <= repairRounds; round++) {
      const missing = [];
      for (let i = 0; i < scenes.length; i++) if (!results[i]) missing.push(i);
      if (!missing.length) break;
      // After the first couple of rounds, drop to 720p, which the service almost never
      // refuses, so stragglers still get their own freshly generated picture quickly.
      const lowRes = round > 2 ? { width: 1280, height: 720 } : {};
      cfg.log("  regenerating " + missing.length + " image(s) (round " + round + (round > 2 ? ", 720p" : "") + ")");
      for (const i of missing) {
        const p = path.join(workDir, "img" + i + ".jpg");
        const seed = 500000 + i * 131 + round * 91193;
        // retries skip enhance for reliability
        if (await fetchImage(buildPrompt(prompts[i], style), seed, p, cfg, { ...lowRes, attempts: 4, enhance: false })) results[i] = p;
      }
    }
  }
  const imgs = results.filter(Boolean);
  if (!imgs.length) throw new Error("no images were generated");
  const stillMissing = results.filter((r) => !r).length;
  if (stillMissing) cfg.log("  note: " + stillMissing + " scene(s) could not get an image and will be skipped");

  let music = null;
  if (job.music) music = await fetchMusic(job.music, path.join(workDir, "music.bin"));
  else if (cfg.music) music = cfg.music;

  // Narrate each scene, then time-fit Ava and the word timings to exactly 5.5
  // seconds. This preserves caption sync without clipping the narration.
  const audios = new Array(scenes.length).fill(null);
  const durs = new Array(scenes.length).fill(LOCKED_SCENE_SECONDS);
  if (cfg.ttsEnabled) {
    const TCONC = Math.max(1, Number(process.env.CF_TTS_CONCURRENCY || 4));
    let tn = 0, td = 0;
    async function ttsWorker() {
      while (true) {
        const i = tn++;
        if (i >= scenes.length) return;
        // Narrate every scene. By now the regeneration pass has given each scene its
        // own image, so every narrated line has a matching, freshly generated picture.
        const ap = path.join(workDir, "voice" + i + ".mp3");
        if (await fetchTTS(scenes[i], job.voice, ap, cfg)) {
          const d = await probeDuration(ap, cfg);
          if (!d) throw new Error("Ava narration duration is invalid for scene " + (i + 1));
          const wordsFile = ap + ".words.json";
          // Natural-speed fit: returns this scene's actual length (voice + short tail).
          durs[i] = await lockNarrationDuration(ap, wordsFile, d, cfg);
          audios[i] = ap;
        }
        td++;
        if (td % 20 === 0 || td === scenes.length) cfg.log("  narration " + td + "/" + scenes.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(TCONC, scenes.length) }, ttsWorker));
  }
  const haveAudio = cfg.ttsEnabled;

  // Build one self-contained clip per scene (its OWN image + its own narration), then
  // join. Each scene uses the image generated for it; the regeneration pass above makes
  // sure that image exists, so no scene ever borrows another scene's picture.
  cfg.log("  rendering " + scenes.length + " scenes at " + (cfg.width || 1920) + "x" + (cfg.height || 1080) +
    (storyMode ? " (presenter + captions)" : ""));
  const clips = [];
  let total = 0;
  for (let i = 0; i < scenes.length; i++) {
    const img = results[i];
    if (!img) continue; // extremely rare: this one scene could not be generated, skip it
    const c = path.join(workDir, "clip" + i + ".mp4");
    try {
      if (storyMode) {
        // Build this scene's captions from its own word timings, then composite
        // presenter (left) + scene photo (right) + captions in one pass.
        let ass = null;
        const wf = audios[i] ? audios[i] + ".words.json" : null;
        if (wf && await fs.stat(wf).catch(() => null)) {
          ass = path.join(workDir, "cap" + i + ".ass");
          try { await buildSceneCaptions(wf, ass, cfg); } catch (e) { ass = null; cfg.log("  captions skipped scene " + (i + 1) + ": " + String(e.message).slice(0, 80)); }
        }
        await sceneClipComposite(presenter, img, audios[i], ass, c, durs[i], cfg, i);
      } else if (haveAudio) {
        await sceneClipWithAudio(img, audios[i], c, durs[i], cfg, i);
      } else {
        await kenBurnsClip(img, c, durs[i], cfg, i);
      }
      const st = await fs.stat(c);
      const clipDuration = await probeDuration(c, cfg);
      if (!clipDuration || Math.abs(clipDuration - durs[i]) > 0.15) {
        throw new Error("scene " + (i + 1) + " rendered at " + clipDuration + "s instead of " + durs[i].toFixed(2) + "s");
      }
      if (st.size > 1000) { clips.push(c); total += durs[i]; }
    } catch (e) {
      cfg.log("  scene clip " + (i + 1) + " skipped: " + String(e.message).slice(0, 90));
    }
  }
  if (!clips.length) throw new Error("no clips were rendered");
  if (clips.length !== scenes.length) {
    throw new Error("only " + clips.length + "/" + scenes.length + " locked 5.5-second scenes rendered");
  }

  if (haveAudio) {
    // Each clip already carries its own narration, so a plain hard-cut join keeps the
    // voice perfectly in sync. Then mix any background music under the whole thing.
    const joined = music ? path.join(workDir, "joined.mp4") : outFile;
    await fastConcat(clips, joined, cfg);
    if (music) await mixMusicUnder(joined, music, total, outFile, cfg);
    if (!(await hasAudioStream(outFile, cfg))) throw new Error("the narration did not attach to the video");
  } else {
    // No narration: use gentle crossfades and lay any music underneath.
    const silent = path.join(workDir, "silent.mp4");
    await crossfadeConcat(clips, silent, durs[0] || targetSec, 0.6, cfg);
    if (music) await muxAudio(silent, null, music, outFile, total, cfg);
    else await fs.copyFile(silent, outFile);
  }

  // Every production video must have the matching female-presenter thumbnail.
  const thumbFile = outFile.replace(/\.(mp4|webm)$/i, "-thumbnail.jpg");
  const thumbnail = await buildThumbnail(job, cfg, workDir, thumbFile, { fetchImage, run });
  if (!thumbnail) throw new Error("required female-presenter thumbnail was not created");
  job.thumbnailFile = thumbFile;
  cfg.log("  thumbnail: " + path.basename(thumbFile) + " (same female presenter)");

  return outFile;
}
