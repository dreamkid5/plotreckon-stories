// Production uses a reviewed real-camera portrait instead of generating a new
// presenter through the scene-image service. This prevents stylized, CGI, anime,
// plastic-skinned, or doll-like people from ever reaching a video or thumbnail.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const PHOTOREALISTIC_PRESENTER_ASSET = path.join(
  HERE,
  "assets",
  "presenters",
  "photorealistic-female-presenter.jpg"
);

export async function installPhotorealisticPresenter(workDir) {
  const source = await fs.stat(PHOTOREALISTIC_PRESENTER_ASSET).catch(() => null);
  if (!source || !source.isFile() || source.size < 100000) {
    throw new Error("reviewed photorealistic female presenter asset is missing or invalid");
  }
  const outPath = path.join(workDir, "presenter.jpg");
  await fs.copyFile(PHOTOREALISTIC_PRESENTER_ASSET, outPath);
  return outPath;
}
