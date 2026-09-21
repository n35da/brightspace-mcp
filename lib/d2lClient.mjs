// Minimal D2L (Brightspace) REST API client.
//
// How auth works here (learned by reading D2L's own public API docs plus a
// couple of open-source Brightspace MCP servers' source to confirm the exact
// wire format — see README.md "How this works" section):
//
//   1. You log in to your school's Brightspace normally, in a real visible
//      browser, typing your own SSO password and approving any 2FA yourself
//      (auth.mjs never sees your password).
//   2. Once logged in, two D2L session cookies exist: d2lSessionVal and
//      d2lSecureSessionVal. Brightspace's own front-end also has a CSRF token
//      available on the page (window.D2L.LP.Web.Authentication.Xsrf).
//   3. Those three values can be exchanged for a short-lived OAuth Bearer
//      token by POSTing to /d2l/lp/auth/oauth2/token — this is the same
//      "mint" endpoint Brightspace's own web app quietly uses in the
//      background. That's what makes this fast: no browser needed to
//      refresh a token, only to get the first cookie.
//   4. The Bearer token is sent as a normal Authorization header to D2L's
//      documented JSON API (/d2l/api/lp/... and /d2l/api/le/...).
//   5. API versions (e.g. "1.55") are auto-discovered from the public,
//      unauthenticated /d2l/api/versions/ endpoint, so this isn't hardcoded
//      to one D2L release.
//
// A dead session doesn't reliably answer with HTTP 401 — it can answer 200
// with an HTML stub that redirects to /d2l/login?sessionExpired=1. We check
// for that explicitly rather than trusting the status code alone.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

// MSU_D2L_SESSION_DIR lets tests (or a paranoid user) relocate everything this
// server persists, so tests never touch a real live session.
export const SESSION_DIR = process.env.MSU_D2L_SESSION_DIR || path.join(os.homedir(), ".msu-d2l-mcp");
export const SESSION_FILE = path.join(SESSION_DIR, "session.json");

const USER_AGENT = "brightspace-mcp/0.1 (personal read-only tool; github.com/ade)";
const EXPIRED_MARKER = "sessionExpired=1";

export async function loadSession() {
  if (!existsSync(SESSION_FILE)) return null;
  try {
    return JSON.parse(await readFile(SESSION_FILE, "utf8"));
  } catch {
    return null;
  }
}

export async function saveSession(session) {
  await mkdir(SESSION_DIR, { recursive: true, mode: 0o700 });
  await writeFile(SESSION_FILE, JSON.stringify(session, null, 2), { mode: 0o600 });
}

function looksLikeExpiredSessionHtml(body) {
  return typeof body === "string" && body.includes("/d2l/login") && body.includes(EXPIRED_MARKER);
}

