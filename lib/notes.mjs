import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const NOTES_DIR = path.join(__dirname, "..", "notes");

/** Fixed section order for every class notes file — keep in sync with the
 * McpServer `instructions` string in server.mjs, which is the copy a calling
 * model actually reads to learn this convention. */
export const NOTES_SECTIONS = ["Class Information", "Schedule", "Notes"];

const LAST_UPDATED_RE = /^_Last updated: (.+)_\s*\n?/;

export function notesPathFor(label) {
  const safe = label.replace(/[\\/:*?"<>|]/g, "_").trim();
  return path.join(NOTES_DIR, `${safe}.md`);
}

/** Parse a notes file into { [section]: { updatedAt: string|null, body: string } }. */
function parseSections(md) {
  const sections = {};
  const headingRe = /^## (.+)$/gm;
  const headings = [];
  let match;
  while ((match = headingRe.exec(md))) {
    headings.push({ name: match[1].trim(), bodyStart: headingRe.lastIndex });
  }
  for (let i = 0; i < headings.length; i++) {
    const bodyEnd = i + 1 < headings.length ? md.indexOf("## ", headings[i].bodyStart) : md.length;
    let raw = md.slice(headings[i].bodyStart, bodyEnd).trim();
    const stampMatch = raw.match(LAST_UPDATED_RE);
    const updatedAt = stampMatch ? stampMatch[1].trim() : null;
    if (stampMatch) raw = raw.slice(stampMatch[0].length).trim();
    sections[headings[i].name] = { updatedAt, body: raw };
  }
  return sections;
}

function render(label, name, orgUnitId, sections) {
  const lines = [`# ${label}${name ? ` — ${name}` : ""}`, "", `<!-- msu-d2l-mcp:notes v1 | orgUnitId: ${orgUnitId} -->`, ""];
  for (const section of NOTES_SECTIONS) {
    const entry = sections[section];
    lines.push(`## ${section}`, "");
    if (entry?.updatedAt) lines.push(`_Last updated: ${entry.updatedAt}_`, "");
    lines.push(entry?.body?.length ? entry.body : "_Not yet filled in._", "");
  }
  return lines.join("\n").trimEnd() + "\n";
}

/** Read a class's notes file, structured with each section's own
 * Last-updated timestamp so a caller can judge staleness per section
 * (Schedule goes stale fast; Class Information rarely changes).
 * Returns null if the file hasn't been created yet. */
export async function readClassNotes(label) {
  const filePath = notesPathFor(label);
  if (!existsSync(filePath)) return null;
  const raw = await readFile(filePath, "utf8");
  return { raw, sections: parseSections(raw) };
}

/** Replace one section's body and stamp it with the current time, creating
 * the file (with the other sections left as untouched/placeholder) if it
 * doesn't exist yet. Returns the saved path. */
export async function saveClassNotesSection({ orgUnitId, label, name, section, content }) {
  if (!NOTES_SECTIONS.includes(section)) {
    throw new Error(`Unknown section "${section}". Must be one of: ${NOTES_SECTIONS.join(", ")}`);
  }
  const filePath = notesPathFor(label);
  const existing = existsSync(filePath) ? parseSections(await readFile(filePath, "utf8")) : {};
  existing[section] = { updatedAt: new Date().toISOString(), body: content.trim() };
  await mkdir(NOTES_DIR, { recursive: true });
  await writeFile(filePath, render(label, name, orgUnitId, existing), "utf8");
  return filePath;
}
