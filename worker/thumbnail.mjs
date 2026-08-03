// Automatic thumbnail generation.
// Storytime look (matches the reference the user gave): the SAME presenter photo from
// the video on the RIGHT, and the story's hook on the LEFT in bold Montserrat ExtraBold
// with each clause in a punchy colour. Drawn by thumbnail.py (Pillow) — all free.
// If Pillow/the presenter are unavailable, falls back to the older ffmpeg design.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { styleKeywords, buildPrompt } from "./csv.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONTS_DIR = path.join(HERE, "assets", "fonts");
const MONTSERRAT = path.join(FONTS_DIR, "Montserrat-ExtraBold.ttf");
// Anton: a heavy condensed display font, used only by the legacy fallback.
const ANTON = path.join(FONTS_DIR, "Anton-Regular.ttf");

export const THUMBNAIL_HOOK_MIN_WORDS = 28;
export const THUMBNAIL_HOOK_MAX_WORDS = 46;

const normaliseHook = (value) => String(value || "").replace(/\s+/g, " ").trim();
const hookWordCount = (value) => normaliseHook(value).split(" ").filter(Boolean).length;

// The reference format uses a substantial story hook rather than a short headline.
// An explicit hook always leads. If it is short, continue into the script; if no hook
// was supplied, use the script's opening. End on a sentence boundary between 28 and
// 46 words whenever possible, matching the dense reference-thumbnail rhythm.
export function makeHook(job) {
  const explicit = normaliseHook(job.hook);
  const script = normaliseHook(job.script);
  const title = normaliseHook(job.title);
  let source = explicit || script || title;
  if (explicit && hookWordCount(explicit) < THUMBNAIL_HOOK_MIN_WORDS && script) {
    source = script.toLowerCase().startsWith(explicit.toLowerCase())
      ? script
      : explicit + " " + script;
  }
  if (!source) return "";

  const sentences = source.match(/[^.!?…]+[.!?…]+(?:["'”’])?(?=\s|$)/g);
  if (sentences) {
    let acc = "";
    for (const s of sentences) {
      const next = (acc ? acc + " " : "") + s.trim();
      if (hookWordCount(next) > THUMBNAIL_HOOK_MAX_WORDS) break;
      acc = next;
      if (hookWordCount(acc) >= THUMBNAIL_HOOK_MIN_WORDS) return acc;
    }
  }

  const words = source.split(" ");
  if (words.length > THUMBNAIL_HOOK_MAX_WORDS) {
    return words.slice(0, THUMBNAIL_HOOK_MAX_WORDS).join(" ").replace(/[,:;—-]+$/, "") + "...";
  }
  return source;
}

// The reference-style thumbnail: presenter on the right, coloured hook on the left.
async function buildStoryThumbnail(job, cfg, workDir, outFile, deps) {
  if (!fs.existsSync(MONTSERRAT)) return null;

  // The thumbnail must reuse the exact female presenter from the video.
  const portrait = job.presenterFile && fs.existsSync(job.presenterFile) ? job.presenterFile : null;
  if (!portrait) throw new Error("the video's female presenter is missing");

  const hook = makeHook(job);
  if (!hook) return null;
  const scriptWords = hookWordCount(job.script);
  const hookWords = hookWordCount(hook);
  if (scriptWords >= THUMBNAIL_HOOK_MIN_WORDS && hookWords < THUMBNAIL_HOOK_MIN_WORDS) {
    throw new Error("thumbnail hook was too short for the wordy reference format");
  }
  cfg.log("  thumbnail hook: " + hookWords + " words from the catchy story opening");

  await deps.run(cfg.edgeCmd || "python3", [
    path.join(HERE, "thumbnail.py"),
    portrait, hook, outFile, "1280", "720", MONTSERRAT
  ]);
  return fs.existsSync(outFile) ? outFile : null;
}

export async function buildThumbnail(job, cfg, workDir, outFile, deps) {
  // Production requires the exact presenter from the video. Never fall back to
  // an unrelated portrait or generic dramatic thumbnail.
  return buildStoryThumbnail(job, cfg, workDir, outFile, deps);
}

// ---------------------------------------------------------------------------
// Legacy fallback: a fresh dramatic image with a short bold headline.
// ---------------------------------------------------------------------------
function extractJSON(text) {
  if (!text) return null;
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch (x) { return null; }
}

async function thumbnailPlan(job, cfg) {
  if (!cfg.anthropicKey) return null;
  const prompt =
    "You are designing a YouTube thumbnail for this video. Return ONLY JSON: " +
    '{"headline":"...","imagePrompt":"..."}\n' +
    "- headline: 2 to 4 punchy UPPERCASE words that spark curiosity. This text goes large on the thumbnail. No punctuation, no dash character.\n" +
    "- imagePrompt: one vivid, dramatic single scene that captures the hook of the video, described for an illustrator. One clear subject, strong emotion or action, close or medium shot, no text in the image.\n\n" +
    "Base both on this script:\n" + (job.script || job.title || "").slice(0, 5000);
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "x-api-key": cfg.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: cfg.seoModel, max_tokens: 400, messages: [{ role: "user", content: prompt }] })
      });
      if (r.status === 429 || r.status === 529) { await new Promise((s) => setTimeout(s, 4000 * (a + 1))); continue; }
      if (!r.ok) return null;
      const j = await r.json();
      const data = extractJSON(j && j.content && j.content[0] && j.content[0].text);
      if (!data) return null;
      return { headline: String(data.headline || "").trim(), imagePrompt: String(data.imagePrompt || "").trim() };
    } catch (e) { await new Promise((s) => setTimeout(s, 2500 * (a + 1))); }
  }
  return null;
}

