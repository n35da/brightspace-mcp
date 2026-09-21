// Pure unit tests for Claude Desktop config path detection and merging —
// no real filesystem access, so this is safe to run against a machine that
// already has a real Claude Desktop config (never touches it).
import path from "node:path";
import { resolveClaudeConfigPath, mergeMcpServerEntry } from "../lib/claudeConfig.mjs";

let failures = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function fakeFs(existingPaths) {
  return {
    existsSync: (p) => existingPaths.has(p),
    readdirSync: () => ["Claude_pzs8sxrjxfjjc"],
  };
}

// 1. Windows, direct path exists
{
  const direct = "C:\\Users\\alice\\AppData\\Roaming\\Claude\\claude_desktop_config.json";
  const { existsSync, readdirSync } = fakeFs(new Set([direct]));
  const result = resolveClaudeConfigPath({
    platform: "win32",
    homedir: "C:\\Users\\alice",
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    existsSync,
    readdirSync,
  });
  check("windows direct path found when it exists", result === direct);
}

// 2. Windows, direct missing, MSIX-redirected path exists (the bug this
// conversation diagnosed by hand)
{
  const msixPath = path.win32.join(
    "C:\\Users\\alice\\AppData\\Local\\Packages",
    "Claude_pzs8sxrjxfjjc",
    "LocalCache",
    "Roaming",
    "Claude",
    "claude_desktop_config.json"
  );
  const { existsSync, readdirSync } = fakeFs(new Set([msixPath]));
  const result = resolveClaudeConfigPath({
    platform: "win32",
    homedir: "C:\\Users\\alice",
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    existsSync,
    readdirSync,
  });
  check("windows MSIX-redirected path found when direct is missing", result === msixPath);
}

// 3. Windows, neither exists -> null
{
  const { existsSync, readdirSync } = fakeFs(new Set());
  const result = resolveClaudeConfigPath({
    platform: "win32",
    homedir: "C:\\Users\\alice",
    env: { APPDATA: "C:\\Users\\alice\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
    existsSync,
    readdirSync,
  });
  check("windows returns null when nothing exists", result === null);
}

// 4. macOS
{
  const direct = "/Users/alice/Library/Application Support/Claude/claude_desktop_config.json";
  const { existsSync, readdirSync } = fakeFs(new Set([direct]));
  const result = resolveClaudeConfigPath({
    platform: "darwin",
    homedir: "/Users/alice",
    env: {},
    existsSync,
    readdirSync,
  });
  check("macOS path resolved", result === direct);
}

// 5. Linux
{
  const direct = "/home/alice/.config/Claude/claude_desktop_config.json";
  const { existsSync, readdirSync } = fakeFs(new Set([direct]));
  const result = resolveClaudeConfigPath({
    platform: "linux",
    homedir: "/home/alice",
    env: {},
    existsSync,
    readdirSync,
  });
  check("linux path resolved", result === direct);
}

// 6. merge preserves unrelated existing keys
{
  const existing = JSON.stringify({ mcpServers: { other: { command: "foo" } }, somePreference: true });
  const merged = JSON.parse(mergeMcpServerEntry(existing, "brightspace", { command: "npx", args: ["-y", "brightspace-mcp"] }));
  check("merge keeps unrelated top-level key", merged.somePreference === true);
  check("merge keeps unrelated mcpServers entry", merged.mcpServers.other.command === "foo");
  check("merge adds the new entry", merged.mcpServers.brightspace.command === "npx");
}

// 7. merge on null/empty text creates fresh structure
{
  const merged = JSON.parse(mergeMcpServerEntry(null, "brightspace", { command: "npx", args: ["-y", "brightspace-mcp"] }));
  check("merge on null creates mcpServers.brightspace", merged.mcpServers.brightspace.command === "npx");
}

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All claudeConfig.mjs checks passed.");
