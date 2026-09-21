import { unwrapList } from "./d2lClient.mjs";

/** Recursively walk a course's content tree (root modules -> nested modules/topics)
 * and return a flat list of every topic, tagged with which module(s) it's nested
 * under and whether it's a downloadable file (vs. a link, quiz link, etc). */
export async function getContentTree(client, orgUnitId) {
  const root = await client.get((c) => c.le(orgUnitId, "/content/root/"));
  const topics = [];
  await walk(client, orgUnitId, unwrapList(root), [], topics);
  return topics;
}

async function walk(client, orgUnitId, items, modulePath, out) {
  for (const item of items) {
    if (item.Type === 1) {
      // The root/structure TOC entries only carry Id/Title/Type — TopicType,
      // Url and IsBroken live on the full ContentObject, one call per topic.
      // A dangling TOC entry (deleted/moved content) 404s here — flag it and
      // keep walking instead of killing the whole course listing.
      let detail = null;
      try {
        detail = await client.get((c) => c.le(orgUnitId, `/content/topics/${item.Id}`));
      } catch {
        detail = null;
      }
      out.push({
        id: item.Id,
        title: item.Title,
        modulePath: modulePath.join(" > ") || null,
        topicType: detail?.TopicType ?? null,
        isBroken: detail ? (detail.IsBroken ?? false) : true,
        downloadable: detail?.TopicType === 1 && !detail.IsBroken,
        url: detail?.Url ?? null,
      });
    } else if (item.Type === 0) {
      // Module. content/root/ doesn't always populate Structure inline, so
      // fetch it explicitly when missing.
      const children = item.Structure?.length
        ? item.Structure
        : unwrapList(await client.get((c) => c.le(orgUnitId, `/content/modules/${item.Id}/structure/`)));
      await walk(client, orgUnitId, children, [...modulePath, item.Title], out);
    }
  }
}
