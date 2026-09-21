// Validates lib/d2lClient.mjs against a fake D2L server, covering the
// trickiest logic: version discovery, cookie->token minting, and treating an
// HTTP-200 "session expired" HTML stub as if it were a 401 (which is how a
// dead D2L session actually behaves per the real API's documented quirk).
import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// MUST be set before the lib import (SESSION_DIR is computed at module load).
// This test wipes its session dir at startup — pointing at the real
// ~/.msu-d2l-mcp would delete the user's live session, profile, and saved
// credentials. (It did exactly that once. Never again.)
process.env.MSU_D2L_SESSION_DIR = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-mockd2l-"));
const { D2LClient, saveSession, SESSION_DIR } = await import("../lib/d2lClient.mjs");
if (!SESSION_DIR.includes("msu-d2l-mcp-mockd2l-")) {
  console.error("FATAL: mock-d2l is not sandboxed, refusing to run (would touch " + SESSION_DIR + ")");
  process.exit(1);
}

let mintCount = 0;
let sessionDead = false; // toggled mid-test to simulate expiry

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/d2l/api/versions/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.55" }, { ProductCode: "le", LatestVersion: "1.90" }]));
    return;
  }
  if (url.pathname === "/d2l/lp/auth/oauth2/token" && req.method === "POST") {
    mintCount++;
    if (sessionDead) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<script>location.replace("/d2l/login?sessionExpired=1")</script>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ access_token: `fake-token-${mintCount}` }));
    return;
  }
  if (url.pathname === "/d2l/api/lp/1.55/enrollments/myenrollments/") {
    const auth = req.headers.authorization;
    if (sessionDead || auth !== `Bearer fake-token-${mintCount}`) {
      // stale/rejected token -> the real API answers 200 with an HTML stub, not 401
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<script>location.replace("/d2l/login?sessionExpired=1")</script>`);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ Items: [{ OrgUnit: { Id: 12345, Code: "CSE425", Name: "Intro to Computer Security" }, Access: { IsActive: true } }] }));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  await saveSession({ baseUrl, cookieHeader: "d2lSessionVal=abc; d2lSecureSessionVal=def", csrfToken: "xsrf123" });

  let failed = false;
  const assert = (cond, msg) => {
    if (!cond) {
      console.error("FAIL:", msg);
      failed = true;
    } else {
      console.log("ok:", msg);
    }
  };

  // 1. Fresh client mints a token on first call and gets real data.
  const client1 = await D2LClient.fromSavedSession();
  const courses = await client1.get((c) => c.lp("/enrollments/myenrollments/"));
  assert(mintCount === 1, "first call minted exactly one token");
  assert(courses.Items?.[0]?.OrgUnit?.Code === "CSE425", "parsed course data correctly");

  // 2. Simulate the access token going stale server-side (server now rejects
  //    the previously-minted token by only accepting the *next* mint count).
  //    This forces client.get() to detect the "expired" HTML stub and
  //    transparently re-mint once, without the caller doing anything.
  const priorMint = mintCount;
  // Force a mismatch: bump nothing, just have the server require mintCount+1
  // by pretending the cached token is wrong. We simulate this by clearing
  // the client's cached token so it must ask the server fresh, and by
  // wiping the saved file's accessToken so a *new* process would also remint.
  client1.accessToken = "stale-token-that-server-will-reject";
  const courses2 = await client1.get((c) => c.lp("/enrollments/myenrollments/"));
  assert(mintCount === priorMint + 1, "stale token triggered exactly one re-mint");
  assert(courses2.Items?.[0]?.OrgUnit?.Code === "CSE425", "parsed course data correctly after re-mint");

  // 3. Simulate the underlying D2L session itself being fully dead (not just
  //    a stale bearer token) — every mint attempt now returns the expired
  //    stub. get() should give up after one retry and throw SessionExpiredError,
  //    not loop forever.
  sessionDead = true;
  client1.accessToken = null;
  let threw = false;
  try {
    await client1.get((c) => c.lp("/enrollments/myenrollments/"));
  } catch (err) {
    threw = err.name === "SessionExpiredError";
  }
  assert(threw, "fully dead session raises SessionExpiredError instead of looping");

  // Stop listening, then let the event loop drain instead of calling
  // process.exit — exiting while undici's keep-alive machinery is still
  // alive trips a libuv assertion on Windows.
  server.close(() => {});
  process.exitCode = failed ? 1 : 0;
}

main();
