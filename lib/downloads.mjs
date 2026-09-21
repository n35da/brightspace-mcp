import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DOWNLOAD_DIR = path.join(__dirname, "..", "downloads");

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
}

/** Save a downloaded file's bytes to the project's downloads/ folder, prefixed
 * with its D2L id so repeat downloads of the same file overwrite cleanly and
 * different files never collide. Returns the absolute saved path. */
export async function saveDownload(buffer, suggestedName, id) {
  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const base = sanitizeFilename(suggestedName || `file-${id}`);
  const filename = id != null ? `${id}_${base}` : base;
  const fullPath = path.join(DOWNLOAD_DIR, filename);
  await writeFile(fullPath, buffer);
  return fullPath;
}
