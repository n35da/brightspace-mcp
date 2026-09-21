// Cross-platform Claude Desktop config discovery + non-destructive merge.
// All filesystem/platform inputs are passed in rather than read directly, so
// this stays pure and testable without touching a real Claude installation.
//
// Windows needs two candidate paths, not one: a normal Claude Desktop
// install writes to %APPDATA%\Claude\claude_desktop_config.json, but MSIX-
// packaged builds (e.g. the "Cowork" distribution) get their declared
// --user-data-dir silently redirected by Windows app virtualization to
// AppData\Local\Packages\<PackageFamilyName>\LocalCache\Roaming\Claude\ —
// discovered the hard way debugging a real install.
import path from "node:path";

export function resolveClaudeConfigPath({ platform, homedir, env, existsSync, readdirSync }) {
  if (platform === "win32") {
    const appData = env.APPDATA || path.win32.join(homedir, "AppData", "Roaming");
    const localAppData = env.LOCALAPPDATA || path.win32.join(homedir, "AppData", "Local");
    const direct = path.win32.join(appData, "Claude", "claude_desktop_config.json");
    if (existsSync(direct)) return direct;

    // Check for MSIX-packaged Claude (Windows app virtualization redirect)
    try {
      const packagesDir = path.win32.join(localAppData, "Packages");
      const pkg = readdirSync(packagesDir).find((name) => name.startsWith("Claude_"));
      if (pkg) {
        const msixPath = path.win32.join(packagesDir, pkg, "LocalCache", "Roaming", "Claude", "claude_desktop_config.json");
        if (existsSync(msixPath)) return msixPath;
      }
    } catch (e) {
      // Packages directory doesn't exist or can't be read; skip MSIX check
    }
    return null;
  }

  if (platform === "darwin") {
    const direct = path.posix.join(homedir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
    return existsSync(direct) ? direct : null;
  }

  // Linux and anything else POSIX-like
  const direct = path.posix.join(homedir, ".config", "Claude", "claude_desktop_config.json");
  return existsSync(direct) ? direct : null;
}

/** Parse existingJsonText (or start fresh if null/empty), set
 * mcpServers[serverName] = serverEntry, and return the JSON text to write.
 * Every other top-level key and every other mcpServers entry is preserved. */
export function mergeMcpServerEntry(existingJsonText, serverName, serverEntry) {
  const parsed = existingJsonText ? JSON.parse(existingJsonText) : {};
  parsed.mcpServers = parsed.mcpServers || {};
  parsed.mcpServers[serverName] = serverEntry;
  return JSON.stringify(parsed, null, 2) + "\n";
}
