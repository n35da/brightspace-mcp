// Automated re-login for MSU Brightspace, driven by a persistent headless
// Chromium profile. Two ways this succeeds without the user:
//
//   1. "sso"      — the profile still holds MSU's Okta SSO session (and Duo
//                   "remember me") from the last manual login, so the whole
//                   SAML redirect chain completes silently. This is the
//                   normal path, and the reason auth.mjs uses a persistent
//                   profile instead of a throwaway browser context.
//   2. "password" — the SSO session is gone but credentials.json exists:
//                   fill the Okta username/password form. If Duo then issues
//                   a challenge anyway, stop — no machine can approve it.
//
// Everything else is a clean { ok: false, reason } so the caller (an agent,
// usually) knows to ask the user to run `npm run auth` manually.
//
// Selectors cover MSU's real chain (D2L hosted login page `#loginUrl1` →
// Okta sign-in widget at auth.msu.edu) plus generic fallbacks that the mock
// server in test/reauth.test.mjs exercises.

import path from "node:path";
import { chromium } from "playwright";
import { SESSION_DIR, loadSession, saveSession, mintAccessToken } from "./d2lClient.mjs";
import { loadCredentials } from "./credentials.mjs";
import { loadConfig } from "./config.mjs";

export const PROFILE_DIR = path.join(SESSION_DIR, "browser-profile");

const HOME_URL = /\/d2l\/home/;
// MSU's Okta is Identity Engine with an identifier-first flow: the first
// screen has an email/identifier field (input#identifier[name=identifier] on
// the real auth.msu.edu) and NO password field — password comes on screen two.
const LOGIN_FORM_SELECTORS =
  "#identifier, #okta-signin-username, input[name=identifier i], #username, input[name=username i], input[type=email]";
const REMEMBER_ME_SELECTORS = "input[name=rememberMe i], #rememberMe, input[name=remember i]";
const PASSWORD_SELECTORS = "#okta-signin-password, #password, input[type=password]";
const SUBMIT_SELECTORS = "#okta-signin-submit, button[type=submit], input[type=submit]";
const D2L_LOGIN_BUTTON = "#loginUrl1, a[entityid], #login-button a, a:has-text('Log in')";

/** Same harvesting auth.mjs has always done, shared by the visible and
 * headless flows: pull the two session cookies + CSRF token off the logged-in
 * page, mint an access token, save the session. Returns the saved session. */
export async function captureAndSaveSession({ context, page, baseUrl }) {
  const cookies = await context.cookies(baseUrl);
  const wanted = ["d2lSessionVal", "d2lSecureSessionVal"];
  const parts = wanted
    .map((name) => cookies.find((c) => c.name === name))
    .filter(Boolean)
    .map((c) => `${c.name}=${c.value}`);
  if (parts.length !== wanted.length) {
    throw new Error(`couldn't find both D2L session cookies (found ${parts.length}/2)`);
  }
  const cookieHeader = parts.join("; ");

  const csrfToken = await extractXsrfToken(page);
  if (!csrfToken) throw new Error("couldn't read the CSRF token from the page");

  let accessToken = null;
  try {
    accessToken = await mintAccessToken(baseUrl, cookieHeader, csrfToken);
  } catch {
    // The saved cookies are still valid for harvesting later; the server will
    // re-mint on first use and surface a SessionExpiredError if they're dead.
  }

  const session = {
    baseUrl,
    cookieHeader,
    csrfToken,
    accessToken,
    mintedAt: accessToken ? Date.now() : null,
    savedAt: Date.now(),
  };
  await saveSession(session);
  return session;
}

async function extractXsrfToken(page) {
  for (let attempt = 0; attempt < 15; attempt++) {
    const token = await page
      .evaluate(() => {
        try {
          const fromD2L = window.D2L?.LP?.Web?.Authentication?.Xsrf?.GetXsrfToken?.();
          if (fromD2L) return fromD2L;
        } catch {
          /* not available yet */
        }
        const meta = document.querySelector('meta[name="d2l-xsrf-token"]');
        return meta ? meta.getAttribute("content") : null;
      })
      .catch(() => null);
    if (token) return token;
    await page.waitForTimeout(1000);
  }
  return null;
}

/** Resolve as soon as EITHER we've landed on the D2L home (SSO worked) or a
 * login form appeared (we need the credentials). Null if neither happens. */
async function waitHomeOrLoginForm(page, timeoutMs) {
  const home = page.waitForURL(HOME_URL, { timeout: timeoutMs }).then(() => "home").catch(() => null);
  const login = page
    .waitForSelector(LOGIN_FORM_SELECTORS, { timeout: timeoutMs })
    .then(() => "login")
    .catch(() => null);
  return (await Promise.race([home, login])) ?? (await Promise.all([home, login])).find(Boolean) ?? null;
}

