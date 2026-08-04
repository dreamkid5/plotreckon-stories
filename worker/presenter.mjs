// Production uses reviewed real-camera portraits instead of generating a new
// presenter through the scene-image service. This prevents stylized, CGI, anime,
// plastic-skinned, or doll-like people from ever reaching a video or thumbnail.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PRESENTER_DIR = path.join(HERE, "assets", "presenters");

export const PRESENTER_ASSETS = Object.freeze({
  20: path.join(PRESENTER_DIR, "presenter-age-20s.jpg"),
  30: path.join(PRESENTER_DIR, "photorealistic-female-presenter.jpg"),
  40: path.join(PRESENTER_DIR, "presenter-age-40s.jpg"),
  50: path.join(PRESENTER_DIR, "presenter-age-50s.jpg"),
  60: path.join(PRESENTER_DIR, "presenter-age-60s.jpg"),
  70: path.join(PRESENTER_DIR, "presenter-age-70s.jpg"),
  80: path.join(PRESENTER_DIR, "presenter-age-80s.jpg"),
  90: path.join(PRESENTER_DIR, "presenter-age-90s.jpg")
});

// Backward-compatible export for callers that need the reviewed 30s portrait.
export const PHOTOREALISTIC_PRESENTER_ASSET = PRESENTER_ASSETS[30];

const ONES = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9
});
const TEENS = Object.freeze({
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19
});
const TENS = Object.freeze({
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
});

function parseAgeValue(raw) {
  const value = String(raw || "").trim().toLowerCase();
  if (/^\d{1,3}$/.test(value)) return Number(value);

  const words = value.split(/[\s-]+/).filter(Boolean);
  if (words.length === 1) return TEENS[words[0]] ?? TENS[words[0]] ?? ONES[words[0]] ?? null;
  if (words.length === 2 && TENS[words[0]] && ONES[words[1]]) {
    return TENS[words[0]] + ONES[words[1]];
  }
  return null;
}

export function extractNarratorAge(script) {
  const text = String(script || "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2010-\u2015]/g, "-")
    .toLowerCase();

  // Only present-tense first-person declarations are accepted. Recollections such
  // as "I was twenty five" and other characters' ages must not choose the portrait.
  const statedAge = /\bi\s*(?:am|'m)\s+(?:a\s+)?(\d{1,3}|[a-z]+(?:[\s-]+[a-z]+)?)\s*(?:-\s*)?years?\s*(?:-\s*)?old\b/i.exec(text);
  const shortNumericAge = /\bi\s*(?:am|'m)\s+(\d{2})\b/i.exec(text);
  const rawAge = statedAge?.[1] ?? shortNumericAge?.[1];
  const age = parseAgeValue(rawAge);
  return Number.isInteger(age) && age >= 18 && age <= 99 ? age : null;
}

export function selectPresenterForAge(age) {
  if (!Number.isInteger(age) || age < 18 || age > 99) {
    throw new Error("narrator age must be an adult age from 18 to 99");
  }

  const decade = Math.max(20, Math.floor(age / 10) * 10);
  return {
    age,
    decade,
    label: `${decade}s`,
    assetPath: PRESENTER_ASSETS[decade]
  };
}

export async function installAgeMatchedPresenter(job, workDir) {
  const age = extractNarratorAge(job?.script);
  if (age == null) {
    throw new Error(
      "narrator age is not stated: add a current-age sentence such as " +
      "\"I am 34 years old\" so the presenter can match the script"
    );
  }

  const selection = selectPresenterForAge(age);
  const source = await fs.stat(selection.assetPath).catch(() => null);
  if (!source || !source.isFile() || source.size < 100000) {
    throw new Error(`reviewed photorealistic female presenter asset for ${selection.label} is missing or invalid`);
  }

  const outPath = path.join(workDir, "presenter.jpg");
  await fs.copyFile(selection.assetPath, outPath);
  return { ...selection, path: outPath };
}
