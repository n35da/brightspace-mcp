// Decides whether a downloaded file's bytes should be embedded directly as
// plain text in an MCP tool result (as an EmbeddedResource content block,
// per the MCP spec), so the calling model can read the file straight from
// the conversation instead of needing separate filesystem-read permission.
//
// Deliberately text-only. An earlier version also base64-blobbed non-text
// files (PDFs, Office formats, images) — two separate live test runs showed
// that was actively harmful: a scanned/image-only PDF and an .xlsx both
// came back as inert base64 the calling model couldn't parse, reported as
// `inlined: true` anyway, and the model treated that false confidence as
// "this file is unreadable" instead of reaching for its own document/OCR
// tooling on the saved path. Plain text has no such ambiguity — decoding it
// as UTF-8 either produces the real content or it doesn't apply here at
// all — so that's the only case this inlines.
//
// The cap is small on purpose: this is now always literal text tokens (not
// base64), which cost roughly one token per ~4 characters, so a large file
// here would burn a lot of context for a single document.
export const MAX_INLINE_BYTES = 256 * 1024; // 256 KB

const TEXT_MIME_TYPES = new Set(["application/json", "application/xml", "application/x-ipynb+json"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".json", ".ipynb", ".csv", ".xml", ".yml", ".yaml"]);

function isTextLike(mimeType, filename) {
  if (mimeType.startsWith("text/")) return true;
  if (TEXT_MIME_TYPES.has(mimeType.split(";")[0].trim())) return true;
  const ext = (filename || "").toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return ext ? TEXT_EXTENSIONS.has(ext) : false;
}

/** Build the extra MCP content block for a downloaded file's bytes, or null
 * if it isn't text-like or is too large to inline — either way the caller
 * still has the file saved to disk via saveDownload. */
export function buildResourceContent({ buffer, contentType, filename, savedTo }) {
  if (buffer.length > MAX_INLINE_BYTES) return null;
  const mimeType = contentType || "application/octet-stream";
  if (!isTextLike(mimeType, filename)) return null;
  const uri = `file://${savedTo.replace(/\\/g, "/")}`;
  return { type: "resource", resource: { uri, mimeType, text: buffer.toString("utf8") } };
}
