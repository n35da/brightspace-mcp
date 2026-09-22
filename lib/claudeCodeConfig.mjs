// Pure argv-building helpers for wiring into Claude Code, which is
// configured via its own `claude mcp` CLI subcommands rather than a JSON
// file we can merge directly (unlike Claude Desktop) — see lib/claudeConfig.mjs
// for that. Kept separate and pure so the argv shape is testable without
// actually spawning the `claude` binary.

/** Args for `claude mcp add`, registering a stdio server at user scope
 * (available in every project, the Claude Code equivalent of Claude
 * Desktop's global config) rather than the CLI's per-project default. */
export function buildAddArgs({ name, command, args = [] }) {
  return ["mcp", "add", "--transport", "stdio", "--scope", "user", name, "--", command, ...args];
}

/** Args for `claude mcp remove`, used to make re-running setup idempotent —
 * `claude mcp add` errors if the name already exists at that scope. */
export function buildRemoveArgs({ name }) {
  return ["mcp", "remove", name, "--scope", "user"];
}
