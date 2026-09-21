// End-to-end MCP test: spawn the real server.mjs with no saved session but
// saved credentials, point it at a fake MSU, and confirm that (a) the
// reauthenticate tool exists, (b) a tool call that would normally die with
// SessionExpiredError transparently auto-heals by logging in headlessly and
// retrying, and (c) the reauthenticate tool itself reports success.
import { spawn } from "node:child_process";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeMsu, saveCredsFile } from "./fake-msu.mjs";

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

const root = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-autoheal-"));
const stateDir = path.join(root, "state");
await mkdir(stateDir, { recursive: true });
const fake = await startFakeMsu();
await saveCredsFile(stateDir);

const child = spawn(process.execPath, [path.join(__dirname, "..", "server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    MSU_D2L_SESSION_DIR: stateDir,
    D2L_BASE_URL: fake.baseUrl,
  },
});
child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

let buf = "";
const responses = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) responses.push(JSON.parse(line));
  }
});
const send = (msg) => child.stdin.write(JSON.stringify(msg) + "\n");
const waitFor = (id, timeoutMs = 90_000) =>
  new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = responses.find((r) => r.id === id);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`timed out waiting for id=${id}`));
      setTimeout(check, 50);
    };
    check();
  });

const callTool = async (id, name, args = {}) => {
  send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return waitFor(id);
};

try {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "autoheal-test", version: "0.0.1" } },
  });
  await waitFor(1);
  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResp = await waitFor(2);
  const names = (toolsResp.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("reauthenticate"), "reauthenticate tool is registered");

  // No session.json exists — the old server would return SessionExpiredError.
  // With auto-heal it should log in headlessly (password path, since the
  // browser profile is empty) and answer with real course data.
  const call = await callTool(3, "list_courses");
  const text = call.result?.content?.[0]?.text ?? "";
  assert(call.result?.isError !== true, `list_courses auto-healed instead of failing (got: ${text.slice(0, 200)})`);
  assert(text.includes("CSE425"), "auto-healed response carries real course data");

  // The explicit tool reports its own success too.
  const reauth = await callTool(4, "reauthenticate");
  const reauthText = reauth.result?.content?.[0]?.text ?? "";
  assert(reauth.result?.isError !== true, `reauthenticate tool succeeds (got: ${reauthText.slice(0, 200)})`);
  assert(reauthText.includes('"ok": true'), "reauthenticate result announces ok:true");
  assert(!reauthText.includes("hunter2"), "reauthenticate result never leaks the password");
} finally {
  child.kill();
  fake.close();
  await rm(root, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
