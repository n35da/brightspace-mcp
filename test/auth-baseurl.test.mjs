// auth.mjs must refuse to guess a Brightspace URL. With no D2L_BASE_URL env
// var and no configured d2lBaseUrl, it should fail fast with a clear message
// pointing at `setup`, rather than defaulting to MSU's URL (the old
// behavior) or crashing with a stack trace.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = await mkdtemp(path.join(tmpdir(), "brightspace-mcp-auth-baseurl-"));

const child = spawn(process.execPath, [path.join(__dirname, "..", "auth.mjs")], {
  stdio: ["ignore", "pipe", "pipe"],
  env: {
    ...process.env,
    D2L_BASE_URL: "",
    MSU_D2L_SESSION_DIR: path.join(root, "state"),
    BRIGHTSPACE_CONFIG_PATH: path.join(root, "config.json"), // deliberately missing
  },
});

let stderr = "";
child.stderr.on("data", (d) => (stderr += d.toString()));

child.on("exit", async (code) => {
  await rm(root, { recursive: true, force: true });
  const failures = [];
  if (code !== 1) failures.push(`expected exit code 1, got ${code}`);
  if (!stderr.includes("setup")) failures.push(`expected stderr to mention setup, got: ${stderr}`);
  if (failures.length) {
    console.error("FAIL:", failures.join("; "));
    process.exit(1);
  }
  console.log("PASS: auth.mjs exits cleanly with no D2L URL configured");
});
