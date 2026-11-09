// P7.2 and P7-E: the application stays usable while each external provider is unavailable, one
// at a time and then all together (E2E-26). Every provider here is a labeled in-process double
// made to fail, or a fetch stub that refuses; nothing reaches a network. The per-provider fault
// suites (ai-gateway, salesforce, dispatch, faults, owner-identity) hold the detailed cases; this
// file proves the core visitor and owner paths don't depend on any provider being up, and that a
// failure leaves committed business records as they were.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../backend/src/env";
import { clearKeyCache } from "../../backend/src/auth/accessJwt";
import { forgetSheetToken } from "../../backend/src/integrations/sinks";
import { modelDouble } from "./ai-double";
import {
  approvedEvent,
  dispatch,
  insertEvent,
  OWNER_WORKSPACE_ID as OWNER,
  outboxRow,
} from "./automation-helpers";
import {
  call,
  connect,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  setRole,
} from "./harness";
import { doubleEnv } from "./salesforce-double";
import { sheetsDouble } from "./sheets-double";

const OWNER_CASE = "00000000-0000-4000-8000-000000000004";
const down = () => {
  throw new TypeError("fetch failed");
};

type Drill = {
  name: string;
  env: () => Promise<Partial<Bindings>>;
  // Owner identity itself is down: the owner can't sign in, which must fail closed.
  ownerSignsIn: boolean;
  setup?: () => void;
};

const sheetsDown = async () => {
  const d = await sheetsDouble();
  for (let i = 0; i < 50; i++) {
    for (const op of ["token", "read", "append"] as const)
      d.faults.push({ op, fault: { status: 503 } });
  }
  return d.env;
};
const aiDown = async () => modelDouble(down).env;
const salesforceDown = async () => doubleEnv(async () => down());
const accessDown = async (): Promise<Partial<Bindings>> => ({
  OWNER_IDENTITY_MODE: "access",
  ACCESS_TEAM_DOMAIN: "opsbridge-drill.cloudflareaccess.com",
  ACCESS_AUD: "drill-audience",
});
const stubIdentityOutage = () => {
  clearKeyCache();
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("cloudflareaccess.com")) throw new TypeError("fetch failed");
    return real(input, init);
  });
};

const DRILLS: Drill[] = [
  { name: "AI provider", env: aiDown, ownerSignsIn: true },
  { name: "Salesforce", env: salesforceDown, ownerSignsIn: true },
  { name: "Google Sheets bridge", env: sheetsDown, ownerSignsIn: true },
  { name: "Access identity keys", env: accessDown, ownerSignsIn: false, setup: stubIdentityOutage },
  {
    name: "every provider at once (E2E-26)",
    env: async () => ({
      ...(await aiDown()),
      ...(await salesforceDown()),
      ...(await sheetsDown()),
      ...(await accessDown()),
    }),
    ownerSignsIn: false,
    setup: stubIdentityOutage,
  },
];

// The owner's committed records, which no provider failure may change.
async function ownerRecords() {
  const mig = await connect("opsbridge_migrator");
  try {
    const out: Record<string, string> = {};
    for (const t of ["cases", "case_checklist_items", "approvals", "customers", "workflow_rules"]) {
      const { rows } = await mig.query(
        `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h FROM app.${t} x WHERE workspace_id = $1`,
        [OWNER],
      );
      out[t] = rows[0].h;
    }
    return out;
  } finally {
    await mig.end();
  }
}

// The visitor's whole core path. Returns what failed, so one run reports everything.
async function guestPath(env: Partial<Bindings>) {
  const failed: string[] = [];
  const expectOk = (step: string, res: { status: number }, ok = [200, 201]) => {
    if (!ok.includes(res.status)) failed.push(`${step} -> ${res.status}`);
  };
  const g = await launch(env);
  await setRole(g.cookie, "manager");
  const opts = { cookie: g.cookie, env };
  expectOk("list cases", await call("/api/v1/cases", opts));
  const detail = await call(`/api/v1/cases/${g.caseId}`, opts);
  expectOk("case detail", detail);
  expectOk(
    "edit case",
    await call(`/api/v1/cases/${g.caseId}`, {
      ...opts,
      method: "PATCH",
      body: { version: detail.json.version, title: "Edited during an outage drill" },
    }),
  );
  const doc = await call(`/api/v1/cases/${g.caseId}/documents/from-fixture`, {
    ...opts,
    headers: idempotencyKey(),
    body: { fixtureId: "fx-standard-02" },
  });
  expectOk("attach fixture", doc);
  expectOk(
    "fixture review",
    await call(`/api/v1/documents/${doc.json.id}/review`, { ...opts, body: {} }),
  );
  const list = await call("/api/v1/integrations", opts);
  expectOk("integrations", list);
  const crm = (list.json.items ?? []).find(
    (s: { provider: string }) => s.provider === "crm_simulator",
  );
  expectOk(
    "simulated sync",
    await call(`/api/v1/integrations/${crm?.id}/sync`, {
      ...opts,
      headers: idempotencyKey(),
      body: {},
    }),
  );
  expectOk("findings", await call("/api/v1/reconciliation", opts));
  expectOk("automation runs", await call("/api/v1/automations/runs", opts));
  expectOk("analytics", await call("/api/v1/analytics/overview", opts));
  expectOk("report", await call("/api/v1/reports/operations", opts));
  expectOk("export", await call("/api/v1/reports/operations/export", opts));
  expectOk("reset", await call("/api/v1/demo/reset", { ...opts, body: {} }));
  return failed;
}

