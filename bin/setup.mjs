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

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
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
        JSON.stringify({ brightspace: { command: "npx", args: ["-y", "@n35da/brightspace-mcp"] } }, null, 2)
    );
    return;
  }

  const existingText = existsSync(configPath) ? await readFile(configPath, "utf8") : null;
  const merged = mergeMcpServerEntry(existingText, "brightspace", { command: "npx", args: ["-y", "@n35da/brightspace-mcp"] });
  await writeFile(configPath, merged, "utf8");

  console.log(`\nDone. Updated ${configPath}.`);
  console.log("Fully quit and relaunch Claude Desktop to start using it.\n");
}

main().catch((err) => {
  console.error("\nSetup failed:", err.message);
  process.exit(1);
});
