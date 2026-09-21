// End-to-end check of auth.mjs itself (headless, against the fake MSU):
// pre-trust a browser profile via the automated re-login, then run the real
// auth.mjs script — it should auto-SSO straight to the D2L home, harvest the
// session, and honor an interactive-looking "y" answer by saving credentials.
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeMsu, USERNAME, PASSWORD } from "./fake-msu.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("ok:", msg);
  }
};

const root = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-authflow-"));
const stateDir = path.join(root, "state");
const fake = await startFakeMsu();

// MUST happen before any lib/* import: SESSION_DIR/PROFILE_DIR are computed
// at module load, and pointing them at the real ~/.msu-d2l-mcp from a test
// would clobber the user's live session.
process.env.MSU_D2L_SESSION_DIR = stateDir;
const { reauthenticate } = await import("../lib/reauth.mjs");
const { saveCredentials, CREDENTIALS_FILE } = await import("../lib/credentials.mjs");
const { SESSION_FILE } = await import("../lib/d2lClient.mjs");

// Belt and braces: refuse to run if the libs escaped the sandbox.
assert(SESSION_FILE.startsWith(stateDir), `SESSION_FILE is sandboxed (${SESSION_FILE})`);
assert(CREDENTIALS_FILE.startsWith(stateDir), `CREDENTIALS_FILE is sandboxed (${CREDENTIALS_FILE})`);

// 1. Pre-trust the profile: one automated (password-path) login plants the
//    persistent SSO cookie that auth.mjs's silent SSO ride depends on.
await saveCredentials({ username: USERNAME, password: PASSWORD });
const seed = await reauthenticate({ baseUrl: fake.baseUrl });
assert(seed.ok === true, `profile seeded via automated login (got: ${JSON.stringify(seed)})`);
const { unlink } = await import("node:fs/promises");
await unlink(SESSION_FILE).catch(() => {});
await unlink(CREDENTIALS_FILE).catch(() => {});

// 2. Run the real auth.mjs. Its stdin gets the answers a user would type:
//    "y", then username, then password.
const child = spawn(process.execPath, [path.join(__dirname, "..", "auth.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, MSU_D2L_SESSION_DIR: stateDir, D2L_BASE_URL: fake.baseUrl, D2L_AUTH_HEADLESS: "1" },
});
let out = "";
child.stdout.on("data", (d) => (out += d.toString()));
child.stderr.on("data", (d) => (out += d.toString()));
const answers = ["y\n", `${USERNAME}\n`, `${PASSWORD}\n`];
let sent = 0;
const drip = setInterval(() => {
  if (sent < answers.length) child.stdin.write(answers[sent++]);
  else clearInterval(drip);
}, 1500);

const code = await new Promise((resolve) => child.on("close", resolve));
clearInterval(drip);

assert(code === 0, `auth.mjs exits 0 (exit code ${code})`);
if (code !== 0) console.error("--- auth.mjs output ---\n" + out + "\n-----------------------");
assert(out.includes("Session saved"), "auth.mjs reports the session was saved");
assert(out.includes("Access token verified working"), "auth.mjs minted + verified an access token");
assert(out.includes("Saved to"), "auth.mjs saved the credentials after the y answer");
const saved = JSON.parse(await readFile(CREDENTIALS_FILE, "utf8"));
assert(saved.username === USERNAME && saved.password === PASSWORD, "credentials file holds what was typed");
assert(!out.includes(PASSWORD), "auth.mjs output never echoes the password");

fake.close();
await rm(root, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
