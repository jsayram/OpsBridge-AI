// P7.1: every project SAST rule must trip on a planted example and stay quiet on safe code.
// The planted files live in a temporary folder; nothing here is committed source.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const run = (files) => {
  const root = mkdtempSync(join(tmpdir(), "sast-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return spawnSync("node", ["scripts/sast.mjs", root], { encoding: "utf8" });
};

describe("project SAST rules", () => {
  it.each([
    [
      "xss-raw-html",
      "frontend/src/a.tsx",
      "export const A = () => <div dangerouslySetInnerHTML={{ __html: x }} />;",
    ],
    ["code-injection", "frontend/src/b.ts", "export const f = (s: string) => new Function(s);"],
    [
      "ssrf-unreviewed-fetch",
      "backend/src/routes/c.ts",
      "export const g = (u: string) => fetch(u);",
    ],
    ["weak-random", "backend/src/auth/d.ts", "export const token = () => String(Math.random());"],
    ["raw-console", "backend/src/routes/e.ts", "console.log(secret);"],
    ["cookie-flags", "backend/src/routes/f.ts", 'setCookie(c, "s", t, {\n  path: "/",\n});'],
    [
      "sql-interpolation",
      "backend/src/repo/g.ts",
      "export const q = (db, name) => db.query(`SELECT * FROM app.cases WHERE title = '${name}'`);",
    ],
  ])("%s trips", (rule, path, text) => {
    const r = run({ [path]: text });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`[${rule}]`);
  });

  it("passes safe code: bound values, constant fragments, a reviewed opt-out", () => {
    const r = run({
      "backend/src/repo/ok.ts": [
        'const COLUMNS = "id, title";',
        "export const q = (db, id) => db.query(`SELECT ${COLUMNS} FROM app.cases WHERE id = $1`, [id]);",
        "// sast-ok: one of two constant fragments",
        'export const r = (db, s) => db.query(`SELECT 1 WHERE ${s ? COLUMNS : "1"}`);',
      ].join("\n"),
      "backend/src/routes/cookie.ts":
        'setCookie(c, "s", t, {\n  httpOnly: true,\n  secure: true,\n  sameSite: "Strict",\n});',
    });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("passes on this repository", () => {
    expect(spawnSync("node", ["scripts/sast.mjs"], { encoding: "utf8" }).status).toBe(0);
  });
});
