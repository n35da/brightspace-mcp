// Validates lib/config.mjs's institution-config loading: missing file,
// valid d2lBaseUrl+courseCodes, invalid/malformed values falling back safely.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// MUST be set before the lib import (CONFIG_PATH is computed at module
// load). Pointing it at the real config.json would clobber this repo's
// actual institution config.
process.env.BRIGHTSPACE_CONFIG_PATH = path.join(
  await mkdtemp(path.join(tmpdir(), "brightspace-mcp-config-")),
  "config.json"
);
const { loadConfig, writeConfig, CONFIG_PATH } = await import("../lib/config.mjs");
if (!CONFIG_PATH.includes("brightspace-mcp-config-")) {
  console.error("FATAL: config test is not sandboxed, refusing to run (would touch " + CONFIG_PATH + ")");
  process.exit(1);
}

let failures = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

async function main() {
  let cfg = await loadConfig();
  check("missing file -> d2lBaseUrl null", cfg.d2lBaseUrl === null);
  check("missing file -> courseCodes []", Array.isArray(cfg.courseCodes) && cfg.courseCodes.length === 0);

  await writeConfig({ d2lBaseUrl: "https://d2l.example.edu/", courseCodes: ["CSE404"] });
  cfg = await loadConfig();
  check("valid https URL kept, trailing slash stripped", cfg.d2lBaseUrl === "https://d2l.example.edu");
  check("courseCodes round-trips", cfg.courseCodes.length === 1 && cfg.courseCodes[0] === "CSE404");

  await writeConfig({ d2lBaseUrl: "not a url", courseCodes: [] });
  cfg = await loadConfig();
  check("invalid URL -> null, not thrown", cfg.d2lBaseUrl === null);

  await writeFile(CONFIG_PATH, JSON.stringify({ d2lBaseUrl: "https://d2l.example.edu", courseCodes: "CSE404" }), "utf8");
  cfg = await loadConfig();
  check("non-array courseCodes -> []", Array.isArray(cfg.courseCodes) && cfg.courseCodes.length === 0);

  await writeFile(CONFIG_PATH, "{ not json", "utf8");
  cfg = await loadConfig();
  check("malformed JSON -> defaults", cfg.d2lBaseUrl === null && cfg.courseCodes.length === 0);

  await rm(path.dirname(CONFIG_PATH), { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All config.mjs checks passed.");
}

main();
