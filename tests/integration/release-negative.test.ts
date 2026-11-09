// P7.2: the integrated negative suite. Every operation in docs/design/openapi.yaml is called by
// the wrong caller: nobody, a guest with forged owner tokens, a cross-site page, another
// workspace's IDs, a viewer, and malformed IDs. Driven by the spec, so a route added later is
// swept without anyone remembering to add it (tests/unit/openapi.test.ts keeps the spec and the
// Worker in step). The per-module suites hold the deeper cases; this is the cross-cutting net.
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { LOCAL_DOUBLE_AUDIENCE, LOCAL_DOUBLE_ISSUER } from "../../backend/src/auth/accessJwt";
// @ts-expect-error plain ESM script without types
import { loadSpec, operations } from "../../scripts/openapi-lint.mjs";
import {
  call,
  connect,
  type Guest,
  idempotencyKey,
  launch,
  mintOwnerToken,
  OWNER_SUBJECT,
  ownerEnv,
  setRole,
  syncAll,
} from "./harness";

type Op = { method: string; path: string; op: { security?: unknown[]; operationId: string } };
const OPS: Op[] = operations(loadSpec());
const OWNER_WS = "00000000-0000-4000-8000-000000000002";
const isWrite = (o: Op) => o.method !== "get";
const isPublic = (o: Op) => Array.isArray(o.op.security) && o.op.security.length === 0;
const isOwnerOnly = (o: Op) =>
  Array.isArray(o.op.security) &&
  o.op.security.length > 0 &&
  o.op.security.every((s) => Object.keys(s as object)[0] === "ownerSession");
// Session housekeeping every role may do. Nothing here touches business records.
const SESSION_OPS = new Set(["POST /api/v1/demo/reset", "POST /api/v1/demo/role"]);
const key = (o: Op) => `${o.method.toUpperCase()} ${o.path}`;

// Plausible bodies, so a refusal comes from authorization and not from a missing field.
const BODIES: Record<string, Record<string, unknown>> = {
  "POST /api/v1/demo/role": { role: "manager" },
  "POST /api/v1/cases": {
    title: "Negative suite",
    customerId: "{customer}",
    caseType: "Onboarding",
  },
  "PATCH /api/v1/cases/{id}": { version: 1, title: "changed by the wrong caller" },
  "POST /api/v1/cases/{id}/reopen": { reason: "negative suite", version: 1 },
  "POST /api/v1/cases/{id}/handoffs": {
    reason: "negative suite",
    expectedCaseVersion: 1,
    toQueue: "Field Services",
  },
  "PATCH /api/v1/cases/{id}/checklist/{itemId}": { state: "done", version: 1 },
  "POST /api/v1/cases/{id}/documents/from-fixture": { fixtureId: "fx-standard-02" },
  "POST /api/v1/documents/{id}/review": { mode: "fixture" },
  "POST /api/v1/ai-reviews/{id}/preview": { edits: { clientName: "x" } },
  "POST /api/v1/ai-reviews/{id}/decision": {
    decision: "reject",
    version: 1,
    reason: "negative suite",
  },
  "POST /api/v1/approvals/{id}/decision": { decision: "approve", caseVersion: 1 },
  "POST /api/v1/reconciliation/{id}/advance": { to: "Investigating", version: 1 },
  "POST /api/v1/reconciliation/{id}/resolve": {
    decision: "reject",
    version: 1,
    reason: "negative suite",
  },
  "POST /api/v1/integrations/{id}/sync": {},
  "PATCH /api/v1/automations/rules/{id}": { version: 1, enabled: false },
  "POST /api/v1/automations/rules/{id}/reuse": { queue: "Seasonal Staffing" },
  "POST /api/v1/automations/simulate": { type: "case.created" },
  "POST /api/v1/admin/automations/pause": { paused: true, reason: "negative suite" },
  "POST /api/v1/admin/automations/runs/{id}/confirm": { evidenceRef: "Events!A2" },
};

// Reads whose query string is required.
const REQUIRED_QUERY: Record<string, string> = {
  "GET /api/v1/analytics/trends": "?metric=open_cases",
};

