#!/usr/bin/env node
// One-time (well, occasional) interactive login.
//
// Run this yourself, from a normal terminal on your own computer:
//     node auth.mjs
//
// It opens a REAL, visible Chromium window pointed at MSU's Brightspace,
// backed by a persistent browser profile (~/.msu-d2l-mcp/browser-profile).
// That profile is the whole trick: MSU's Okta "keep me signed in" and Duo
// "remember me" trust live in it, so later the MCP server can re-login
// headlessly (lib/reauth.mjs) without ever seeing your password or asking
// you to approve Duo again. The old version used a throwaway context every
// run, which threw that trust away — hence re-logging in constantly.
//
// Once you land on the Brightspace homepage, the script reads two session
// cookies and a CSRF token off the page and saves them to
// ~/.msu-d2l-mcp/session.json so the MCP server can make direct API calls.
//
// It then offers to save your NetID username + password to
// ~/.msu-d2l-mcp/credentials.json (plain JSON, 0600). With those saved, the
// server's automated re-login can still get you in even after the SSO trust
// in the profile expires. Say no and you keep password-free operation —
// re-auth then only works while the profile's SSO session lasts.
//
// Re-run this whenever reauthenticate reports it can't log in on its own.

import { chromium } from "playwright";
import readline from "node:readline/promises";
import { captureAndSaveSession, PROFILE_DIR } from "./lib/reauth.mjs";
import { saveCredentials } from "./lib/credentials.mjs";
import { loadConfig } from "./lib/config.mjs";

const config = await loadConfig();
const BASE_URL = process.env.D2L_BASE_URL || config.d2lBaseUrl;
if (!BASE_URL) {
  console.error("\nNo Brightspace URL configured. Run `npx brightspace-mcp setup` first, or set D2L_BASE_URL.\n");
  process.exit(1);
}
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to finish NetID + Duo

// terminal: false means readline never echoes what's typed, which is what we
// want for the password (and harmless for the username).
async function prompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function main() {
  console.log(`\nOpening a browser window at ${BASE_URL} ...`);
  console.log("Log in with your NetID and approve Duo like you normally would.");
  console.log("If MSU offers 'Keep me signed in' / 'Remember me', tick it — that trust is what lets the");
  console.log("automated re-login skip the password and Duo later.\n");

  // D2L_AUTH_HEADLESS=1 exists so tests can run this flow without a window
  // flashing open; normal use is always headful.
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: process.env.D2L_AUTH_HEADLESS === "1",
  });
  const page = context.pages()[0] || (await context.newPage());

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });

  // Wait until we land on an authenticated Brightspace page.
  try {
    await page.waitForURL(/\/d2l\/home/, { timeout: LOGIN_TIMEOUT_MS });
  } catch {
    console.error("\nTimed out waiting for login. Run `node auth.mjs` again when you're ready.");
    await context.close();
    process.exit(1);
  }

  // Give the Brightspace SPA a moment to finish loading its JS globals.
  await page.waitForLoadState("networkidle").catch(() => {});

  console.log("Logged in. Harvesting session cookies and CSRF token...");
  let session;
  try {
    session = await captureAndSaveSession({ context, page, baseUrl: BASE_URL });
  } catch (err) {
    console.error(`\n${err.message}. Brightspace may have changed — tell Claude, this script needs updating.`);
    await context.close();
    process.exit(1);
  }

  await context.close();

  console.log(`\nSession saved to ~/.msu-d2l-mcp/session.json.`);
  console.log(session.accessToken ? "Access token verified working." : "(Access token not minted — the server will retry when it's first needed.)");

  // Offer to save credentials for the automated re-login path.
  const answer = (
    await prompt("\nAlso save your NetID username + password so tools can re-login automatically? (y/N) ")
  ).toLowerCase();
  if (answer === "y" || answer === "yes") {
    const username = await prompt("NetID username or MSU email: ");
    const password = await prompt("NetID password (not echoed): ");
    if (!username || !password) {
      console.log("Empty username or password — skipping credential save.");
    } else {
      await saveCredentials({ username, password });
      console.log(`Saved to ~/.msu-d2l-mcp/credentials.json as plain JSON (0600 where supported).`);
      console.log("Protect that file like a password manager entry — anyone who can read it has your NetID password.");
    }
  } else {
    console.log("Skipped. Automated re-login will still work from the browser profile's SSO session, but only until that trust expires.");
  }

  console.log("\nDone. The msu-d2l-mcp server will now re-login automatically whenever a session expires.\n");
}

main().catch((err) => {
  console.error("\nUnexpected error during login:", err);
  process.exit(1);
});
