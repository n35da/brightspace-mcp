// Decides whether a downloaded file's bytes should be embedded directly in
// an MCP tool result (as an EmbeddedResource content block, per the MCP
// spec), so the calling model can read the file straight from the
// conversation instead of needing separate filesystem-read permission.
// Text-like files embed as plain text (cheaper and more directly useful to
// read); everything else embeds as a base64 blob. Files above
// MAX_INLINE_BYTES are never inlined — the caller still has the file saved
// to disk via saveDownload, this just skips the extra content block.
export const MAX_INLINE_BYTES = 10 * 1024 * 1024; // 10 MB, in line with Anthropic's per-document limit

const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "application/x-ipynb+json"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".ipynb", ".csv", ".xml", ".yml", ".yaml"]);

function isTextLike(mimeType, filename) {
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_MIME_TYPES.has(mimeType.split(";")[0].trim())) return true;
  const ext = (filename || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

/** Build the extra MCP content block for a downloaded file's bytes, or null
 * if it's too large to inline. */
export function buildResourceContent({ buffer, contentType, filename, savedTo }) {
  if (buffer.length > MAX_INLINE_BYTES) return null;
  const mimeType = contentType || "application/octet-stream";
  const uri = `file://${savedTo.replace(/\\/g, "/")}`;
  if (isTextLike(mimeType, filename)) {
    return { type: "resource", resource: { uri, mimeType, text: buffer.toString("utf8") } };
  }
  return { type: "resource", resource: { uri, mimeType, blob: buffer.toString("base64") } };
}
