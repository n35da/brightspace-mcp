// Quick manual sanity check after running `npm run auth` — confirms the
// saved session works against the real D2L API, and shows the effect of
// config.json's courseCodes filter, before wiring this into Claude Desktop.
// Run with: node test/manual-check.mjs
import { D2LClient, unwrapList } from "../lib/d2lClient.mjs";
import { listCourses } from "../lib/courses.mjs";
import { loadConfig } from "../lib/config.mjs";

async function main() {
  console.log("Loading saved session and calling D2L...\n");
  const client = await D2LClient.fromSavedSession();

  const raw = await client.get((c) => c.lp("/enrollments/myenrollments/?orgUnitTypeId=3&isActive=true"));
  const allItems = unwrapList(raw);
  console.log(`D2L returned ${allItems.length} "active" enrollment(s) total (this can include old semesters):\n`);
  for (const item of allItems) {
    console.log(`  [${item.OrgUnit.Id}] ${item.OrgUnit.Code} — ${item.OrgUnit.Name}`);
  }

  const { courseCodes } = await loadConfig();
  const filtered = await listCourses(client);
  console.log(`\nconfig.json courseCodes filter: ${courseCodes.length ? JSON.stringify(courseCodes) : "(none set — showing everything above)"}`);
  console.log(`After filtering, list_courses will return ${filtered.length} course(s):\n`);
  for (const c of filtered) {
    console.log(`  [${c.orgUnitId}] ${c.code} — ${c.name}`);
  }

  if (courseCodes.length && filtered.length !== 6) {
    console.log(
      `\nHeads up: expected 6 courses, got ${filtered.length}. Compare the "all enrollments" list above to config.json's courseCodes and adjust the patterns if a code didn't match.`
    );
  }
}

main().catch((err) => {
  console.error("\nSomething went wrong:", err.message);
  process.exit(1);
});
