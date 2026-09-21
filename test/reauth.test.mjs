// Exercises lib/reauth.mjs (the headless automated re-login) against the
// shared fake MSU SSO + D2L server (identifier-first Okta-style flow):
// password fallback on a clean profile, silent SSO-cookie re-login once the
// profile holds SSO trust, and the failure modes (no saved credentials,
// wrong password, Duo challenge).
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Isolate all persisted state in a temp dir BEFORE importing the libs.
const root = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-reauth-"));
process.env.MSU_D2L_SESSION_DIR = path.join(root, "state");
const { saveSession, SESSION_FILE } = await import("../lib/d2lClient.mjs");
const { saveCredentials } = await import("../lib/credentials.mjs");
const { reauthenticate } = await import("../lib/reauth.mjs");
const { startFakeMsu, saveCredsFile, USERNAME, PASSWORD } = await import("./fake-msu.mjs");

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("ok:", msg);
  }
};

async function sessionSnapshot() {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

async function main() {
  await mkdir(path.dirname(SESSION_FILE), { recursive: true });
  const fake = await startFakeMsu();
  const baseUrl = fake.baseUrl;
  const { state: fakeState } = fake;

  const freshProfile = async () => {
    const dir = path.join(root, `profile-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    return dir;
  };

  // Wipe everything a previous scenario persisted so failure-mode scenarios
  // can assert "nothing was saved".
  const { unlink } = await import("node:fs/promises");
  const clearState = () =>
    Promise.all([unlink(SESSION_FILE), unlink(path.join(root, "state/credentials.json"))].map((p) => p.catch(() => {})));

  // 1. Password fallback: clean profile + saved credentials -> full login.
  const profile1 = await freshProfile();
  await saveCredentials({ username: USERNAME, password: PASSWORD });
  const r1 = await reauthenticate({ baseUrl, profileDir: profile1 });
  assert(r1.ok === true, "reauth with saved credentials succeeds");
  assert(r1.how === "password", "reports the password path");
  const s1 = await sessionSnapshot();
  assert(s1?.baseUrl === baseUrl, "saved session records the baseUrl");
  assert(s1?.cookieHeader?.includes("d2lSessionVal="), "saved session holds d2lSessionVal cookie");
  assert(s1?.cookieHeader?.includes("d2lSecureSessionVal="), "saved session holds d2lSecureSessionVal cookie");
  assert(s1?.csrfToken === `xsrf-${s1?.cookieHeader?.match(/d2lSessionVal=v(\d+)/)?.[1]}`, "saved CSRF token matches the page");
  assert(s1?.accessToken === `tok-v${s1?.cookieHeader?.match(/d2lSessionVal=v(\d+)/)?.[1]}`, "access token minted from the fresh session");
  assert(fakeState.formSubmits === 2, "exactly two form submissions happened (identifier, then password)");

  // 2. Silent path: same profile now holds SSO trust; wipe session.json and
  //    re-authenticate must NOT touch the login form.
  await clearState();
  const submitsBefore = fakeState.formSubmits;
  const r2 = await reauthenticate({ baseUrl, profileDir: profile1 });
  assert(r2.ok === true, "silent reauth with a trusted profile succeeds");
  assert(r2.how === "sso", "reports the SSO (no password) path");
  assert(fakeState.formSubmits === submitsBefore, "login form never submitted on the silent path");
  assert((await sessionSnapshot()) !== null, "fresh session saved on the silent path");

  // 3. No credentials saved, clean profile -> clean failure, nothing saved.
  await clearState();
  const profile3 = await freshProfile();
  const r3 = await reauthenticate({ baseUrl, profileDir: profile3 });
  assert(r3.ok === false, "reauth without saved credentials fails");
  assert(/credential/i.test(r3.reason ?? ""), `failure reason names credentials (got: ${r3.reason})`);
  assert((await sessionSnapshot()) === null, "no session saved on failure");

  // 4. Wrong password -> clean failure, nothing saved.
  await clearState();
  await saveCredentials({ username: USERNAME, password: "wrong" });
  const profile4 = await freshProfile();
  const r4 = await reauthenticate({ baseUrl, profileDir: profile4 });
  assert(r4.ok === false, "reauth with a wrong password fails");
  assert(/password|login/i.test(r4.reason ?? ""), `failure reason blames the login (got: ${r4.reason})`);
  assert((await sessionSnapshot()) === null, "no session saved on wrong password");

  // 5. Duo challenge after correct credentials -> clean failure naming Duo.
  fakeState.duoMode = true;
  await clearState();
  await saveCredentials({ username: USERNAME, password: PASSWORD });
  const profile5 = await freshProfile();
  const r5 = await reauthenticate({ baseUrl, profileDir: profile5 });
  assert(r5.ok === false, "reauth stops at a Duo challenge");
  assert(/duo/i.test(r5.reason ?? ""), `failure reason names Duo (got: ${r5.reason})`);
  assert(fakeState.duoChallenges === 1, "Duo challenge was actually reached");
  assert((await sessionSnapshot()) === null, "no session saved when stopped at Duo");

  await fake.close();
  await rm(root, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error("Test crashed:", err);
  await rm(root, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
});
