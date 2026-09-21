import { unwrapList } from "./d2lClient.mjs";
import { loadConfig } from "./config.mjs";

/** Strip everything but letters/digits and uppercase, so "CSE-404-FS26",
 * "CSE 404", and "cse404" all compare equal. */
function normalize(s) {
  return (s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** A stable, human-readable label for a course — used as its notes filename.
 * D2L's Code field is an opaque merge id for cross-listed courses (e.g.
 * "FS26MERGED-yLFxkpjX-..."); the readable "FS26-CSE-CMSE-STT-404-001"
 * prefix only survives in Name, ahead of its " - <title>" suffix. */
export function courseLabel(course) {
  return course.name?.split(" - ")[0] || course.code;
}

/** The human title portion of a course's name, with its label prefix (see
 * courseLabel) stripped off — e.g. "Database Systems" rather than
 * "FS26-CSE-480-001 - Database Systems". */
export function courseTitle(course) {
  const parts = course.name?.split(" - ");
  return parts && parts.length > 1 ? parts.slice(1).join(" - ") : course.name;
}

/** List enrolled courses, narrowed to config.json's courseCodes if set. */
export async function listCourses(client, { activeOnly = true } = {}) {
  const raw = await client.get((c) =>
    c.lp(`/enrollments/myenrollments/?orgUnitTypeId=3${activeOnly ? "&isActive=true" : ""}`)
  );
  const items = unwrapList(raw).map((item) => ({
    orgUnitId: item.OrgUnit.Id,
    code: item.OrgUnit.Code,
    name: item.OrgUnit.Name,
    isActive: item.Access?.IsActive ?? null,
    canAccess: item.Access?.CanAccess ?? null,
  }));

  const { courseCodes } = await loadConfig();
  if (!courseCodes.length) return items;

  const wantedPatterns = courseCodes.map(normalize);
  return items.filter((c) => {
    // D2L gives cross-listed/merged courses (e.g. a CSE/CMSE/STT joint
    // listing) an opaque Code like "FS26MERGED-xxxx-<orgUnitIds>" — the
    // human-readable course number only survives in Name, so both fields
    // have to be checked.
    const haystack = normalize(c.code) + normalize(c.name);
    return wantedPatterns.some((p) => haystack.includes(p));
  });
}