/** Exchange the harvested session cookies + CSRF token for a fresh Bearer token. */
export async function mintAccessToken(baseUrl, cookieHeader, csrfToken) {
  const res = await fetch(`${baseUrl}/d2l/lp/auth/oauth2/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: cookieHeader,
      "x-csrf-token": csrfToken,
      "user-agent": USER_AGENT,
    },
    body: "scope=*:*:*",
    redirect: "manual",
  });
  const text = await res.text();
  if (res.status === 401 || looksLikeExpiredSessionHtml(text)) {
    throw new SessionExpiredError();
  }
  if (!res.ok) {
    throw new Error(`Token mint failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`Token mint returned non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!payload.access_token) throw new Error("Token mint response had no access_token");
  return payload.access_token;
}

export class SessionExpiredError extends Error {
  constructor() {
    super(
      "Your D2L session has expired. Call the reauthenticate tool to log in again automatically; " +
        "if that fails, ask the user to run `npx brightspace-mcp setup` again."
    );
    this.name = "SessionExpiredError";
  }
}

export class D2LClient {
  constructor(session) {
    this.baseUrl = session.baseUrl;
    this.cookieHeader = session.cookieHeader;
    this.csrfToken = session.csrfToken;
    this.accessToken = session.accessToken ?? null;
    this._versions = null;
  }

  static async fromSavedSession() {
    const session = await loadSession();
    if (!session) {
      throw new SessionExpiredError();
    }
    return new D2LClient(session);
  }

  async _ensureVersions() {
    if (this._versions) return this._versions;
    const res = await fetch(`${this.baseUrl}/d2l/api/versions/`, {
      headers: { "user-agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`Version discovery failed: HTTP ${res.status}`);
    const list = await res.json();
    const lp = list.find((v) => v.ProductCode === "lp")?.LatestVersion;
    const le = list.find((v) => v.ProductCode === "le")?.LatestVersion;
    if (!lp || !le) throw new Error("Could not find lp/le versions in /d2l/api/versions/ response");
    this._versions = { lp, le };
    return this._versions;
  }

  async _ensureAccessToken() {
    if (this.accessToken) return this.accessToken;
    this.accessToken = await mintAccessToken(this.baseUrl, this.cookieHeader, this.csrfToken);
    await saveSession({ ...(await loadSession()), accessToken: this.accessToken, mintedAt: Date.now() });
    return this.accessToken;
  }

  lp(p) {
    return `/d2l/api/lp/${this._versions.lp}${p}`;
  }

  le(orgUnitId, p) {
    return `/d2l/api/le/${this._versions.le}/${orgUnitId}${p}`;
  }

  /** GET a JSON endpoint, transparently re-minting the Bearer token once if it was rejected. */
  async get(pathBuilder, { retried = false } = {}) {
    await this._ensureVersions();
    const p = pathBuilder(this);
    const token = await this._ensureAccessToken();
    const res = await fetch(`${this.baseUrl}${p}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
    });
    if (res.status === 401) {
      if (retried) throw new SessionExpiredError();
      this.accessToken = null; // force re-mint
      return this.get(pathBuilder, { retried: true });
    }
    const text = await res.text();
    if (looksLikeExpiredSessionHtml(text)) {
      if (retried) throw new SessionExpiredError();
      this.accessToken = null;
      return this.get(pathBuilder, { retried: true });
    }
    if (!res.ok) {
      throw new Error(`GET ${p} failed: HTTP ${res.status} ${text.slice(0, 300)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GET ${p} returned non-JSON body: ${text.slice(0, 300)}`);
    }
  }

  /** GET a binary endpoint (file download). Returns { buffer, contentType, filename }.
   * A dead session serves an HTML redirect stub even here, so any text/html
   * response is checked for the expired marker instead of being treated as a file. */
  async getBinary(pathBuilder, { retried = false } = {}) {
    await this._ensureVersions();
    const p = pathBuilder(this);
    const token = await this._ensureAccessToken();
    const res = await fetch(`${this.baseUrl}${p}`, {
      headers: {
        authorization: `Bearer ${token}`,
        "user-agent": USER_AGENT,
      },
    });
    if (res.status === 401) {
      if (retried) throw new SessionExpiredError();
      this.accessToken = null;
      return this.getBinary(pathBuilder, { retried: true });
    }
    const contentType = res.headers.get("content-type") || "application/octet-stream";
    if (contentType.includes("text/html")) {
      const text = await res.text();
      if (looksLikeExpiredSessionHtml(text)) {
        if (retried) throw new SessionExpiredError();
        this.accessToken = null;
        return this.getBinary(pathBuilder, { retried: true });
      }
      throw new Error(`GET ${p} returned HTML instead of a file: ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(`GET ${p} failed: HTTP ${res.status}`);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const disposition = res.headers.get("content-disposition") || "";
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = match ? decodeURIComponent(match[1]) : null;
    return { buffer, contentType, filename };
  }
}

/** D2L list endpoints return either a bare array or { Objects: [...] } depending on the call. */
export function unwrapList(raw) {
  if (Array.isArray(raw)) return raw;
  return raw?.Objects ?? raw?.Items ?? [];
}
