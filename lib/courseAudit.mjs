// Shared engine behind export_calendar_json and full_course_audit: the
// input shape both tools accept, and the mechanical coverage check that
// makes "did you actually open everything" an enforced gate instead of an
// instruction the calling model can silently skip.
//
// Three rounds of instruction-only wording ("open every document", "don't
// give up after one failure") measurably improved thoroughness but never
// reliably matched a maximally diligent one-off run. This closes the gap
// mechanically: both tools independently re-fetch each configured course's
// live content tree, assignments, and quizzes themselves (never trusting
// the caller's claim that data exists or was checked), and reject the call
// outright if any downloadable document, dropbox assignment, or quiz isn't
// named in the caller's documentsChecked/assignmentsChecked/quizzesChecked
// lists for that course.
import { z } from "zod";
import { getContentTree } from "./content.mjs";
import { getAssignments } from "./assignments.mjs";
import { getQuizzes } from "./quizzes.mjs";

const DEADLINE_TYPES = ["assignment", "quiz", "exam", "project", "other"];
const DEADLINE_SOURCES = [
  "d2l_dropbox",
  "d2l_quiz_tool",
  "announcement",
  "syllabus",
  "schedule_doc",
  "lecture_slide",
  "course_email",
];
const CONFIDENCE_LEVELS = ["confirmed", "tentative"];
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Raw zod shape (not wrapped in z.object) shared by export_calendar_json
 * and full_course_audit — single source of truth for both tools' protocol
 * schema and this module's internal validation. */
const courseEntrySchema = z.object({
  orgUnitId: z.number().int().describe("The course's orgUnitId from list_courses"),
  name: z.string().describe("Full course title"),
  grading: z.record(z.string()).optional().describe("Grade-weight breakdown by component, as free text"),
});

export const deadlineItemSchema = z.object({
  id: z
    .string()
    .regex(ID_PATTERN, "id must be a lowercase kebab-case slug, e.g. 'cse325-assignment-2'")
    .describe("Stable slug: <course-lowercase>-<title-slug>, so re-import can diff instead of duplicating"),
  course: z.string().describe("Course code, must be a key in courses"),
  title: z.string(),
  type: z.enum(DEADLINE_TYPES),
  optional: z.boolean().describe("True if extra-credit/bonus/honors-only, not required for the base grade"),
  date: z.string().regex(DATE_PATTERN).nullable().describe("Local due date YYYY-MM-DD, or null if genuinely unknown"),
  time: z.string().regex(TIME_PATTERN).nullable().describe("Local due time, 24h HH:MM, or null if no specific time"),
  dueDateTime: z
    .string()
    .nullable()
    .describe(
      "Absolute instant combining date+time+the correct UTC offset for that date (e.g. '2026-09-30T23:55:00-04:00'), or null if date or time is null"
    ),
  weight: z.string().nullable().optional().describe("Grade weight if known, free text, e.g. '5% of grade'"),
  location: z.string().nullable().optional().describe("Physical location for in-person items, else null"),
  submissionMethod: z.string().nullable().optional(),
  source: z.enum(DEADLINE_SOURCES),
  confidence: z.enum(CONFIDENCE_LEVELS),
  description: z.string(),
  notes: z.string().nullable().optional(),
});

export const unscheduledItemSchema = z.object({
  course: z.string().describe("Course code, must be a key in courses"),
  title: z.string(),
  type: z.enum(DEADLINE_TYPES),
  optional: z.boolean(),
  weight: z.string().nullable().optional().describe("Grade weight if known, even though the date isn't"),
  reason: z.string().describe("Why no date is available yet"),
});

export const auditInputShape = {
  student: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
    })
    .optional()
    .describe(
      "Optional — whose calendar this export belongs to. Only include this if the user has confirmed they're fine with their name/email going into this third-party import; otherwise omit it."
    ),
  term: z
    .object({
      name: z.string(),
      start: z.string().regex(DATE_PATTERN).describe("YYYY-MM-DD"),
      end: z.string().regex(DATE_PATTERN).describe("YYYY-MM-DD"),
    })
    .optional()
    .describe("The academic term this export covers"),
  courses: z
    .record(courseEntrySchema)
    .describe("Map of course code -> course metadata. Every course code used in deadlines/unscheduled must be a key here."),
  documentsChecked: z
    .record(z.array(z.number()))
    .default({})
    .describe(
      "Map of course code -> array of content-tree topic ids (the `id` field from get_course_content) you called download_content_file on for that course. Every downloadable topic in a configured course must appear here, or this call is rejected naming exactly which ones are missing."
    ),
  assignmentsChecked: z
    .record(z.array(z.number()))
    .default({})
    .describe(
      "Map of course code -> array of dropbox folder ids (the `id` field from get_assignments) you accounted for. Every assignment in a configured course must appear here, or this call is rejected naming exactly which ones are missing."
    ),
  quizzesChecked: z
    .record(z.array(z.number()))
    .default({})
    .describe(
      "Map of course code -> array of quiz ids (the `id` field from get_quizzes) you accounted for. Every quiz in a configured course must appear here, or this call is rejected naming exactly which ones are missing."
    ),
  deadlines: z.array(deadlineItemSchema).describe("Every dated deliverable found so far, across all courses"),
  unscheduled: z
    .array(unscheduledItemSchema)
    .describe("Real, graded components confirmed to exist but with no date posted anywhere yet"),
};

