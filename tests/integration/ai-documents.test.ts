import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { asOwner, library } from "./ai-double";
import { OWNER_WORKSPACE_ID } from "./automation-helpers";
import { call, connect, counts, type Guest, idempotencyKey, launch, setRole } from "./harness";

const OWNER_CASE_ID = "00000000-0000-4000-8000-000000000004";
const TEMPLATE_CASE = async () => {
  const mig = await connect("opsbridge_migrator");
  const { rows } = await mig.query(
    `SELECT d.id AS doc, d.case_id FROM app.documents d
      WHERE d.workspace_id = '00000000-0000-4000-8000-000000000001' AND d.fixture_id = 'fx-adversarial-31'`,
  );
  await mig.end();
  return rows[0];
};

const attach = (g: Guest, caseId: string, fixtureId: string) =>
  call(`/api/v1/cases/${caseId}/documents/from-fixture`, {
    cookie: g.cookie,
    headers: idempotencyKey(),
    body: { fixtureId },
  });

describe("fixture document lifecycle (P5.1 under DEC-003)", () => {
  let A: Guest;
  let B: Guest;
  beforeAll(async () => {
    A = await launch();
    B = await launch();
    await setRole(A.cookie, "analyst");
  });

  it("lists the 40 allowlisted fixtures, 20 standard, 10 messy, 10 adversarial", async () => {
    const res = await call("/api/v1/fixtures/documents", { cookie: A.cookie });
    expect(res.status).toBe(200);
    const by = (c: string) =>
      res.json.items.filter((i: { category: string }) => i.category === c).length;
    expect([res.json.items.length, by("standard"), by("messy"), by("adversarial")]).toEqual([
      40, 20, 10, 10,
    ]);
  });

  it("stores the build-time hash of every fixture PDF", async () => {
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT fixture_id, encode(sha256, 'hex') AS sha FROM app.fixture_documents ORDER BY fixture_id",
    );
    await mig.end();
    for (const r of rows) {
      const entry = library.documents.find(
        (d: { fixtureId: string }) => d.fixtureId === r.fixture_id,
      );
      const bytes = readFileSync(`sample-data/documents/${entry.file}`);
      const sha = (await import("node:crypto")).createHash("sha256").update(bytes).digest("hex");
      expect(r.sha).toBe(sha);
    }
  });

  it("attaches a fixture to the visitor's own case with hash and type, and reads back its segments", async () => {
    const res = await attach(A, A.caseId, "fx-standard-05");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({
      status: "Ready",
      fixtureId: "fx-standard-05",
      category: "standard",
    });
    expect(res.json.sha256).toBe(library.documents[4].sha256);
    const doc = await call(`/api/v1/documents/${res.json.id}`, { cookie: A.cookie });
    expect(doc.status).toBe(200);
    expect(doc.json.segments.length).toBeGreaterThan(5);
    expect(doc.json.segments[0]).toMatchObject({ id: "p1-s1", page: 1 });
    const detail = await call(`/api/v1/cases/${A.caseId}`, { cookie: A.cookie });
    expect(detail.json.documents.some((d: { id: string }) => d.id === res.json.id)).toBe(true);
  });

  it("refuses a fixture ID that isn't on the list", async () => {
    for (const fixtureId of ["fx-not-real", "../../etc/passwd", "https://evil.example.com/x.pdf"]) {
      const res = await attach(A, A.caseId, fixtureId);
      expect(res.status).toBe(422);
      expect(res.json.code).toBe("unknown_fixture");
    }
  });

  it("refuses a viewer, a template case and another workspace's case", async () => {
    const viewer = await launch();
    await setRole(viewer.cookie, "viewer");
    expect((await attach(viewer, viewer.caseId, "fx-standard-01")).status).toBe(403);
    const t = await TEMPLATE_CASE();
    expect((await attach(A, t.case_id, "fx-standard-01")).status).toBe(403);
    expect((await attach(A, B.caseId, "fx-standard-01")).status).toBe(404);
    expect((await attach(A, OWNER_CASE_ID, "fx-standard-01")).status).toBe(404);
  });

  it("lets a guest read a shared template document but not another workspace's", async () => {
    const t = await TEMPLATE_CASE();
    const read = await call(`/api/v1/documents/${t.doc}`, { cookie: B.cookie });
    expect(read.status).toBe(200);
    expect(read.json.readOnly).toBe(true);
    const mine = await attach(A, A.caseId, "fx-standard-06");
    expect((await call(`/api/v1/documents/${mine.json.id}`, { cookie: B.cookie })).status).toBe(
      404,
    );
    const owner = await asOwner(`/api/v1/documents/${mine.json.id}`);
    expect(owner.status).toBe(404);
  });

  it("replays an attach with the same idempotency key", async () => {
    const key = idempotencyKey();
    const first = await call(`/api/v1/cases/${A.caseId}/documents/from-fixture`, {
      cookie: A.cookie,
      headers: key,
      body: { fixtureId: "fx-messy-21" },
    });
    const again = await call(`/api/v1/cases/${A.caseId}/documents/from-fixture`, {
      cookie: A.cookie,
      headers: key,
      body: { fixtureId: "fx-messy-21" },
    });
    expect(again.headers.get("idempotency-replayed")).toBe("true");
    expect(again.json.id).toBe(first.json.id);
  });
});

