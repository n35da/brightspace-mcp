// Validates lib/resourceContent.mjs: text-like files embed as plain text;
// everything else (PDFs, Office formats, unknown binary) is never inlined,
// regardless of size, since a base64 blob of those formats isn't something
// the calling model can actually read (confirmed by two live test runs
// where inlined: true on an unreadable file caused the model to give up on
// it instead of using proper document/OCR tooling on the saved path).
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

  // 2. PDF (binary) is never inlined, no matter how small
  {
    const buffer = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0x10]);
    const block = buildResourceContent({ buffer, contentType: "application/pdf", filename: "syllabus.pdf", savedTo: "/tmp/syllabus.pdf" });
    check("pdf -> never inlined (null)", block === null);
  }

  // 3. .xlsx (binary Office format) is never inlined
  {
    const buffer = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // zip/xlsx magic bytes
    const block = buildResourceContent({
      buffer,
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      filename: "schedule.xlsx",
      savedTo: "/tmp/schedule.xlsx",
    });
    check(".xlsx -> never inlined (null)", block === null);
  }

  // 4. .ipynb (JSON under the hood) embeds as text even with a generic content-type
  {
    const buffer = Buffer.from('{"cells": []}', "utf8");
    const block = buildResourceContent({ buffer, contentType: "application/octet-stream", filename: "homework0.ipynb", savedTo: "/tmp/homework0.ipynb" });
    check(".ipynb -> embedded as text via extension, despite generic content-type", block.resource.text === '{"cells": []}');
  }

  // 5. application/json content-type embeds as text regardless of extension
  {
    const buffer = Buffer.from('{"a":1}', "utf8");
    const block = buildResourceContent({ buffer, contentType: "application/json", filename: "data", savedTo: "/tmp/data" });
    check("application/json -> embedded as text", block.resource.text === '{"a":1}');
  }

  // 6. Oversized text buffer is never inlined
  {
    const buffer = Buffer.alloc(MAX_INLINE_BYTES + 1, "a");
    const block = buildResourceContent({ buffer, contentType: "text/plain", filename: "huge.txt", savedTo: "/tmp/huge.txt" });
    check("oversized text file -> null (not inlined)", block === null);
  }

  // 7. Text exactly at the cap is still inlined (boundary is inclusive)
  {
    const buffer = Buffer.alloc(MAX_INLINE_BYTES, "a");
    const block = buildResourceContent({ buffer, contentType: "text/plain", filename: "exact.txt", savedTo: "/tmp/exact.txt" });
    check("text file exactly at the cap -> still inlined", block !== null);
  }

  // 8. Missing content-type with an unrecognized extension is never inlined
  {
    const buffer = Buffer.from("some bytes", "utf8");
    const block = buildResourceContent({ buffer, contentType: undefined, filename: "mystery.bin", savedTo: "/tmp/mystery.bin" });
    check("unknown content-type/extension -> never inlined (null)", block === null);
  }

  // 9. Windows-style backslash path is normalized in the uri
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
