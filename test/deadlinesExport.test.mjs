// Validates lib/deadlinesExport.mjs against the real calendar-app schema
// shape, and against a real fake D2L backend for the mechanical coverage
// gate: valid + fully-covered input round-trips to a file, every schema
// rejection path still throws, and incomplete coverage is rejected even
// when the schema itself is otherwise valid.
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MSU_D2L_SESSION_DIR = await mkdtemp(path.join(tmpdir(), "brightspace-mcp-deadlinesexport-"));
const { D2LClient, saveSession, SESSION_FILE } = await import("../lib/d2lClient.mjs");
const { buildAndSaveDeadlinesExport, updateDeadlinesExport, EXPORT_DIR } = await import("../lib/deadlinesExport.mjs");
const { startFakeD2lForAudit, TEST_COURSE_CODE, TEST_COURSES, fullCoverage } = await import("./fake-d2l-audit.mjs");

if (!SESSION_FILE.includes("brightspace-mcp-deadlinesexport-")) {
  console.error("FATAL: deadlinesExport test is not sandboxed, refusing to run (would touch " + SESSION_FILE + ")");
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

const validUnscheduled = {
  course: TEST_COURSE_CODE,
  title: "Final project",
  type: "project",
  optional: false,
  reason: "Only mentioned in the syllabus as 'end of term', no date posted yet",
};

async function main() {
  // 0. update_calendar_json has nothing to patch yet
  await expectThrows("update rejected when no export exists yet", () => updateDeadlinesExport({ deadlines: [validDeadline] }));

  // 1. Valid, fully-covered input round-trips to a real file
  const result = await buildAndSaveDeadlinesExport(client, {
    courses: TEST_COURSES,
    ...fullCoverage(),
    deadlines: [validDeadline],
    unscheduled: [validUnscheduled],
  });
  check("valid + fully-covered input succeeds", existsSync(result.savedTo));
  check("eventCount reported", result.eventCount === 1);
  check("unscheduledCount reported", result.unscheduledCount === 1);

  const written = JSON.parse(await readFile(result.savedTo, "utf8"));
  check("schemaVersion auto-filled", written.schemaVersion === "1.0.0");
  check("timezone auto-filled to America/New_York", written.timezone === "America/New_York");
  check("generated is a real date", /^\d{4}-\d{2}-\d{2}$/.test(written.generated));
  check("deadline round-trips", written.deadlines[0].id === "test101-homework-0");
  check("unscheduled round-trips", written.unscheduled[0].reason === validUnscheduled.reason);

  // 1b. update_calendar_json needs no client and no coverage lists at all —
  // add a new deadline, overwrite an existing one, and promote the
  // unscheduled item to a real deadline in one call.
  const updateResult = await updateDeadlinesExport({
    deadlines: [
      { ...validDeadline, title: "Homework 0 (renamed)" }, // same id -> overwrite
      { ...validDeadline, id: "test101-homework-1", title: "Homework 1" }, // new id -> append
      {
        course: TEST_COURSE_CODE,
        id: "test101-final-project",
        title: "Final project",
        type: "project",
        optional: false,
        date: "2026-12-10",
        time: "23:59",
        dueDateTime: "2026-12-10T23:59:00-05:00",
        source: "syllabus",
        confidence: "confirmed",
        description: "Now has a real date.",
      },
    ],
    removeUnscheduled: [{ course: validUnscheduled.course, title: validUnscheduled.title }],
  });
  check("update reports the merged eventCount (2 original-ish + 1 new = 3)", updateResult.eventCount === 3);
  check("update reports unscheduledCount 0 after promoting the only item", updateResult.unscheduledCount === 0);

  const afterUpdate = JSON.parse(await readFile(EXPORT_DIR + "/deadlines.json", "utf8"));
  const renamed = afterUpdate.deadlines.find((d) => d.id === "test101-homework-0");
  check("update overwrote the existing deadline by id", renamed?.title === "Homework 0 (renamed)");
  check("update appended a new deadline", afterUpdate.deadlines.some((d) => d.id === "test101-homework-1"));
  check("update's removeUnscheduled actually removed it", afterUpdate.unscheduled.length === 0);
  check("update refreshed the generated date", /^\d{4}-\d{2}-\d{2}$/.test(afterUpdate.generated));

  // 2. Incomplete coverage is rejected even though the schema is valid
  await expectThrows("incomplete document coverage rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      documentsChecked: { [TEST_COURSE_CODE]: [] },
      deadlines: [validDeadline],
      unscheduled: [],
    })
  );

  // 3. null date/time/dueDateTime allowed (genuinely unknown time)
  const nullDateResult = await buildAndSaveDeadlinesExport(client, {
    courses: TEST_COURSES,
    ...fullCoverage(),
    deadlines: [{ ...validDeadline, id: "test101-tbd-quiz", date: null, time: null, dueDateTime: null }],
    unscheduled: [],
  });
  check("null date/time/dueDateTime accepted", existsSync(nullDateResult.savedTo));

  // 4. Missing required field (description) rejected
  await expectThrows("missing required field rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      deadlines: [(() => {
        const { description, ...rest } = validDeadline;
        return rest;
      })()],
      unscheduled: [],
    })
  );

  // 5. Bad enum value rejected
  await expectThrows("bad type enum rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      deadlines: [{ ...validDeadline, type: "homework" }],
      unscheduled: [],
    })
  );

  // 6. Bad id pattern rejected (uppercase / spaces not allowed)
  await expectThrows("bad id pattern rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      deadlines: [{ ...validDeadline, id: "TEST101 Homework 0" }],
      unscheduled: [],
    })
  );

  // 7. Deadline referencing a course code not in `courses` rejected
  await expectThrows("unknown course reference rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      deadlines: [{ ...validDeadline, course: "NOTREAL" }],
      unscheduled: [],
    })
  );

  // 8. Unscheduled item missing required `reason` rejected
  await expectThrows("unscheduled missing reason rejected", () =>
    buildAndSaveDeadlinesExport(client, {
      courses: TEST_COURSES,
      ...fullCoverage(),
      deadlines: [],
      unscheduled: [(() => {
        const { reason, ...rest } = validUnscheduled;
        return rest;
      })()],
    })
  );

  server.close();
  await rm(EXPORT_DIR, { recursive: true, force: true });
  await rm(path.dirname(SESSION_FILE), { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All deadlinesExport.mjs checks passed.");
}

main();
