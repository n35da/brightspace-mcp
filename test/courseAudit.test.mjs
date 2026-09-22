// Validates lib/courseAudit.mjs's mechanical coverage check against a real
// fake D2L backend (not a mocked object): verifyFullCoverage must pass when
// every document/assignment/quiz is checked, and reject — naming exactly
// what's missing — when any one of them isn't. This is the gate that
// replaced three rounds of instruction-only wording after live testing
// showed the model can silently skip a document no matter how the
// instructions are worded.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

process.env.MSU_D2L_SESSION_DIR = await mkdtemp(path.join(tmpdir(), "brightspace-mcp-courseaudit-"));
const { D2LClient, saveSession, SESSION_FILE } = await import("../lib/d2lClient.mjs");
const { verifyFullCoverage, verifyCourseRefs } = await import("../lib/courseAudit.mjs");
const { startFakeD2lForAudit, TEST_COURSE_CODE, TEST_COURSES, TEST_TOPIC_ID, TEST_FOLDER_ID, TEST_QUIZ_ID, fullCoverage } = await import(
  "./fake-d2l-audit.mjs"
);

if (!SESSION_FILE.includes("brightspace-mcp-courseaudit-")) {
  console.error("FATAL: courseAudit test is not sandboxed, refusing to run (would touch " + SESSION_FILE + ")");
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
async function expectRejection(label, fn, expectedSubstring) {
  try {
    await fn();
    check(label, false);
  } catch (err) {
    check(label, err.message.includes(expectedSubstring));
  }
}

const { server, baseUrl } = await startFakeD2lForAudit();
await saveSession({ baseUrl, cookieHeader: "x", csrfToken: "x", accessToken: "fake-token" });
const client = await D2LClient.fromSavedSession();

async function main() {
  // 1. Full coverage passes without throwing
  await verifyFullCoverage(client, { courses: TEST_COURSES, ...fullCoverage() });
  check("full coverage does not throw", true);

  // 2. Missing document is named in the rejection
  await expectRejection(
    "missing document rejected, names topic id and title",
    () => verifyFullCoverage(client, { courses: TEST_COURSES, ...fullCoverage(), documentsChecked: { [TEST_COURSE_CODE]: [] } }),
    `${TEST_TOPIC_ID} (Syllabus)`
  );

  // 3. Missing assignment is named in the rejection
  await expectRejection(
    "missing assignment rejected, names folder id and name",
    () => verifyFullCoverage(client, { courses: TEST_COURSES, ...fullCoverage(), assignmentsChecked: { [TEST_COURSE_CODE]: [] } }),
    `${TEST_FOLDER_ID} (HW1)`
  );

  // 4. Missing quiz is named in the rejection
  await expectRejection(
    "missing quiz rejected, names quiz id and name",
    () => verifyFullCoverage(client, { courses: TEST_COURSES, ...fullCoverage(), quizzesChecked: { [TEST_COURSE_CODE]: [] } }),
    `${TEST_QUIZ_ID} (Quiz1)`
  );

  // 5. A course with no checked-lists at all (defaults) is treated as nothing checked
  await expectRejection(
    "omitted checked-lists default to empty, so everything is reported missing",
    () => verifyFullCoverage(client, { courses: TEST_COURSES, documentsChecked: {}, assignmentsChecked: {}, quizzesChecked: {} }),
    "Coverage incomplete"
  );

  // 6. verifyCourseRefs rejects a deadline referencing an unknown course
  let refError = null;
  try {
    verifyCourseRefs({ courses: TEST_COURSES, deadlines: [{ course: "NOTREAL" }], unscheduled: [] });
  } catch (e) {
    refError = e;
  }
  check("verifyCourseRefs rejects unknown course reference", refError?.message.includes("NOTREAL"));

  // 7. verifyCourseRefs passes for a valid reference
  let refOk = true;
  try {
    verifyCourseRefs({ courses: TEST_COURSES, deadlines: [{ course: TEST_COURSE_CODE }], unscheduled: [] });
  } catch {
    refOk = false;
  }
  check("verifyCourseRefs passes for a known course reference", refOk);

  server.close();
  await rm(path.dirname(SESSION_FILE), { recursive: true, force: true });

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All courseAudit.mjs checks passed.");
}

main();
