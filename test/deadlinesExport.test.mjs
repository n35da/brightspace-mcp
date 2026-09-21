// Validates lib/deadlinesExport.mjs against the real calendar-app schema
// shape: valid input round-trips to a file, and every rejection path
// (missing field, bad enum, bad id pattern, unknown course reference)
// throws instead of silently writing a malformed export.
import { readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { buildAndSaveDeadlinesExport, EXPORT_DIR } from "../lib/deadlinesExport.mjs";

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

const validCourses = {
  CSE404: { orgUnitId: 12345, name: "Intro to Computer Security" },
};

const validDeadline = {
  id: "cse404-homework-0",
  course: "CSE404",
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
  course: "CSE404",
  title: "Final project",
  type: "project",
  optional: false,
  reason: "Only mentioned in the syllabus as 'end of term', no date posted yet",
};

async function main() {
  // 1. Valid input round-trips to a real file
  const result = await buildAndSaveDeadlinesExport({
    courses: validCourses,
    deadlines: [validDeadline],
    unscheduled: [validUnscheduled],
  });
  check("valid input succeeds", existsSync(result.savedTo));
  check("eventCount reported", result.eventCount === 1);
  check("unscheduledCount reported", result.unscheduledCount === 1);

  const written = JSON.parse(await readFile(result.savedTo, "utf8"));
  check("schemaVersion auto-filled", written.schemaVersion === "1.0.0");
  check("timezone auto-filled to America/New_York", written.timezone === "America/New_York");
  check("generated is a real date", /^\d{4}-\d{2}-\d{2}$/.test(written.generated));
  check("deadline round-trips", written.deadlines[0].id === "cse404-homework-0");
  check("unscheduled round-trips", written.unscheduled[0].reason === validUnscheduled.reason);

  // 2. null date/time/dueDateTime allowed (genuinely unknown time, still dated... actually null date case)
  const nullDateResult = await buildAndSaveDeadlinesExport({
    courses: validCourses,
    deadlines: [{ ...validDeadline, id: "cse404-tbd-quiz", date: null, time: null, dueDateTime: null }],
    unscheduled: [],
  });
  check("null date/time/dueDateTime accepted", existsSync(nullDateResult.savedTo));

  // 3. Missing required field (description) rejected
  await expectThrows("missing required field rejected", () =>
    buildAndSaveDeadlinesExport({
      courses: validCourses,
      deadlines: [(() => {
        const { description, ...rest } = validDeadline;
        return rest;
      })()],
      unscheduled: [],
    })
  );

  // 4. Bad enum value rejected
  await expectThrows("bad type enum rejected", () =>
    buildAndSaveDeadlinesExport({
      courses: validCourses,
      deadlines: [{ ...validDeadline, type: "homework" }],
      unscheduled: [],
    })
  );

  // 5. Bad id pattern rejected (uppercase / spaces not allowed)
  await expectThrows("bad id pattern rejected", () =>
    buildAndSaveDeadlinesExport({
      courses: validCourses,
      deadlines: [{ ...validDeadline, id: "CSE404 Homework 0" }],
      unscheduled: [],
    })
  );

  // 6. Deadline referencing a course code not in `courses` rejected
  await expectThrows("unknown course reference rejected", () =>
    buildAndSaveDeadlinesExport({
      courses: validCourses,
      deadlines: [{ ...validDeadline, course: "CSE999" }],
      unscheduled: [],
    })
  );

  // 7. Unscheduled item missing required `reason` rejected
  await expectThrows("unscheduled missing reason rejected", () =>
    buildAndSaveDeadlinesExport({
      courses: validCourses,
      deadlines: [],
      unscheduled: [(() => {
        const { reason, ...rest } = validUnscheduled;
        return rest;
      })()],
    })
  );

  await rm(EXPORT_DIR, { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All deadlinesExport.mjs checks passed.");
}

main();