/** True if any frame on the page is showing a Duo two-factor challenge. */
async function isDuoChallenge(page) {
  for (const frame of page.frames()) {
    if (/duo/i.test(frame.url())) return true;
    if (await frame.$("#duo_iframe").catch(() => null)) return true;
  }
  return false;
}

/**
 * Refresh the saved D2L session headlessly.
 * Returns { ok: true, how: "sso" | "password" } or { ok: false, reason }.
 * Reasons: "no-base-url", "no-credentials", "wrong-password", "duo", "timeout",
 * "browser", or a lower-level message. Never includes the password in the result.
 */
export async function reauthenticate({ baseUrl, profileDir = PROFILE_DIR, waitMs = 20_000 } = {}) {
  baseUrl = baseUrl || (await loadSession())?.baseUrl || process.env.D2L_BASE_URL || (await loadConfig()).d2lBaseUrl;
  if (!baseUrl) {
    return { ok: false, reason: "no-base-url: no configured Brightspace URL (run `npx brightspace-mcp setup` first)" };
  }
  let context;
  try {
    context = await chromium.launchPersistentContext(profileDir, { headless: true });
  } catch (err) {
    return { ok: false, reason: `browser: ${err.message}` };
  }

  try {
    const page = context.pages()[0] || (await context.newPage());
    await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: waitMs });

    // D2L's hosted login page needs its button clicked to start the SAML
    // chain; if we're already being forwarded (or already home) this no-ops.
    const loginButton = await page.waitForSelector(D2L_LOGIN_BUTTON, { timeout: 5_000 }).catch(() => null);
    if (loginButton) await loginButton.click().catch(() => {});

    const where = await waitHomeOrLoginForm(page, waitMs);
    let how;

    if (where === "home") {
      how = "sso";
    } else {
      if (await isDuoChallenge(page)) return { ok: false, reason: "duo" };
      if (where !== "login") return { ok: false, reason: "timeout: never reached the D2L home or a login form" };

      const creds = await loadCredentials();
      if (!creds) {
        return { ok: false, reason: "no-credentials: no saved NetID username/password (run `npm run auth` and answer yes to saving them)" };
      }

      const outcome = await submitLoginForm(page, creds);
      if (outcome === "rejected") {
        return { ok: false, reason: "wrong-password: the login form came back after submitting the saved credentials" };
      }
      if (outcome === "pending") {
        // The form neither navigated nor came back — could be a Duo challenge
        // doing its thing, so wait a full window before giving up.
        try {
          await page.waitForURL(HOME_URL, { timeout: waitMs });
        } catch {
          if (await isDuoChallenge(page)) return { ok: false, reason: "duo" };
          return { ok: false, reason: "timeout: never reached the D2L home after logging in" };
        }
      }
      how = "password";
    }

    await page.waitForLoadState("networkidle").catch(() => {});
    await captureAndSaveSession({ context, page, baseUrl });
    return { ok: true, how };
  } catch (err) {
    return { ok: false, reason: err.message };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Fill and submit the SSO login form. Returns "ok" once we've reached the
 * D2L home, "rejected" if the form came back (wrong credentials), or
 * "pending" when neither happened (e.g. a Duo challenge took over).
 * Handles both one-page and Okta's identifier-first (email, then Next, then
 * password) forms. */
async function submitLoginForm(page, { username, password }) {
  const userField = await page.waitForSelector(LOGIN_FORM_SELECTORS, { timeout: 10_000 }).catch(() => null);
  if (!userField) return "rejected";
  await userField.fill(username);

  // Ask Okta to remember the session so future silent rides last.
  const rememberMe = await page.$(REMEMBER_ME_SELECTORS).catch(() => null);
  if (rememberMe && !(await rememberMe.isChecked().catch(() => false))) {
    await rememberMe.check().catch(() => {});
  }

  let pwField = await page.$(PASSWORD_SELECTORS);
  if (!pwField) {
    // Identifier-first flow: submit the username to reveal the password field.
    const next = await page.$(SUBMIT_SELECTORS);
    if (!next) return "rejected";
    await next.click();
    pwField = await page.waitForSelector(PASSWORD_SELECTORS, { timeout: 10_000 }).catch(() => null);
    if (!pwField) return "rejected";
  }
  await pwField.fill(password);

  const submit = await page.$(SUBMIT_SELECTORS);
  if (!submit) return "rejected";
  await submit.click();

  try {
    await page.waitForURL(HOME_URL, { timeout: 10_000 });
    return "ok";
  } catch {
    /* not home yet — classify below */
  }
  const formBack = await page.$(PASSWORD_SELECTORS).catch(() => null);
  return formBack ? "rejected" : "pending";
}