function findFont(cfg) {
  const list = [
    cfg.font, ANTON,
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf"
  ].filter(Boolean);
  for (const f of list) { try { if (fs.existsSync(f)) return f; } catch (e) {} }
  return null;
}

function toLines(headline, title) {
  let h = (headline || "").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!h) h = (title || "VIDEO").toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 4).join(" ");
  const words = h.split(" ").filter(Boolean).slice(0, 5);
  if (words.length <= 2 || h.length <= 12) return [words.join(" ")];
  let best = 1, bestDiff = 1e9;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(" ").length, b = words.slice(i).join(" ").length;
    if (Math.abs(a - b) < bestDiff) { bestDiff = Math.abs(a - b); best = i; }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

async function buildLegacyThumbnail(job, cfg, workDir, outFile, deps) {
  const plan = await thumbnailPlan(job, cfg);
  const style = styleKeywords[job.style] ? job.style : cfg.style;
  const subject = (plan && plan.imagePrompt) || job.title || (job.script || "").slice(0, 120);
  const imgPrompt = buildPrompt(subject + ", dramatic, cinematic, bold, high contrast, striking, eye catching", style);
  const src = path.join(workDir, "thumb_src.jpg");
  if (!(await deps.fetchImage(imgPrompt, 9182, src, cfg))) return null;

  const lines = toLines(plan && plan.headline, job.title);
  const font = findFont(cfg);
  const maxLen = Math.max(...lines.map((l) => l.length));
  const fontsize = maxLen <= 10 ? 122 : maxLen <= 16 ? 100 : maxLen <= 22 ? 82 : 66;
  const lh = Math.round(fontsize * 1.14);
  const gradStart = 720 - (lines.length > 1 ? 340 : 240);

  let fc = "[1]format=rgba,geq=r=0:g=0:b=0:a='min(235,max(0,235*(Y-" + gradStart + ")/" + (720 - gradStart) + "))'[g];";
  fc += "[0:v]scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720[v];";
  fc += "[v][g]overlay=format=auto";
  if (font && lines.length) {
    const draws = lines.map((ln, i) => {
      const fromBottom = 56 + (lines.length - 1 - i) * lh + fontsize;
      return "drawtext=fontfile='" + font + "':text='" + ln + "':fontcolor=white:fontsize=" + fontsize +
        ":borderw=9:bordercolor=black:shadowcolor=black@0.5:shadowx=5:shadowy=7:x=(w-text_w)/2:y=h-" + fromBottom;
    });
    fc += "," + draws.join(",");
  }
  fc += "[out]";
  await deps.run(cfg.ffmpeg, ["-y", "-i", src, "-f", "lavfi", "-i", "color=black:s=1280x720", "-filter_complex", fc, "-map", "[out]", "-frames:v", "1", "-update", "1", "-q:v", "3", outFile]);
  return fs.existsSync(outFile) ? outFile : null;
}
