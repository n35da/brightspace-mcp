// Optional per-institution config, read from config.json next to
// package.json (or BRIGHTSPACE_CONFIG_PATH, so tests never touch the real
// file). Two settings: which Brightspace instance to talk to, and which
// enrollments to keep (D2L's "active enrollment" flag doesn't mean "current
// term", so without a course filter every enrollment ever made shows up).
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.BRIGHTSPACE_CONFIG_PATH || path.join(__dirname, "..", "config.json");

function isValidBaseUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

export async function loadConfig() {
  if (!existsSync(CONFIG_PATH)) return { d2lBaseUrl: null, courseCodes: [] };
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
    return {
      d2lBaseUrl: isValidBaseUrl(raw.d2lBaseUrl) ? raw.d2lBaseUrl.replace(/\/+$/, "") : null,
      courseCodes: Array.isArray(raw.courseCodes) ? raw.courseCodes : [],
    };
  } catch {
    return { d2lBaseUrl: null, courseCodes: [] };
  }
}

export async function writeConfig({ d2lBaseUrl, courseCodes }) {
  const payload = {
    _comment:
      "list_courses (and everything built on it) only returns courses whose D2L code contains one of these, ignoring spaces/dashes/case. Clear the array to see every enrollment D2L returns, old ones included. Update this each term.",
    d2lBaseUrl,
    courseCodes: courseCodes ?? [],
  };
  await writeFile(CONFIG_PATH, JSON.stringify(payload, null, 2) + "\n", "utf8");
  return CONFIG_PATH;
}

/** Confirm baseUrl actually points at a Brightspace instance by hitting its
 * public, unauthenticated version-discovery endpoint — catches typos and
 * non-Brightspace URLs during setup instead of failing confusingly later
 * during login. Never throws: network errors just mean "not reachable". */
export async function checkBrightspaceUrl(baseUrl, fetchImpl = fetch) {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/d2l/api/versions/`);
    return !!res.ok;
  } catch {
    return false;
  }
}
