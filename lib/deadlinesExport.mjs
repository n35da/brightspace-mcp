// Builds and saves a JSON export matching the schema consumed by the
// optional companion web calendar at https://n35da.com/tools/d2l-calendar
// (fall26-deadlines.schema.json, v1.0.0). Schema enforcement (enums,
// id/date/time patterns, cross-references) plus the mechanical full-coverage
// check live in lib/courseAudit.mjs, shared with full_course_audit.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditInputShape, auditInputSchema, updateInputShape, updateInputSchema, verifyCourseRefs, verifyFullCoverage, mergeUpdate, todayDate } from "./courseAudit.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXPORT_DIR = path.join(__dirname, "..", "exports");
export const EXPORT_FILE = path.join(EXPORT_DIR, "deadlines.json");

export const deadlinesExportShape = auditInputShape;
export const updateDeadlinesExportShape = updateInputShape;

function buildDoc(parsed) {
  return {
    schemaVersion: "1.0.0",
    generated: todayDate(),
    timezone: "America/New_York",
    ...(parsed.student ? { student: parsed.student } : {}),
    ...(parsed.term ? { term: parsed.term } : {}),
    courses: parsed.courses,
    deadlines: parsed.deadlines,
    unscheduled: parsed.unscheduled,
  };
}

/** Validate deadlines-export input against the calendar app's schema,
 * cross-check course references, mechanically verify every document/
 * assignment/quiz in every configured course was actually checked (throws
 * if not), and write the finished document to exports/deadlines.json —
 * replacing any previous export. Returns { savedTo, eventCount, unscheduledCount }. */
export async function buildAndSaveDeadlinesExport(client, input) {
  const parsed = auditInputSchema.parse(input);
  verifyCourseRefs(parsed);
  await verifyFullCoverage(client, parsed);

  const doc = buildDoc(parsed);

  await mkdir(EXPORT_DIR, { recursive: true });
  await writeFile(EXPORT_FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return { savedTo: EXPORT_FILE, eventCount: parsed.deadlines.length, unscheduledCount: parsed.unscheduled.length };
}

/** Lightweight patch to the existing export at exports/deadlines.json — no
 * D2L access, no coverage re-check. For "there's one new assignment" or
 * "fix this one date" after a full export_calendar_json already ran; never
 * requires redoing the full audit. Throws if no export exists yet. */
export async function updateDeadlinesExport(input) {
  if (!existsSync(EXPORT_FILE)) {
    throw new Error(`No existing export at ${EXPORT_FILE} — call export_calendar_json first to create one.`);
  }
  const existingDoc = JSON.parse(await readFile(EXPORT_FILE, "utf8"));
  const updates = updateInputSchema.parse(input);

  const merged = mergeUpdate(existingDoc, updates);
  verifyCourseRefs(merged);

  const doc = { ...merged, generated: todayDate() };
  await writeFile(EXPORT_FILE, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return { savedTo: EXPORT_FILE, eventCount: doc.deadlines.length, unscheduledCount: doc.unscheduled.length };
}
