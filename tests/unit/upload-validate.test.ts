import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkUpload, MAX_UPLOAD_BYTES } from "../../backend/src/ai/upload";

const pdf = new Uint8Array(readFileSync("sample-data/documents/pdf/fx-standard-01.pdf"));
const text = (s: string) => new TextEncoder().encode(s);
const withTail = (body: string) =>
  text(`%PDF-1.7\n${body}\ntrailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n`);

describe("upload byte checks (P5.1, E2E-13)", () => {
  it("passes a real fixture PDF", () => {
    expect(checkUpload("application/pdf", pdf)).toMatchObject({ ok: true, pages: 1 });
  });
  it("refuses a file over the size cap", () => {
    expect(checkUpload("application/pdf", new Uint8Array(MAX_UPLOAD_BYTES + 1))).toMatchObject({
      ok: false,
      status: 413,
      code: "file_too_large",
    });
  });
  it("refuses a declared type other than PDF", () => {
    expect(checkUpload("image/png", pdf)).toMatchObject({ status: 415, code: "unsupported_type" });
    expect(checkUpload(undefined, pdf)).toMatchObject({ code: "unsupported_type" });
  });
  it("refuses a spoofed file that claims to be a PDF", () => {
    const png = new Uint8Array(readFileSync("sample-data/documents/pdf/fx-messy-29.pdf")).slice(0);
    png.set(text("\x89PNG\r\n\x1a\n"), 0);
    expect(checkUpload("application/pdf", png)).toMatchObject({ code: "type_mismatch" });
    expect(
      checkUpload("application/pdf", text(`#!/bin/sh\n${"echo hi\n".repeat(20)}`)),
    ).toMatchObject({
      code: "type_mismatch",
    });
  });
  it("refuses a malformed or truncated PDF", () => {
    expect(checkUpload("application/pdf", pdf.slice(0, pdf.length - 200))).toMatchObject({
      code: "malformed_pdf",
    });
    expect(checkUpload("application/pdf", text(`%PDF-1.7\n${"x".repeat(200)}`))).toMatchObject({
      code: "malformed_pdf",
    });
  });
  it("refuses active content and unscannable streams", () => {
    for (const name of [
      "/JavaScript",
      "/JS (app.alert(1))",
      "/OpenAction 5 0 R",
      "/Launch",
      "/EmbeddedFile",
      "/AA <<>>",
    ]) {
      expect(
        checkUpload("application/pdf", withTail(`1 0 obj << /Type /Page ${name} >> endobj`)),
      ).toMatchObject({
        code: "active_content",
      });
    }
    expect(
      checkUpload(
        "application/pdf",
        withTail("1 0 obj << /Type /ObjStm >> endobj 2 0 obj << /Type /Page >>"),
      ),
    ).toMatchObject({
      code: "unscannable_pdf",
    });
  });
  it("refuses too many pages", () => {
    const pages = Array.from(
      { length: 21 },
      (_, i) => `${i + 2} 0 obj << /Type /Page >> endobj`,
    ).join("\n");
    expect(checkUpload("application/pdf", withTail(pages))).toMatchObject({
      status: 413,
      code: "too_many_pages",
    });
  });
});
