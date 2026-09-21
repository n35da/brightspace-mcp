// Builds and saves a JSON export matching the schema consumed by the
// optional companion web calendar at https://n35da.com/tools/d2l-calendar
// (fall26-deadlines.schema.json, v1.0.0). This module owns schema
// enforcement (enums, id/date/time patterns, cross-references) so the
// calling model's synthesis of deadlines from get_assignments/get_quizzes/
// syllabi/lecture slides can't produce a file the calendar app rejects.
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const EXPORT_DIR = path.join(__dirname, "..", "exports");

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

/** Raw zod shape (not wrapped in z.object) so server.mjs can spread this
 * directly into an MCP tool's inputSchema — single source of truth for both
 * the tool's protocol-level schema and this module's internal validation. */
export const deadlinesExportShape = {
  student: z
    .object({
      name: z.string().optional(),
      email: z.string().email().optional(),
    })
    .optional()
    .describe("Optional — whose calendar this export belongs to"),
  term: z
    .object({
      name: z.string(),
      start: z.string().regex(DATE_PATTERN).describe("YYYY-MM-DD"),
      end: z.string().regex(DATE_PATTERN).describe("YYYY-MM-DD"),
    })
    .optional()
    .describe("The academic term this export covers"),
  courses: z
    .record(
      z.object({
        orgUnitId: z.number().int().describe("The course's orgUnitId from list_courses"),
        name: z.string().describe("Full course title"),
        grading: z.record(z.string()).optional().describe("Grade-weight breakdown by component, as free text"),
      })
    )
    .describe("Map of course code -> course metadata. Every course code used in deadlines/unscheduled must be a key here."),
  deadlines: z
    .array(
      z.object({
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
      })
    )
    .describe("Every dated deliverable found so far, across all courses"),
  unscheduled: z
    .array(
      z.object({
        course: z.string().describe("Course code, must be a key in courses"),
        title: z.string(),
        type: z.enum(DEADLINE_TYPES),
        optional: z.boolean(),
        weight: z.string().nullable().optional().describe("Grade weight if known, even though the date isn't"),
        reason: z.string().describe("Why no date is available yet"),
      })
    )
    .describe("Real, graded components confirmed to exist but with no date posted anywhere yet"),
};

const deadlinesExportSchema = z.object(deadlinesExportShape);

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

/** Validate deadlines-export input against the calendar app's schema, cross-check
 * every deadlines[]/unscheduled[] `course` exists in `courses`, and write the
 * finished document to exports/. Returns { savedTo, eventCount, unscheduledCount }. */
export async function buildAndSaveDeadlinesExport(input) {
  const parsed = deadlinesExportSchema.parse(input);

  const missingCourseRefs = new Set();
  for (const d of parsed.deadlines) {
    if (!(d.course in parsed.courses)) missingCourseRefs.add(d.course);
  }
  for (const u of parsed.unscheduled) {
    if (!(u.course in parsed.courses)) missingCourseRefs.add(u.course);
  }
  if (missingCourseRefs.size) {
    throw new Error(`deadlines/unscheduled reference course code(s) not present in courses: ${[...missingCourseRefs].join(", ")}`);
  }

  const doc = {
    schemaVersion: "1.0.0",
    generated: todayDate(),
    timezone: "America/New_York",
    ...(parsed.student ? { student: parsed.student } : {}),
    ...(parsed.term ? { term: parsed.term } : {}),
    courses: parsed.courses,
    deadlines: parsed.deadlines,
    unscheduled: parsed.unscheduled,
  };

  await mkdir(EXPORT_DIR, { recursive: true });
  const savedTo = path.join(EXPORT_DIR, `deadlines-${doc.generated}.json`);
  await writeFile(savedTo, JSON.stringify(doc, null, 2) + "\n", "utf8");

  return { savedTo, eventCount: parsed.deadlines.length, unscheduledCount: parsed.unscheduled.length };
}
