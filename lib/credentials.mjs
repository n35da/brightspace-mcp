// Storage for the NetID username/password used by the automated re-login
// flow. The user explicitly opted for a plain JSON file (same trust level as
// the session cookies in session.json), so this is deliberately simple: read,
// write, 0600 where the OS honors it. Nothing here ever logs the password.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { SESSION_DIR } from "./d2lClient.mjs";

import path from "node:path";

export const CREDENTIALS_FILE = path.join(SESSION_DIR, "credentials.json");

/** Returns { username, password, savedAt } or null if missing/corrupt. */
export async function loadCredentials() {
  if (!existsSync(CREDENTIALS_FILE)) return null;
  try {
    const creds = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
    if (!creds?.username || !creds?.password) return null;
    return creds;
  } catch {
    return null;
  }
}

export async function saveCredentials({ username, password }) {
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  await writeFile(CREDENTIALS_FILE, JSON.stringify({ username, password, savedAt: Date.now() }, null, 2), {
    mode: 0o600,
  });
}
