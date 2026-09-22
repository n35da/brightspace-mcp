// Validates lib/fullCourseAudit.mjs: same coverage-gated engine as
// deadlinesExport.mjs (see courseAudit.test.mjs for the gate itself), this
// only checks what's actually different here — the output shape (no
// schemaVersion/timezone-const/$schema, since it's not for the companion
// calendar) and where it saves.
import { readFile, rm, mkdtemp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MSU_D2L_SESSION_DIR = await mkdtemp(path.join(tmpdir(), "brightspace-mcp-fullaudit-"));
const { D2LClient, saveSession, SESSION_FILE } = await import("../lib/d2lClient.mjs");
const { buildAndSaveFullAudit, updateCourseAudit, AUDIT_DIR } = await import("../lib/fullCourseAudit.mjs");
const { startFakeD2lForAudit, TEST_COURSE_CODE, TEST_COURSES, fullCoverage } = await import("./fake-d2l-audit.mjs");

if (!SESSION_FILE.includes("brightspace-mcp-fullaudit-")) {
  console.error("FATAL: fullCourseAudit test is not sandboxed, refusing to run (would touch " + SESSION_FILE + ")");
  process.exit(1);
}

let failures = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}
async function expectThrows(label, fn) {
  try {
    await fn();
    check(label, false);
  } catch {
    check(label, true);
  }
}

const { server, baseUrl } = await startFakeD2lForAudit();
await saveSession({ baseUrl, cookieHeader: "x", csrfToken: "x", accessToken: "fake-token" });
const client = await D2LClient.fromSavedSession();

const validDeadline = {
  id: "test101-homework-0",
  course: TEST_COURSE_CODE,
  title: "Homework 0",
  type: "assignment",
  optional: false,
  date: "2026-09-08",
  time: "23:59",
  dueDateTime: "2026-09-08T23:59:00-04:00",
  source: "d2l_dropbox",
  confidence: "confirmed",
  description: "Environment setup and a short written reflection.",
};

async function main() {
  await expectThrows("update rejected when no audit exists yet", () => updateCourseAudit({ deadlines: [validDeadline] }));

  const result = await buildAndSaveFullAudit(client, {
    courses: TEST_COURSES,
    ...fullCoverage(),
    deadlines: [validDeadline],
    unscheduled: [],
  });
  check("valid + fully-covered input succeeds", existsSync(result.savedTo));
  check("saved under AUDIT_DIR, not exports/", result.savedTo.startsWith(AUDIT_DIR));
  check("eventCount reported", result.eventCount === 1);
  check("unscheduledCount reported", result.unscheduledCount === 0);
  check("courseCount reported", result.courseCount === 1);

  const written = JSON.parse(await readFile(result.savedTo, "utf8"));
  check("no schemaVersion (not the calendar-app schema)", written.schemaVersion === undefined);
  check("no timezone const (not the calendar-app schema)", written.timezone === undefined);
  check("has generatedAt instead", typeof written.generatedAt === "string" && !Number.isNaN(Date.parse(written.generatedAt)));
  check("deadline round-trips", written.deadlines[0].id === "test101-homework-0");

  // Cheap update: no client needed at all, and it still works
  const updateResult = await updateCourseAudit({
    deadlines: [{ ...validDeadline, id: "test101-homework-1", title: "Homework 1" }],
  });
  check("update needs no D2L client and still succeeds", updateResult.eventCount === 2);
  const afterUpdate = JSON.parse(await readFile(AUDIT_DIR + "/audit.json", "utf8"));
  check("update appended without disturbing the original", afterUpdate.deadlines.some((d) => d.id === "test101-homework-0"));
  check("update's new deadline is present", afterUpdate.deadlines.some((d) => d.id === "test101-homework-1"));

  await expectThrows("incomplete coverage rejected, same gate as deadlinesExport", () =>
    buildAndSaveFullAudit(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      quizzesChecked: { [TEST_COURSE_CODE]: [] },
      deadlines: [validDeadline],
      unscheduled: [],
    })
  );

  server.close();
  await rm(AUDIT_DIR, { recursive: true, force: true });
  await rm(path.dirname(SESSION_FILE), { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All fullCourseAudit.mjs checks passed.");
}

main();
