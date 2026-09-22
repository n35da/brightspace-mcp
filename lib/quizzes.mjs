import { unwrapList } from "./d2lClient.mjs";

/** List one course's quizzes. Extracted so both the get_quizzes tool and the
 * audit engine (lib/courseAudit.mjs) share one implementation. */
export async function getQuizzes(client, orgUnitId) {
  const raw = await client.get((c) => c.le(orgUnitId, "/quizzes/"));
  return unwrapList(raw).map((q) => ({
    id: q.QuizId,
    name: q.Name,
    isActive: q.IsActive,
    startDate: q.StartDate ?? null,
    endDate: q.EndDate ?? null,
    dueDate: q.DueDate ?? q.EndDate ?? null,
  }));
}
