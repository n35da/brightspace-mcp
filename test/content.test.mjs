// Validates lib/content.mjs against a fake D2L: the content tree must survive
// a dangling topic reference. D2L courses accumulate topics whose detail
// endpoint 404s (deleted/moved content leaving a stale TOC entry, e.g. CSE
// 325's topic 19949907) — one dead topic must not kill the whole listing;
// it should come back flagged isBroken instead.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Sandbox state BEFORE importing libs (see credentials.test.mjs).
process.env.MSU_D2L_SESSION_DIR = await mkdtemp(path.join(tmpdir(), "msu-d2l-mcp-content-"));
const { D2LClient, saveSession } = await import("../lib/d2lClient.mjs");
const { getContentTree } = await import("../lib/content.mjs");
import http from "node:http";

const BROKEN_ID = 19949907;

const topicDetail = (id) =>
  JSON.stringify({ Id: id, Title: `Topic ${id}`, TopicType: 1, IsBroken: false, Url: `/content/enforced/${id}-slides.pptx` });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (p === "/d2l/api/versions/") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.55" }, { ProductCode: "le", LatestVersion: "1.90" }]));
    return;
  }
  if (p.endsWith("/content/root/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify([
        {
          Id: 10,
          Title: "Lectures",
          Type: 0,
          Structure: [
            { Id: 100, Title: "Lecture 1 — Intro", Type: 1 },
            { Id: BROKEN_ID, Title: "Dangling reference", Type: 1 },
            { Id: 300, Title: "Marked broken in D2L", Type: 1 },
          ],
        },
        { Id: 20, Title: "Admin", Type: 0, Structure: [{ Id: 400, Title: "Syllabus", Type: 1 }] },
      ])
    );
    return;
  }
  const topicMatch = p.match(/\/content\/topics\/(\d+)$/);
  if (topicMatch) {
    const id = Number(topicMatch[1]);
    if (id === BROKEN_ID) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "Not Found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(id === 300 ? JSON.stringify({ Id: 300, TopicType: 1, IsBroken: true, Url: null }) : topicDetail(id));
    return;
  }
  res.writeHead(404);
  res.end("not found");
});

let failed = false;
const assert = (cond, msg) => {
  if (!cond) {
    console.error("FAIL:", msg);
    failed = true;
  } else {
    console.log("ok:", msg);
  }
};

async function main() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  await saveSession({
    baseUrl,
    cookieHeader: "d2lSessionVal=abc; d2lSecureSessionVal=def",
    csrfToken: "xsrf123",
    accessToken: "prefixed-token",
  });

  const client = await D2LClient.fromSavedSession();
  let tree = null;
  let error = null;
  try {
    tree = await getContentTree(client, 12345);
  } catch (e) {
    error = e;
  }

  assert(error === null, `tree survives a 404ing topic (got error: ${error?.message?.split("\n")[0]})`);
  assert(tree?.length === 4, `all four topics listed (got ${tree?.length})`);

  const broken = tree?.find((t) => t.id === BROKEN_ID);
  assert(broken?.title === "Dangling reference", "broken topic keeps its TOC title");
  assert(broken?.isBroken === true, "dangling 404 topic flagged isBroken");
  assert(broken?.downloadable === false, "dangling topic not marked downloadable");
  assert(broken?.modulePath === "Lectures", "dangling topic keeps its module path");

  const marked = tree?.find((t) => t.id === 300);
  assert(marked?.isBroken === true && marked?.downloadable === false, "D2L's own IsBroken flag respected");

  const good = tree?.find((t) => t.id === 100);
  assert(good?.downloadable === true && good?.url?.includes("slides.pptx"), "healthy topic still downloadable with url");

  const syllabus = tree?.find((t) => t.id === 400);
  assert(syllabus?.modulePath === "Admin", "second module's topics walked fine");

  server.close(() => {});
  await rm(process.env.MSU_D2L_SESSION_DIR, { recursive: true, force: true });
  process.exitCode = failed ? 1 : 0;
}

main();
