// checkBrightspaceUrl hits <baseUrl>/d2l/api/versions/ to confirm a URL
// actually points at a Brightspace instance before setup accepts it. Uses an
// injected fetch so this never makes a real network call.
import { checkBrightspaceUrl } from "../lib/config.mjs";

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
  const okFetch = async (url) => {
    if (url.endsWith("/d2l/api/versions/")) {
      return { ok: true, json: async () => [{ ProductCode: "lp", LatestVersion: "1.55" }] };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  check("valid Brightspace URL -> true", (await checkBrightspaceUrl("https://d2l.example.edu", okFetch)) === true);

  const notFoundFetch = async () => ({ ok: false, status: 404 });
  check("non-Brightspace URL (404) -> false", (await checkBrightspaceUrl("https://example.com", notFoundFetch)) === false);

  const throwingFetch = async () => {
    throw new Error("ECONNREFUSED");
  };
  check("unreachable host -> false, not thrown", (await checkBrightspaceUrl("https://nope.invalid", throwingFetch)) === false);

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All setup helper checks passed.");
}

main();
