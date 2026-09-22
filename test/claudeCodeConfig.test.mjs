// Pure unit tests for the Claude Code argv-building helpers — no real
// `claude` binary is spawned here (bin/setup.mjs does the actual spawning,
// untested per this project's convention for interactive/subprocess code).
import { buildAddArgs, buildRemoveArgs } from "../lib/claudeCodeConfig.mjs";

let failures = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

const addArgs = buildAddArgs({ name: "brightspace", command: "npx", args: ["-y", "@n35da/brightspace-mcp"] });
check(
  "buildAddArgs produces the exact confirmed claude mcp add syntax",
  JSON.stringify(addArgs) === JSON.stringify(["mcp", "add", "--transport", "stdio", "--scope", "user", "brightspace", "--", "npx", "-y", "@n35da/brightspace-mcp"])
);

const addArgsNoExtra = buildAddArgs({ name: "brightspace", command: "npx" });
check(
  "buildAddArgs defaults args to an empty array",
  JSON.stringify(addArgsNoExtra) === JSON.stringify(["mcp", "add", "--transport", "stdio", "--scope", "user", "brightspace", "--", "npx"])
);

const removeArgs = buildRemoveArgs({ name: "brightspace" });
check(
  "buildRemoveArgs matches the confirmed claude mcp remove syntax",
  JSON.stringify(removeArgs) === JSON.stringify(["mcp", "remove", "brightspace", "--scope", "user"])
);

if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log("All claudeCodeConfig.mjs checks passed.");