afterEach(() => {
  vi.restoreAllMocks();
  clearKeyCache();
  forgetSheetToken();
});

describe("P7-E: usable with each provider unavailable", () => {
  for (const drill of DRILLS) {
    it(`${drill.name} down: the visitor path works and owner records don't change`, async () => {
      const env = await drill.env();
      drill.setup?.();
      const before = await ownerRecords();

      expect(await guestPath(env)).toEqual([]);

      // The owner, signed in through the identity double unless identity itself is the outage.
      const ownerOpts = async (extra: Record<string, unknown> = {}) => ({
        env: drill.ownerSignsIn ? { ...env, ...ownerEnv } : { ...ownerEnv, ...env },
        headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
        ...extra,
      });
      const status = await call("/api/v1/admin/status", await ownerOpts());
      if (drill.ownerSignsIn) {
        expect(status.status).toBe(200);
        expect((await call(`/api/v1/cases/${OWNER_CASE}`, await ownerOpts())).status).toBe(200);
        expect((await call("/api/v1/admin/automations", await ownerOpts())).status).toBe(200);
        expect(
          (await call("/api/v1/admin/integrations/salesforce", await ownerOpts())).status,
        ).toBe(200);
      } else {
        // Fails closed, with a typed refusal, never a 500 or a way in.
        expect([401, 403, 503]).toContain(status.status);
        expect(status.text).not.toMatch(/stack|TypeError|fetch failed/);
      }
      expect(await ownerRecords()).toEqual(before);
    });
  }

  it("AI provider down: a live owner review fails with a code after one call and the fixture answers", async () => {
    const d = modelDouble(down);
    const doc = await call(`/api/v1/cases/${OWNER_CASE}/documents/from-fixture`, {
      env: ownerEnv,
      headers: { "cf-access-jwt-assertion": await mintOwnerToken(), ...idempotencyKey() },
      body: { fixtureId: "fx-standard-03" },
    });
    expect(doc.status).toBe(201);
    const before = await ownerRecords();
    const res = await call(`/api/v1/documents/${doc.json.id}/review`, {
      env: { ...ownerEnv, ...d.env },
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      body: { mode: "live" },
    });
    expect(res.status).toBe(201);
    expect(res.json.degraded).toMatch(/^provider_/);
    expect(res.json.fallback).toMatchObject({ mode: "fixture" });
    expect(d.requests.length).toBeLessThanOrEqual(1);
    expect(await ownerRecords()).toEqual(before);
  });

  it("Sheets bridge down: an owner event retries on a schedule and the approval stays durable (E2E-15)", async () => {
    const d = await sheetsDouble();
    for (let i = 0; i < 10; i++) d.faults.push({ op: "token", fault: { status: 503 } });
    const id = await insertEvent(OWNER, "approval.completed", approvedEvent(), "owner");
    const before = await ownerRecords();
    await dispatch({ workspaceId: OWNER }, d);
    const row = await outboxRow(OWNER, id);
    expect(["retry_scheduled", "pending"]).toContain(row.dispatch_state);
    expect(row.delivery_evidence).not.toBe("provider_accepted");
    expect(d.rows).toHaveLength(0);
    expect(await ownerRecords()).toEqual(before);
  });

  it("Salesforce down: the owner's callback fails with a code and stores no token", async () => {
    const env = await salesforceDown();
    const started = await call("/api/v1/admin/integrations/salesforce/authorize", {
      env: { ...ownerEnv, ...env },
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      body: {},
    });
    expect(started.status).toBeLessThan(500);
    const state = started.json.authorizeUrl
      ? new URL(started.json.authorizeUrl).searchParams.get("state")
      : "none";
    const res = await call(
      `/api/v1/admin/integrations/salesforce/callback?code=drill&state=${state}`,
      {
        env: { ...ownerEnv, ...env },
        headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      },
    );
    // A typed upstream refusal, the one 5xx the API means to send: Salesforce, not us, failed.
    expect(res.status).toBe(502);
    expect(res.json.error?.code ?? res.json.code).toBe("provider_rejected");
    expect(res.text).not.toMatch(/fetch failed|TypeError/);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT count(*)::int AS n FROM app.connection_secrets WHERE workspace_id = $1",
      [OWNER],
    );
    await mig.end();
    expect(rows[0].n).toBe(0);
  });
});
