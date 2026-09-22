// Validates lib/resourceContent.mjs: text-like files embed as plain text,
// binary files embed as base64, oversized files are skipped, and content
// type/extension detection covers the file kinds this MCP actually downloads
// (PDFs, .ipynb notebooks, markdown, plain binaries).
import { buildResourceContent, MAX_INLINE_BYTES } from "../lib/resourceContent.mjs";

let failures = 0;
function check(label, cond) {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    failures++;
  } else {
    console.log(`PASS: ${label}`);
  }
}

function main() {
  // 1. text/plain content embeds as text, decoded correctly
  {
    const buffer = Buffer.from("hello syllabus", "utf8");
    const block = buildResourceContent({ buffer, contentType: "text/plain", filename: "notes.txt", savedTo: "/tmp/notes.txt" });
    check("text/plain -> resource block", block?.type === "resource");
    check("text/plain -> text field present", block.resource.text === "hello syllabus");
    check("text/plain -> no blob field", block.resource.blob === undefined);
    check("text/plain -> mimeType passed through", block.resource.mimeType === "text/plain");
    check("text/plain -> file:// uri built from savedTo", block.resource.uri === "file:///tmp/notes.txt");
  }

  // 2. PDF (binary) embeds as base64 blob, not text
  {
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]); // arbitrary bytes incl. non-UTF8
    const block = buildResourceContent({ buffer, contentType: "application/pdf", filename: "syllabus.pdf", savedTo: "/tmp/syllabus.pdf" });
    check("pdf -> resource block", block?.type === "resource");
    check("pdf -> blob field present", block.resource.blob === buffer.toString("base64"));
    check("pdf -> no text field", block.resource.text === undefined);
  }

  // 3. .ipynb (JSON under the hood) embeds as text even with a generic content-type
  {
    const buffer = Buffer.from('{"cells": []}', "utf8");
    const block = buildResourceContent({ buffer, contentType: "application/octet-stream", filename: "homework0.ipynb", savedTo: "/tmp/homework0.ipynb" });
    check(".ipynb -> embedded as text via extension, despite generic content-type", block.resource.text === '{"cells": []}');
  }

  // 4. application/json content-type embeds as text regardless of extension
  {
    const buffer = Buffer.from('{"a":1}', "utf8");
    const block = buildResourceContent({ buffer, contentType: "application/json", filename: "data", savedTo: "/tmp/data" });
    check("application/json -> embedded as text", block.resource.text === '{"a":1}');
  }

  // 5. Oversized buffer is never inlined
  {
    const buffer = Buffer.alloc(MAX_INLINE_BYTES + 1);
    const block = buildResourceContent({ buffer, contentType: "application/pdf", filename: "huge.pdf", savedTo: "/tmp/huge.pdf" });
    check("oversized file -> null (not inlined)", block === null);
  }

  // 6. Exactly at the cap is still inlined (boundary is inclusive)
  {
    const buffer = Buffer.alloc(MAX_INLINE_BYTES);
    const block = buildResourceContent({ buffer, contentType: "application/pdf", filename: "exact.pdf", savedTo: "/tmp/exact.pdf" });
    check("file exactly at the cap -> still inlined", block !== null);
  }

  // 7. Missing content-type with an unrecognized extension falls back to binary-safe blob
  {
    const buffer = Buffer.from("some bytes", "utf8");
    const block = buildResourceContent({ buffer, contentType: undefined, filename: "mystery.bin", savedTo: "/tmp/mystery.bin" });
    check("unknown content-type/extension -> binary-safe blob", block.resource.blob !== undefined && block.resource.text === undefined);
    check("missing contentType -> mimeType defaults to octet-stream", block.resource.mimeType === "application/octet-stream");
  }

  // 8. Windows-style backslash path is normalized in the uri
  {
    const buffer = Buffer.from("x", "utf8");
    const block = buildResourceContent({ buffer, contentType: "text/plain", filename: "x.txt", savedTo: "C:\\Users\\me\\downloads\\x.txt" });
    check("backslash path normalized to forward slashes in uri", block.resource.uri === "file://C:/Users/me/downloads/x.txt");
  }

  if (failures > 0) {
    console.error(`${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("All resourceContent.mjs checks passed.");
}

main();