// Which table each path parameter names, by the route it sits in.
const KIND: [RegExp, string, string][] = [
  [/^\/api\/v1\/cases\/\{id\}/, "id", "cases"],
  [/\/checklist\/\{itemId\}/, "itemId", "case_checklist_items"],
  [/^\/api\/v1\/documents\/\{id\}/, "id", "documents"],
  [/^\/api\/v1\/ai-reviews\/\{id\}/, "id", "ai_reviews"],
  [/^\/api\/v1\/approvals\/\{id\}/, "id", "approvals"],
  [/^\/api\/v1\/reconciliation\/customers\/\{id\}/, "id", "customers"],
  [/^\/api\/v1\/reconciliation\/\{id\}/, "id", "reconciliation_findings"],
  [/^\/api\/v1(\/admin)?\/integrations\/\{id\}/, "id", "external_connections"],
  [/\/runs\/\{runId\}/, "runId", "sync_runs"],
  [/^\/api\/v1\/automations\/rules\/\{id\}/, "id", "workflow_rules"],
  [/^\/api\/v1(\/admin)?\/automations\/runs\/\{id\}/, "id", "outbox"],
];
const TABLES = [...new Set(KIND.map((k) => k[2]))];

type Ids = Record<string, string>;
async function idsOf(workspaceId: string): Promise<Ids> {
  const mig = await connect("opsbridge_migrator");
  try {
    const out: Ids = {};
    for (const t of TABLES) {
      const { rows } = await mig.query(
        `SELECT id FROM app.${t} WHERE workspace_id = $1 ORDER BY id LIMIT 1`,
        [workspaceId],
      );
      if (rows[0]) out[t] = rows[0].id;
    }
    return out;
  } finally {
    await mig.end();
  }
}

// Fills path parameters from one workspace's IDs. Returns null if that workspace has no row of
// the kind, so the caller can count what it couldn't sweep instead of passing silently.
function fill(o: Op, ids: Ids, fallback?: string): string | null {
  let path = o.path;
  for (const name of [...o.path.matchAll(/\{(\w+)\}/g)].map((m) => m[1] as string)) {
    const kind = KIND.find(([re, param]) => param === name && re.test(o.path))?.[2];
    const value = fallback ?? (kind ? ids[kind] : undefined);
    if (!value) return null;
    path = path.replace(`{${name}}`, encodeURIComponent(value));
  }
  return path;
}

const body = (o: Op, ids: Ids) => {
  const b = BODIES[key(o)];
  if (!b) return undefined;
  return JSON.parse(JSON.stringify(b).replace('"{customer}"', JSON.stringify(ids.customers ?? "")));
};

async function hit(o: Op, path: string, opts: Parameters<typeof call>[1] = {}, ids: Ids = {}) {
  const b = isWrite(o) ? body(o, ids) : undefined;
  return call(path, {
    method: o.method.toUpperCase(),
    ...(b !== undefined ? { body: b } : isWrite(o) ? { rawBody: "{}" } : {}),
    ...opts,
    headers: { ...idempotencyKey(), ...(opts.headers ?? {}) },
  });
}

// Everything a workspace owns, hashed per table, so "changed nothing" is checked, not assumed.
async function fingerprint(workspaceId: string) {
  const mig = await connect("opsbridge_migrator");
  try {
    const { rows: tables } = await mig.query(
      `SELECT c.table_name FROM information_schema.columns c
         JOIN information_schema.tables t USING (table_schema, table_name)
        WHERE c.table_schema = 'app' AND c.column_name = 'workspace_id'
          AND t.table_type = 'BASE TABLE' ORDER BY 1`,
    );
    const out: Record<string, string> = {};
    for (const { table_name: t } of tables) {
      // last_seen_at moves on every request the session itself makes, which these never are.
      const { rows } = await mig.query(
        `SELECT count(*)::int AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h
           FROM app.${t} x WHERE workspace_id = $1`,
        [workspaceId],
      );
      out[t] = `${rows[0].n}:${rows[0].h}`;
    }
    return out;
  } finally {
    await mig.end();
  }
}

const refusal = (status: number) => status >= 400 && status < 500;

let a: Guest;
let b: Guest;
let aIds: Ids;
let bIds: Ids;
let ownerIds: Ids;

beforeAll(async () => {
  a = await launch();
  b = await launch();
  for (const g of [a, b]) {
    await setRole(g.cookie, "manager");
    await syncAll(g.cookie);
    const doc = await call(`/api/v1/cases/${g.caseId}/documents/from-fixture`, {
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: { fixtureId: "fx-standard-02" },
    });
    expect(doc.status).toBe(201);
    const rev = await call(`/api/v1/documents/${doc.json.id}/review`, {
      cookie: g.cookie,
      body: {},
    });
    expect(rev.status).toBeLessThan(300);
    // A simulated event, so the outbox has a row to aim at.
    const created = await call("/api/v1/cases", {
      cookie: g.cookie,
      headers: idempotencyKey(),
      body: {
        title: "Negative suite seed",
        customerId: (await idsOf(g.workspaceId)).customers,
        caseType: "Onboarding",
      },
    });
    expect(created.status).toBe(201);
  }
  aIds = await idsOf(a.workspaceId);
  bIds = await idsOf(b.workspaceId);
  ownerIds = await idsOf(OWNER_WS);
}, 120_000);