export const auditInputSchema = z.object(auditInputShape);

/** Cross-check every deadlines[]/unscheduled[] `course` exists in `courses`. */
export function verifyCourseRefs(parsed) {
  const missing = new Set();
  for (const d of parsed.deadlines) if (!(d.course in parsed.courses)) missing.add(d.course);
  for (const u of parsed.unscheduled) if (!(u.course in parsed.courses)) missing.add(u.course);
  if (missing.size) {
    throw new Error(`deadlines/unscheduled reference course code(s) not present in courses: ${[...missing].join(", ")}`);
  }
}

/** For every course in parsed.courses, independently re-fetch its live
 * content tree, assignments, and quizzes, and confirm every downloadable
 * document, assignment, and quiz is named in the matching checked list.
 * Throws one aggregated Error naming exactly what's still unchecked, per
 * course, if anything's missing — the caller has to go check it and retry. */
export async function verifyFullCoverage(client, parsed) {
  const problems = [];
  for (const [code, course] of Object.entries(parsed.courses)) {
    const [contentTree, assignments, quizzes] = await Promise.all([
      getContentTree(client, course.orgUnitId),
      getAssignments(client, course.orgUnitId),
      getQuizzes(client, course.orgUnitId),
    ]);

    const checkedDocs = new Set(parsed.documentsChecked[code] ?? []);
    const missingDocs = contentTree.filter((t) => t.downloadable && !checkedDocs.has(t.id));

    const checkedAssignments = new Set(parsed.assignmentsChecked[code] ?? []);
    const missingAssignments = assignments.filter((a) => !checkedAssignments.has(a.id));

    const checkedQuizzes = new Set(parsed.quizzesChecked[code] ?? []);
    const missingQuizzes = quizzes.filter((q) => !checkedQuizzes.has(q.id));

    if (missingDocs.length || missingAssignments.length || missingQuizzes.length) {
      const parts = [];
      if (missingDocs.length) {
        parts.push(`documents not opened: ${missingDocs.map((t) => `${t.id} (${t.title})`).join(", ")}`);
      }
      if (missingAssignments.length) {
        parts.push(`assignments not accounted for: ${missingAssignments.map((a) => `${a.id} (${a.name})`).join(", ")}`);
      }
      if (missingQuizzes.length) {
        parts.push(`quizzes not accounted for: ${missingQuizzes.map((q) => `${q.id} (${q.name})`).join(", ")}`);
      }
      problems.push(`${code}: ${parts.join("; ")}`);
    }
  }
  if (problems.length) {
    throw new Error(`Coverage incomplete — go check these before retrying:\n${problems.join("\n")}`);
  }
}

/** Raw zod shape for the lightweight update tools (update_calendar_json,
 * update_course_audit): a small patch to an existing export/audit, not a
 * full re-audit. No documentsChecked/assignmentsChecked/quizzesChecked here
 * on purpose — this path is for "there's one new assignment" or "fix this
 * one date" after a full audit already exists, and deliberately doesn't
 * re-verify D2L coverage, so it never touches the network. */
export const updateInputShape = {
  courses: z
    .record(courseEntrySchema)
    .optional()
    .describe("Course code -> metadata to add or overwrite. Courses not listed here are left untouched."),
  deadlines: z
    .array(deadlineItemSchema)
    .optional()
    .describe(
      "Deadlines to add or replace, matched by id — an id matching an existing deadline overwrites it, a new id is appended. Deadlines not listed here are left untouched."
    ),
  unscheduled: z
    .array(unscheduledItemSchema)
    .optional()
    .describe(
      "Unscheduled items to add or replace, matched by (course, title). Unscheduled items not listed here are left untouched."
    ),
  removeUnscheduled: z
    .array(z.object({ course: z.string(), title: z.string() }))
    .optional()
    .describe(
      "Unscheduled items to remove, matched by (course, title) — use this when something that had no date now does: add it to deadlines and remove it here in the same call."
    ),
};

export const updateInputSchema = z.object(updateInputShape);

/** Merge a small patch into an existing parsed export/audit document.
 * Deadlines upsert by id; unscheduled items upsert/remove by (course,
 * title); courses shallow-merge by code. Everything not mentioned in
 * `updates` is left exactly as it was. */
export function mergeUpdate(existingDoc, updates) {
  const courses = { ...existingDoc.courses, ...(updates.courses ?? {}) };

  const deadlinesById = new Map(existingDoc.deadlines.map((d) => [d.id, d]));
  for (const d of updates.deadlines ?? []) deadlinesById.set(d.id, d);

  const unscheduledKey = (item) => `${item.course}\u0000${item.title}`;
  const unscheduledByKey = new Map(existingDoc.unscheduled.map((u) => [unscheduledKey(u), u]));
  for (const u of updates.unscheduled ?? []) unscheduledByKey.set(unscheduledKey(u), u);
  for (const r of updates.removeUnscheduled ?? []) unscheduledByKey.delete(unscheduledKey(r));

  return {
    ...existingDoc,
    courses,
    deadlines: [...deadlinesById.values()],
    unscheduled: [...unscheduledByKey.values()],
  };
}
