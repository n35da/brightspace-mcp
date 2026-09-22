// Builds and saves a full, mechanically-verified course audit for people
// who don't use the companion calendar app. Same input shape and same
// coverage enforcement as lib/deadlinesExport.mjs (see lib/courseAudit.mjs)
// — the only difference is the output isn't shaped to fit a third party's
// schema, so it has no schemaVersion/timezone-const/$schema noise.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditInputShape, auditInputSchema, updateInputShape, updateInputSchema, verifyCourseRefs, verifyFullCoverage, mergeUpdate } from "./courseAudit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const AUDIT_DIR = path.join(__dirname, "..", "audits");
export const AUDIT_FILE = path.join(AUDIT_DIR, "audit.json");

export const fullCourseAuditShape = auditInputShape;
export const updateCourseAuditShape = updateInputShape;

function buildDoc(parsed) {
  return {
    generatedAt: new Date().toISOString(),
    ...(parsed.student ? { student: parsed.student } : {}),
    ...(parsed.term ? { term: parsed.term } : {}),
    courses: parsed.courses,
    deadlines: parsed.deadlines,
    unscheduled: parsed.unscheduled,
  };
}

/** Validate audit input, cross-check course references, mechanically verify
 * every document/assignment/quiz in every configured course was actually
 * checked (throws if not), and write the finished audit to
 * audits/audit.json — replacing any previous audit. Returns
 * { savedTo, eventCount, unscheduledCount, courseCount }. */
export async function buildAndSaveFullAudit(client, input) {
  const parsed = auditInputSchema.parse(input);
  verifyCourseRefs(parsed);
  await verifyFullCoverage(client, parsed);

  const doc = buildDoc(parsed);

  await mkdir(AUDIT_DIR, { recursive: true });
  await writeFile(AUDIT_FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return {
    savedTo: AUDIT_FILE,
    eventCount: parsed.deadlines.length,
    unscheduledCount: parsed.unscheduled.length,
    courseCount: Object.keys(parsed.courses).length,
  };
}

/** Lightweight patch to the existing audit at audits/audit.json — no D2L
 * access, no coverage re-check. For "there's one new assignment" after a
 * full full_course_audit already ran; never requires redoing the full
 * audit. Throws if no audit exists yet. */
export async function updateCourseAudit(input) {
  if (!existsSync(AUDIT_FILE)) {
    throw new Error(`No existing audit at ${AUDIT_FILE} — call full_course_audit first to create one.`);
  }
  const existingDoc = JSON.parse(await readFile(AUDIT_FILE, "utf8"));
  const updates = updateInputSchema.parse(input);

  const merged = mergeUpdate(existingDoc, updates);
  verifyCourseRefs(merged);

  const doc = { ...merged, generatedAt: new Date().toISOString() };
  await writeFile(AUDIT_FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return {
    savedTo: AUDIT_FILE,
    eventCount: doc.deadlines.length,
    unscheduledCount: doc.unscheduled.length,
    courseCount: Object.keys(doc.courses).length,
  };
}
