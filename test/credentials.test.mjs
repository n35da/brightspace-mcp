// Tests lib/credentials.mjs (save/load of NetID credentials) plus the
// MSU_D2L_SESSION_DIR env override on lib/d2lClient.mjs, which lets every
// test isolate itself in a temp dir instead of touching the real
// ~/.msu-d2l-mcp (which holds a live session — never delete it).
import { mkdtemp, rm, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("ok:", msg);
  }
};

// Set the override BEFORE importing the libs — SESSION_DIR is computed at
// module load time, so this has to happen first.
const dir = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-test-"));
process.env.MSU_D2L_SESSION_DIR = dir;
const { SESSION_DIR, SESSION_FILE } = await import("../lib/d2lClient.mjs");
const { saveCredentials, loadCredentials, CREDENTIALS_FILE } = await import("../lib/credentials.mjs");

try {
  assert(SESSION_DIR === dir, "MSU_D2L_SESSION_DIR overrides SESSION_DIR");
  assert(SESSION_FILE === path.join(dir, "session.json"), "SESSION_FILE lives under the override dir");
  assert(CREDENTIALS_FILE === path.join(dir, "credentials.json"), "CREDENTIALS_FILE lives under the override dir");

  // Roundtrip.
  assert((await loadCredentials()) === null, "loadCredentials returns null when no file exists");
  await saveCredentials({ username: "aden@msu.edu", password: "hunter2" });
  const loaded = await loadCredentials();
  assert(loaded?.username === "aden@msu.edu", "roundtrips username");
  assert(loaded?.password === "hunter2", "roundtrips password");
  assert(typeof loaded?.savedAt === "number", "stamps savedAt");

  // Corrupt file -> null, not a crash.
  await writeFileRaw(CREDENTIALS_FILE, "{not json");
  assert((await loadCredentials()) === null, "corrupt credentials file reads as null");

  // Saved with restrictive perms where the OS supports it (chmod is a no-op on Windows).
  await saveCredentials({ username: "a", password: "b" });
  if (process.platform !== "win32") {
    const mode = (await stat(CREDENTIALS_FILE)).mode & 0o777;
    assert(mode === 0o600, `credentials file mode is 0600 (got ${mode.toString(8)})`);
  }
  const raw = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
  assert(raw.password === "b", "file on disk holds the plaintext the user asked for (plain JSON storage)");
} finally {
  await rm(dir, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);

async function writeFileRaw(file, text) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(file, text);
}
