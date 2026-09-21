// Fake MSU SSO + D2L server shared by the reauth and MCP auto-heal tests.
// Models the parts of the real chain that matter: an Okta-ish login form
// gated by a persistent SSO cookie, an optional Duo challenge after correct
// credentials, a D2L home page that sets the two session cookies and exposes
// a CSRF token, and the token-mint + enrollment endpoints d2lClient uses.
import http from "node:http";
import path from "node:path";

const USERNAME = "aden@msu.edu";
const PASSWORD = "hunter2";

// Okta Identity Engine style: an identifier-first page (email + "Keep me
// signed in" + Next), then a separate password page. Field names mirror the
// real auth.msu.edu (input#identifier[name=identifier]).
const loginForm = `<html><head><title>MSU NetID Login</title></head><body>
<form method="POST" action="/sso/identifier">
  <input id="identifier" name="identifier" type="text" placeholder="Email">
  <input type="checkbox" name="rememberMe" id="rememberMe">
  <button type="submit">Next</button>
</form></body></html>`;

const passwordForm = `<html><head><title>MSU NetID Login - Password</title></head><body>
<form method="POST" action="/sso/password">
  <input type="password" name="password" id="password">
  <button type="submit">Verify</button>
</form></body></html>`;

const duoPage = `<html><head><title>Duo Security</title></head><body>
<iframe id="duo_iframe" src="https://fake.duo.test/two-factor"></iframe>
</body></html>`;

const d2lHome = (n) => `<html><head>
<meta name="d2l-xsrf-token" content="xsrf-${n}">
</head><body>D2L homepage ${n}</body></html>`;

export async function startFakeMsu() {
  const state = { duoMode: false, formSubmits: 0, duoChallenges: 0, issued: 0 };
  const cookiesOf = (req) =>
    Object.fromEntries(
      (req.headers.cookie || "")
        .split("; ")
        .filter(Boolean)
        .map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)])
    );

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString();
    const cookies = cookiesOf(req);
    const url = new URL(req.url, "http://localhost");

    if (url.pathname === "/") {
      // SSO gate: a persistent SSO trust cookie skips the login form entirely.
      if (cookies.ssosid) {
        res.writeHead(302, { location: "/d2l/home" });
      } else {
        res.writeHead(302, { location: "/sso/login" });
      }
      res.end();
      return;
    }
    if (url.pathname === "/sso/login" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(loginForm);
      return;
    }
    if (url.pathname === "/sso/identifier" && req.method === "POST") {
      state.formSubmits++;
      const params = new URLSearchParams(body);
      if (params.get("identifier") === USERNAME) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(passwordForm);
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(loginForm);
      }
      return;
    }
    if (url.pathname === "/sso/password" && req.method === "POST") {
      state.formSubmits++;
      const params = new URLSearchParams(body);
      if (params.get("password") === PASSWORD) {
        if (state.duoMode) {
          state.duoChallenges++;
          res.writeHead(200, { "content-type": "text/html" });
          res.end(duoPage);
          return;
        }
        state.issued++;
        // Max-Age matters: like Okta's real "remember me" cookie, an SSO trust
        // cookie is persistent — a browser restart must keep it. (Session
        // cookies are dropped on close, which is exactly what broke the old
        // throwaway-context auth flow.)
        res.writeHead(302, { location: "/d2l/home", "set-cookie": `ssosid=s${state.issued}; Path=/; Max-Age=86400` });
        res.end();
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(passwordForm);
      }
      return;
    }
    if (url.pathname === "/d2l/home") {
      state.issued++;
      res.writeHead(200, {
        "content-type": "text/html",
        "set-cookie": [`d2lSessionVal=v${state.issued}; Path=/`, `d2lSecureSessionVal=s${state.issued}; Path=/`],
      });
      res.end(d2lHome(state.issued));
      return;
    }
    if (url.pathname === "/d2l/lp/auth/oauth2/token" && req.method === "POST") {
      const ok =
        cookies.d2lSessionVal &&
        cookies.d2lSecureSessionVal &&
        req.headers["x-csrf-token"] === `xsrf-${cookies.d2lSessionVal.slice(1)}`;
      if (ok) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: `tok-v${cookies.d2lSessionVal.slice(1)}` }));
      } else {
        res.writeHead(401, { "content-type": "text/html" });
        res.end(`<script>location.replace("/d2l/login?sessionExpired=1")</script>`);
      }
      return;
    }
    if (url.pathname === "/d2l/api/versions/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.55" }, { ProductCode: "le", LatestVersion: "1.90" }]));
      return;
    }
    if (url.pathname === "/d2l/api/lp/1.55/enrollments/myenrollments/") {
      // API calls carry only the minted Bearer, never the browser cookies.
      if (!/^Bearer tok-v\d+$/.test(req.headers.authorization ?? "")) {
        res.writeHead(401, { "content-type": "text/html" });
        res.end(`<script>location.replace("/d2l/login?sessionExpired=1")</script>`);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Items: [{ OrgUnit: { Id: 12345, Code: "CSE425", Name: "Intro to Computer Security" }, Access: { IsActive: true } }],
        })
      );
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { baseUrl: `http://127.0.0.1:${port}`, state, close: () => server.close() };
}

export { USERNAME, PASSWORD };

/** Test helper: pre-save credentials.json into a (session-dir) state dir. */
export async function saveCredsFile(stateDir) {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(path.join(stateDir, "credentials.json"), JSON.stringify({ username: USERNAME, password: PASSWORD }));
}