describe("P7.2 spec-driven negative sweep", () => {
  it("the sweep has a row of every kind in both guests, so nothing is skipped", () => {
    for (const t of TABLES) {
      expect(aIds[t], `guest A has no ${t}`).toBeTruthy();
      expect(bIds[t], `guest B has no ${t}`).toBeTruthy();
    }
    expect(OPS.length).toBeGreaterThanOrEqual(64);
  });

  it("positive control: the right caller succeeds on every read, so refusals below mean something", async () => {
    const wrong: string[] = [];
    for (const o of OPS.filter((x) => !isWrite(x) && !isPublic(x) && !/callback/.test(x.path))) {
      const owner = isOwnerOnly(o);
      const path = fill(o, owner ? ownerIds : aIds);
      if (!path) continue;
      const res = await call(path + (REQUIRED_QUERY[key(o)] ?? ""), {
        cookie: owner ? "" : a.cookie,
        ...(owner
          ? { env: ownerEnv, headers: { "cf-access-jwt-assertion": await mintOwnerToken() } }
          : {}),
      });
      if (res.status >= 300) wrong.push(`${key(o)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("no caller: every protected operation refuses, none answers 2xx or 5xx", async () => {
    const wrong: string[] = [];
    for (const o of OPS.filter((x) => !isPublic(x))) {
      const path = (fill(o, aIds) ?? fill(o, {}, "00000000-0000-4000-8000-0000000000aa")) as string;
      const res = await hit(o, path, {}, aIds);
      if (!refusal(res.status)) wrong.push(`${key(o)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
  });

  it("a guest with forged owner credentials reaches no owner operation", async () => {
    const stranger = await generateKeyPair("RS256", { extractable: true });
    const now = Math.floor(Date.now() / 1000);
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "double-1" })
      .setIssuer(LOCAL_DOUBLE_ISSUER)
      .setAudience(LOCAL_DOUBLE_AUDIENCE)
      .setSubject(OWNER_SUBJECT)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(stranger.privateKey);
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const none = `${enc({ alg: "none", kid: "double-1" })}.${enc({ iss: LOCAL_DOUBLE_ISSUER, aud: LOCAL_DOUBLE_AUDIENCE, sub: OWNER_SUBJECT, exp: now + 300 })}.`;
    expect((await exportJWK(stranger.publicKey)).kty).toBe("RSA");
    const wrong: string[] = [];
    for (const o of OPS.filter(isOwnerOnly)) {
      const path = fill(o, ownerIds) ?? fill(o, {}, "00000000-0000-4000-8000-0000000000aa");
      for (const token of [forged, none, "not-a-jwt"]) {
        const res = await hit(
          o,
          path as string,
          {
            cookie: a.cookie,
            env: ownerEnv,
            headers: { "cf-access-jwt-assertion": token, "x-demo-role": "admin" },
          },
          ownerIds,
        );
        if (!refusal(res.status)) wrong.push(`${key(o)} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("a cross-site page can't make a guest write anything (CSRF)", async () => {
    const before = await fingerprint(a.workspaceId);
    const wrong: string[] = [];
    for (const o of OPS.filter((x) => isWrite(x) && !isPublic(x) && !isOwnerOnly(x))) {
      const path = (fill(o, aIds) ?? fill(o, {}, "00000000-0000-4000-8000-0000000000aa")) as string;
      for (const origin of [
        "https://evil.example",
        null,
        "null",
        "http://localhost:8787.evil.example",
      ]) {
        const res = await hit(o, path, { cookie: a.cookie, origin }, aIds);
        if (res.status !== 403) wrong.push(`${key(o)} origin=${origin} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(await fingerprint(a.workspaceId)).toEqual(before);
  });

  it("guest A aiming at guest B's and the owner's IDs gets refusals and changes nothing (BOLA)", async () => {
    const targets = [
      { name: "guest B", ws: b.workspaceId, ids: bIds },
      { name: "owner", ws: OWNER_WS, ids: ownerIds },
    ];
    const swept: string[] = [];
    for (const t of targets) {
      const before = await fingerprint(t.ws);
      const wrong: string[] = [];
      for (const o of OPS.filter((x) => /\{\w+\}/.test(x.path) && !isOwnerOnly(x))) {
        // Mixed IDs too: A's case with the other side's checklist item.
        const variants = [fill(o, t.ids)];
        if (o.path.includes("{itemId}"))
          variants.push(
            fill(o, { ...aIds, case_checklist_items: t.ids.case_checklist_items as string }),
          );
        for (const path of variants) {
          if (!path) continue;
          const res = await hit(o, path, { cookie: a.cookie }, aIds);
          swept.push(`${t.name} ${key(o)}`);
          if (!refusal(res.status)) wrong.push(`${t.name} ${key(o)} -> ${res.status}`);
          for (const id of Object.values(t.ids)) {
            if (res.text.includes(id) && !path.includes(encodeURIComponent(id))) {
              wrong.push(`${t.name} ${key(o)} echoed another ID`);
            }
          }
        }
      }
      expect(wrong).toEqual([]);
      expect(await fingerprint(t.ws)).toEqual(before);
    }
    // Guest B has a row of every kind, so every operation with an ID was swept against it.
    const sweptB = new Set(swept.filter((s) => s.startsWith("guest B ")).map((s) => s.slice(8)));
    const withIds = OPS.filter((x) => /\{\w+\}/.test(x.path) && !isOwnerOnly(x)).map(key);
    expect(withIds.filter((k) => !sweptB.has(k))).toEqual([]);
  });

  it("a viewer can't change a business record through any operation", async () => {
    const v = await launch();
    await setRole(v.cookie, "viewer");
    const ids = await idsOf(v.workspaceId);
    const before = await fingerprint(v.workspaceId);
    const wrong: string[] = [];
    for (const o of OPS.filter((x) => isWrite(x) && !isPublic(x) && !isOwnerOnly(x))) {
      if (SESSION_OPS.has(key(o))) continue;
      const path = fill(o, ids);
      if (!path) continue;
      const res = await hit(o, path, { cookie: v.cookie }, ids);
      // Read-only previews answer 200 to a viewer; they store nothing, which the fingerprint checks.
      if (res.status < 300 && !/simulate|preview/.test(o.path))
        wrong.push(`${key(o)} -> ${res.status}`);
      if (res.status >= 500) wrong.push(`${key(o)} -> ${res.status}`);
    }
    expect(wrong).toEqual([]);
    const after = await fingerprint(v.workspaceId);
    // The refusals are audited (P2), so only the audit log may grow.
    const { audit_events: _a, ...rest } = after;
    const { audit_events: _b, ...restBefore } = before;
    expect(rest).toEqual(restBefore);
  });

  it("malformed and hostile IDs are 4xx on every operation, never a database error", async () => {
    const wrong: string[] = [];
    const bad = [
      "not-a-uuid",
      "' OR '1'='1",
      "../../etc/passwd",
      "%00",
      "00000000-0000-4000-8000-000000000002;DROP TABLE app.cases",
      "a".repeat(3000),
    ];
    for (const o of OPS.filter((x) => /\{\w+\}/.test(x.path) && !isPublic(x))) {
      for (const v of bad) {
        const res = await hit(
          o,
          fill(o, {}, v) as string,
          { cookie: a.cookie, env: ownerEnv },
          aIds,
        );
        if (!refusal(res.status)) wrong.push(`${key(o)} id=${v.slice(0, 20)} -> ${res.status}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("no guest-reachable request body accepts a URL, host or destination (SSRF, E2E-17)", () => {
    const spec = loadSpec();
    const risky: string[] = [];
    const walk = (node: unknown, at: string) => {
      if (!node || typeof node !== "object") return;
      const n = node as Record<string, unknown>;
      for (const [k, v] of Object.entries((n.properties as object) ?? {})) {
        if (/url|uri|host|endpoint|webhook|destination|callback|redirect/i.test(k))
          risky.push(`${at}.${k}`);
        walk(v, `${at}.${k}`);
      }
      if (n.items) walk(n.items, `${at}[]`);
    };
    for (const o of OPS.filter((x) => isWrite(x) && !isOwnerOnly(x))) {
      const schema = (o.op as { requestBody?: { content?: Record<string, { schema?: unknown }> } })
        .requestBody?.content?.["application/json"]?.schema;
      walk(schema, key(o));
    }
    expect(risky).toEqual([]);
  });
});
