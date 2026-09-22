// Shared fake D2L backend for lib/courseAudit.mjs, lib/deadlinesExport.mjs,
// and lib/fullCourseAudit.mjs tests: one course with exactly one
// downloadable content topic, one dropbox assignment, and one quiz, so
// coverage-checking tests have a single, unambiguous item of each kind to
// mark checked or leave unchecked.
import http from "node:http";

export const TEST_ORG_UNIT_ID = 999;
export const TEST_TOPIC_ID = 1;
export const TEST_FOLDER_ID = 10;
export const TEST_QUIZ_ID = 20;

export async function startFakeD2lForAudit() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, "http://localhost").pathname;
    if (p === "/d2l/api/versions/") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ ProductCode: "lp", LatestVersion: "1.55" }, { ProductCode: "le", LatestVersion: "1.90" }]));
      return;
    }
    if (p.endsWith("/content/root/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ Id: TEST_TOPIC_ID, Title: "Syllabus", Type: 1 }]));
      return;
    }
    if (/\/content\/topics\/\d+$/.test(p)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ Id: TEST_TOPIC_ID, TopicType: 1, IsBroken: false, Url: "/x" }));
      return;
    }
    if (p.endsWith("/dropbox/folders/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ Id: TEST_FOLDER_ID, Name: "HW1", IsHidden: false }]));
      return;
    }
    if (/\/dropbox\/folders\/\d+\/submissions\/mysubmissions\/$/.test(p)) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([]));
      return;
    }
    if (p.endsWith("/quizzes/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([{ QuizId: TEST_QUIZ_ID, Name: "Quiz1", IsActive: true }]));
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

/** A minimal valid `courses` entry for the fake server's one test course. */
export const TEST_COURSE_CODE = "TEST101";
export const TEST_COURSES = {
  [TEST_COURSE_CODE]: { orgUnitId: TEST_ORG_UNIT_ID, name: "Test Course" },
};

/** Fully-covered checked-lists matching the fake server's one item of each
 * kind — the "everything checked" baseline tests mutate away from. */
export function fullCoverage() {
  return {
    documentsChecked: { [TEST_COURSE_CODE]: [TEST_TOPIC_ID] },
    assignmentsChecked: { [TEST_COURSE_CODE]: [TEST_FOLDER_ID] },
    quizzesChecked: { [TEST_COURSE_CODE]: [TEST_QUIZ_ID] },
  };
}
