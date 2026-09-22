import { unwrapList } from "./d2lClient.mjs";

/** List one course's dropbox folders (assignments), each with its due date,
 * points, instructor attachments, and the caller's own latest submission
 * (if any). Extracted so both the get_assignments tool and the audit engine
 * (lib/courseAudit.mjs) share one implementation. */
export async function getAssignments(client, orgUnitId) {
  const raw = await client.get((c) => c.le(orgUnitId, "/dropbox/folders/"));
  const folders = unwrapList(raw).filter((f) => !f.IsHidden);
  return Promise.all(
    folders.map(async (f) => {
      let submission = null;
      try {
        const subs = unwrapList(await client.get((c) => c.le(orgUnitId, `/dropbox/folders/${f.Id}/submissions/mysubmissions/`)));
        const last = subs[subs.length - 1];
        submission = last
          ? {
              id: last.Id,
              submittedDate: last.SubmissionDate ?? null,
              files: (last.Files ?? []).map((file) => ({
                fileId: file.FileId,
                fileName: file.FileName,
                size: file.Size ?? null,
              })),
            }
          : null;
      } catch {
        submission = null; // not fatal — some folders 403 for non-file-submission types
      }
      return {
        id: f.Id,
        name: f.Name,
        dueDate: f.DueDate ?? null,
        totalPoints: f.Assessment?.ScoreOutOf ?? null,
        attachments: (f.Attachments ?? []).map((a) => ({
          fileId: a.FileId,
          fileName: a.FileName,
          size: a.Size ?? null,
        })),
        submission,
      };
    })
  );
}