describe("owner upload route, validation then refusal (E2E-13)", () => {
  const pdf = readFileSync("sample-data/documents/pdf/fx-standard-01.pdf");
  const upload = (
    body: Buffer | string,
    type = "application/pdf",
    extra: Record<string, string> = {},
  ) =>
    asOwner(`/api/v1/cases/${OWNER_CASE_ID}/documents`, {
      method: "POST",
      rawBody: body as unknown as string,
      headers: { "content-type": type, ...extra },
    });

  it("is refused for every guest role before the body is read", async () => {
    const g = await launch();
    for (const role of ["viewer", "analyst", "manager"]) {
      await setRole(g.cookie, role);
      const res = await call(`/api/v1/cases/${g.caseId}/documents`, {
        method: "POST",
        cookie: g.cookie,
        rawBody: "x".repeat(2_000_000),
        headers: { "content-type": "application/pdf" },
      });
      expect(res.status).toBe(403);
    }
  });

  it("refuses bad files with a code and stores nothing", async () => {
    const before = await counts(OWNER_WORKSPACE_ID, ["documents"]);
    const spoofed = Buffer.concat([Buffer.from("\x89PNG\r\n\x1a\n"), pdf.subarray(8)]);
    const active = Buffer.from(
      pdf.toString("latin1").replace("/Type /Catalog", "/Type /Catalog /OpenAction 9 0 R"),
      "latin1",
    );
    const checks: [Buffer | string, string, number, string][] = [
      [Buffer.alloc(1_100_000, 1), "application/pdf", 413, "file_too_large"],
      // The API-wide media-type guard refuses a non-PDF type before the route runs.
      [pdf, "image/png", 415, "unsupported_media_type"],
      [spoofed, "application/pdf", 415, "type_mismatch"],
      [pdf.subarray(0, 400), "application/pdf", 422, "malformed_pdf"],
      [active, "application/pdf", 422, "active_content"],
    ];
    for (const [body, type, status, code] of checks) {
      const res = await upload(body, type);
      expect([res.status, res.json.code]).toEqual([status, code]);
    }
    const ok = await upload(pdf);
    expect([ok.status, ok.json.code]).toEqual([409, "owner_upload_disabled"]);
    expect(await counts(OWNER_WORKSPACE_ID, ["documents"])).toEqual(before);
  });

  it("keeps the 16 KB JSON cap on every other route", async () => {
    const g = await launch();
    const res = await call(`/api/v1/cases/${g.caseId}/documents/from-fixture`, {
      method: "POST",
      cookie: g.cookie,
      headers: idempotencyKey(),
      rawBody: JSON.stringify({ fixtureId: "x".repeat(20_000) }),
    });
    expect(res.status).toBe(413);
  });
});
