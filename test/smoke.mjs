// Smoke test: spawn server.mjs and speak MCP over stdio to confirm it starts
// and exposes the expected tools. Does NOT require a live D2L session.
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(__dirname, "..", "server.mjs");

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  // Isolate state (never touch the real ~/.msu-d2l-mcp) and point D2L at a
  // dead port so any auto-heal attempt fails fast instead of browsing the web.
  env: { ...process.env, MSU_D2L_SESSION_DIR: path.join(__dirname, ".smoke-state"), D2L_BASE_URL: "http://127.0.0.1:9" },
});

let buf = "";
const responses = [];
child.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (line.trim()) {
      try {
        responses.push(JSON.parse(line));
      } catch {
        console.error("Non-JSON line from server:", line);
      }
    }
  }
});
child.stderr.on("data", (d) => process.stderr.write(`[server stderr] ${d}`));

function send(msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function waitFor(id, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      const found = responses.find((r) => r.id === id);
      if (found) return resolve(found);
      if (Date.now() - start > timeoutMs) return reject(new Error(`Timed out waiting for response id=${id}`));
      setTimeout(check, 50);
    };
    check();
  });
}

async function main() {
  send({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.1" },
    },
  });
  const initResp = await waitFor(1);
  console.log("initialize OK, server:", JSON.stringify(initResp.result?.serverInfo));

  send({ jsonrpc: "2.0", method: "notifications/initialized" });

  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const toolsResp = await waitFor(2);
  const names = (toolsResp.result?.tools ?? []).map((t) => t.name);
  console.log(`tools/list OK, ${names.length} tools:`, names.join(", "));

  const expected = [
    "list_courses",
    "get_course_content",
    "get_assignments",
    "get_quizzes",
    "get_grades",
    "get_announcements",
    "get_upcoming_due_dates",
    "reauthenticate",
  ];
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length) {
    console.error("MISSING TOOLS:", missing);
    process.exitCode = 1;
  } else {
    console.log("All expected tools present.");
  }

  // Call one tool with no session.json, no credentials, and an unreachable
  // D2L — auto-heal can't recover, so the tool must fail with a clear,
  // non-crashing message that points the agent at reauthenticate / auth.mjs.
  send({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "list_courses", arguments: {} },
  });
  const callResp = await waitFor(3, 90_000);
  const text = callResp.result?.content?.[0]?.text ?? "";
  console.log("tools/call list_courses (no session) ->", callResp.result?.isError ? "isError=true" : "isError=false", "|", text.slice(0, 160));
  if (!callResp.result?.isError || !text.includes("reauthenticate")) {
    console.error("Expected a clean failure naming the reauthenticate tool");
    process.exitCode = 1;
  }

  child.kill();
  const { rm } = await import("node:fs/promises");
  await rm(path.join(__dirname, ".smoke-state"), { recursive: true, force: true });
}

main().catch((err) => {
  console.error("Smoke test failed:", err);
  child.kill();
  process.exit(1);
});
