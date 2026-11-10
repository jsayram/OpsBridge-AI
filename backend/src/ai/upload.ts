// P5.1 under DEC-003 ("Stay free, fixtures only"): there is no hosted owner upload. The route
// still exists so the PRD security tests (E2E-13) have something real to hit: it authorizes,
// checks the bytes without parsing them, and then refuses. Nothing is stored anywhere.
//
// These are cheap byte checks that fit the Workers Free CPU limit. They are not a PDF parser and
// don't claim a file is safe; they only refuse files that are plainly wrong or plainly active.

export const MAX_UPLOAD_BYTES = 1_048_576;
export const MAX_UPLOAD_PAGES = 20;

export type UploadVerdict =
  | { ok: true; size: number; pages: number }
  | { ok: false; status: 413 | 415 | 422; code: string };

// Features that can run code, open something or carry another file.
const ACTIVE = [
  "/JavaScript",
  "/JS",
  "/OpenAction",
  "/AA",
  "/Launch",
  "/EmbeddedFile",
  "/RichMedia",
  "/XFA",
  "/SubmitForm",
  "/GoToR",
];

const latin1 = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return s;
};

export function checkUpload(declaredType: string | undefined, bytes: Uint8Array): UploadVerdict {
  if (bytes.length > MAX_UPLOAD_BYTES) return { ok: false, status: 413, code: "file_too_large" };
  const type = (declaredType ?? "").split(";")[0]?.trim().toLowerCase();
  if (type !== "application/pdf") return { ok: false, status: 415, code: "unsupported_type" };
  if (bytes.length < 64) return { ok: false, status: 422, code: "malformed_pdf" };
  const text = latin1(bytes);
  // Magic bytes: a renamed image or script claiming to be a PDF stops here.
  if (!text.startsWith("%PDF-1.") && !text.startsWith("%PDF-2.")) {
    return { ok: false, status: 415, code: "type_mismatch" };
  }
  const tail = text.slice(-1024);
  if (
    !tail.includes("%%EOF") ||
    !/\bstartxref\b/.test(tail) ||
    !/\btrailer\b|\/XRef\b/.test(text)
  ) {
    return { ok: false, status: 422, code: "malformed_pdf" };
  }
  // Name tokens end at a delimiter, so /JS doesn't match /JSONish text.
  for (const name of ACTIVE) {
    if (new RegExp(`${name.replace("/", "\\/")}(?![A-Za-z0-9])`).test(text)) {
      return { ok: false, status: 422, code: "active_content" };
    }
  }
  // Compressed object streams can hide the names above, so they are refused outright.
  if (/\/ObjStm\b/.test(text)) return { ok: false, status: 422, code: "unscannable_pdf" };
  const pages = (text.match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length;
  if (pages < 1) return { ok: false, status: 422, code: "malformed_pdf" };
  if (pages > MAX_UPLOAD_PAGES) return { ok: false, status: 413, code: "too_many_pages" };
  return { ok: true, size: bytes.length, pages };
}
