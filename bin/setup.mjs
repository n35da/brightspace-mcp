#!/usr/bin/env node
// One-command setup for brightspace-mcp: configure which Brightspace
// instance and courses to use, run the existing browser login, and wire the
// server into Claude Desktop's config automatically.
//
// Run via: npx @n35da/brightspace-mcp setup
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import readline from "node:readline/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, writeConfig, checkBrightspaceUrl } from "../lib/config.mjs";
import { resolveClaudeConfigPath, mergeMcpServerEntry } from "../lib/claudeConfig.mjs";
import { buildAddArgs, buildRemoveArgs } from "../lib/claudeCodeConfig.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ENTRY = { command: "npx", args: ["-y", "@n35da/brightspace-mcp"] };

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** Ask which Claude client(s) to wire into. Loops until at least one is
 * picked — "neither" isn't a usable answer for a setup wizard whose whole
 * job is to wire something in. */
async function promptTargets() {
  for (;;) {
    const answer = (await prompt("Which do you want to configure — Claude Desktop, Claude Code, or both? [desktop/code/both]: ")).toLowerCase();
    const desktop = answer.includes("desktop") || answer.includes("both");
    const code = answer.includes("code") || answer.includes("both");
    if (desktop || code) return { desktop, code };
    console.log("Please choose desktop, code, or both — at least one is required.\n");
  }
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.on("error", () => resolve({ ok: false, spawnError: true }));
    child.on("exit", (exitCode) => resolve({ ok: exitCode === 0, exitCode }));
  });
}

async function wireClaudeDesktop() {
  console.log("\nWiring into Claude Desktop...");
  const configPath = resolveClaudeConfigPath({
    platform: process.platform,
    homedir: os.homedir(),
    env: process.env,
    existsSync,
    readdirSync,
  });

  if (!configPath) {
    console.log(
      "\nCouldn't find a Claude Desktop config file. Launch Claude Desktop at least once, then re-run `npx @n35da/brightspace-mcp setup`,\n" +
        "or add this to its config yourself under \"mcpServers\":\n\n" +
        JSON.stringify({ brightspace: MCP_SERVER_ENTRY }, null, 2)
    );
    return;
  }

  const existingText = existsSync(configPath) ? await readFile(configPath, "utf8") : null;
  const merged = mergeMcpServerEntry(existingText, "brightspace", MCP_SERVER_ENTRY);
  await writeFile(configPath, merged, "utf8");

  console.log(`Done. Updated ${configPath}.`);
  console.log("Fully quit and relaunch Claude Desktop to start using it.");
}

async function wireClaudeCode() {
  console.log("\nWiring into Claude Code...");
  const versionCheck = await runCommand("claude", ["--version"]);
  if (versionCheck.spawnError) {
    console.log(
      "\nCouldn't find the `claude` command on your PATH. Install Claude Code, then run this yourself:\n\n" +
        `  claude ${buildAddArgs({ name: "brightspace", command: MCP_SERVER_ENTRY.command, args: MCP_SERVER_ENTRY.args }).join(" ")}\n`
    );
    return;
  }

  // Re-running setup shouldn't error just because it's already wired —
  // `claude mcp add` fails if the name exists, so clear it first (ignore
  // failure: a fresh install has nothing to remove).
  await runCommand("claude", buildRemoveArgs({ name: "brightspace" }));
  const added = await runCommand("claude", buildAddArgs({ name: "brightspace", command: MCP_SERVER_ENTRY.command, args: MCP_SERVER_ENTRY.args }));

  if (!added.ok) {
    console.log(
      "\n`claude mcp add` failed. Run this yourself to see why:\n\n" +
        `  claude ${buildAddArgs({ name: "brightspace", command: MCP_SERVER_ENTRY.command, args: MCP_SERVER_ENTRY.args }).join(" ")}\n`
    );
    return;
  }

  console.log("Done. Registered with Claude Code (available in every project).");
}

async function main() {
  console.log("\nbrightspace-mcp setup\n");

  const existing = await loadConfig();
  let baseUrl = null;
  while (!baseUrl) {
    const answer = await prompt(
      `Your school's Brightspace URL${existing.d2lBaseUrl ? ` [${existing.d2lBaseUrl}]` : ""} (e.g. https://d2l.myschool.edu): `
    );
    const candidate = (answer || existing.d2lBaseUrl || "").replace(/\/+$/, "");
    if (!candidate) continue;
    process.stdout.write("Checking that URL looks like a Brightspace instance... ");
    if (await checkBrightspaceUrl(candidate)) {
      console.log("OK");
      baseUrl = candidate;
    } else {
      console.log("not reachable or not Brightspace — try again.");
    }
  }

  const codesAnswer = await prompt(
    `Course code filters, comma-separated (optional, e.g. CSE404,STT404)${existing.courseCodes.length ? ` [${existing.courseCodes.join(",")}]` : ""}: `
  );
  const courseCodes = codesAnswer
    ? codesAnswer.split(",").map((s) => s.trim()).filter(Boolean)
    : existing.courseCodes;

  await writeConfig({ d2lBaseUrl: baseUrl, courseCodes });
  console.log(`\nSaved config. Now logging in to ${baseUrl} — a browser window will open.\n`);

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "auth.mjs")], {
      stdio: "inherit",
      env: { ...process.env, D2L_BASE_URL: baseUrl },
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Login failed (exit ${code})`))));
  });

  const targets = await promptTargets();
  if (targets.desktop) await wireClaudeDesktop();
  if (targets.code) await wireClaudeCode();

  console.log("\nAll done. Fully quit and relaunch whichever client(s) you configured to start using it.\n");
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
