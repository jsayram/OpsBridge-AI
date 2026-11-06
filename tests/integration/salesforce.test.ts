import { beforeEach, describe, expect, it } from "vitest";
import { salesforceConfig } from "../../backend/src/integrations/salesforce";
import {
  call,
  connect,
  idempotencyKey,
  launch,
  mintOwnerToken,
  ownerEnv,
  setRole,
} from "./harness";
import { DOUBLE_LOGIN, doubleEnv, salesforceDouble } from "./salesforce-double";

const OWNER_WS = "00000000-0000-4000-8000-000000000002";

// Everything in this file runs against the labeled double in salesforce-double.ts.
describe("P3.3 Salesforce connector, against a labeled test double", () => {
  let d: ReturnType<typeof salesforceDouble>;
  const env = () => ({ ...ownerEnv, ...doubleEnv(d.fetchDouble) });
  const owner = async (path: string, options: Record<string, unknown> = {}) =>
    call(path, {
      headers: {
        "cf-access-jwt-assertion": await mintOwnerToken(),
        ...(options.headers as Record<string, string> | undefined),
      },
      env: env(),
      ...(({ headers: _h, ...rest }) => rest)(options),
    });
  const reset = async () => {
    const mig = await connect("opsbridge_migrator");
    const conn =
      "SELECT id FROM app.external_connections WHERE workspace_id = $1 AND provider = 'salesforce_test'";
    await mig.query(`DELETE FROM app.sync_runs WHERE connection_id IN (${conn})`, [OWNER_WS]);
    await mig.query(
      "DELETE FROM app.source_records WHERE workspace_id = $1 AND provider = 'salesforce_test'",
      [OWNER_WS],
    );
    await mig.query("DELETE FROM app.reconciliation_findings WHERE workspace_id = $1", [OWNER_WS]);
    await mig.query(
      "DELETE FROM app.external_connections WHERE workspace_id = $1 AND provider = 'salesforce_test'",
      [OWNER_WS],
    );
    await mig.query("DELETE FROM app.connection_secrets WHERE workspace_id = $1", [OWNER_WS]);
    await mig.query("DELETE FROM app.oauth_states WHERE workspace_id = $1", [OWNER_WS]);
    await mig.end();
  };
  const connectOwner = async () => {
    const started = await owner("/api/v1/admin/integrations/salesforce/authorize", {
      method: "POST",
    });
    const url = new URL(started.json.authorizeUrl);
    const res = await owner(
      `/api/v1/admin/integrations/salesforce/callback?code=good-code&state=${url.searchParams.get("state")}`,
    );
    expect(res.status).toBe(302);
    const status = await owner("/api/v1/admin/integrations/salesforce");
    return { url, id: status.json.connection.id as string, status };
  };
  const sync = async (id: string) =>
    owner(`/api/v1/admin/integrations/${id}/sync`, {
      method: "POST",
      headers: idempotencyKey(),
      body: {},
    });

  beforeEach(async () => {
    await reset();
    d = salesforceDouble();
  });

  it("is off, and says so, without every setting", async () => {
    const res = await call("/api/v1/admin/integrations/salesforce", {
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      env: ownerEnv,
    });
    expect(res.json.configured).toBe(false);
    expect(res.json.claim).toBe("Pending Owner Credentials");
    const start = await call("/api/v1/admin/integrations/salesforce/authorize", {
      method: "POST",
      headers: { "cf-access-jwt-assertion": await mintOwnerToken() },
      env: ownerEnv,
    });
    expect(start.json.code).toBe("not_configured");
  });

  it("the double can't be used outside local, and a bad login host is refused", () => {
    const base = doubleEnv(d.fetchDouble);
    expect(salesforceConfig({ ...base, ENVIRONMENT: "production" } as never)).toBeNull();
    expect(salesforceConfig({ ...base, ENVIRONMENT: "local" } as never)?.double).toBe(true);
    expect(
      salesforceConfig({
        ...base,
        SALESFORCE_TEST_DOUBLE: undefined,
        SALESFORCE_LOGIN_URL: "https://evil.example.com",
        ENVIRONMENT: "production",
      } as never),
    ).toBeNull();
    expect(
      salesforceConfig({
        ...base,
        SALESFORCE_TEST_DOUBLE: undefined,
        SALESFORCE_LOGIN_URL: "http://login.salesforce.com",
        ENVIRONMENT: "production",
      } as never),
    ).toBeNull();
    expect(
      salesforceConfig({
        ...base,
        SALESFORCE_TEST_DOUBLE: undefined,
        SALESFORCE_LOGIN_URL: "https://login.salesforce.com",
        ENVIRONMENT: "production",
      } as never)?.double,
    ).toBe(false);
  });

  it("connects with state and PKCE and labels the double as a double", async () => {
    const { url, status } = await connectOwner();
    expect(url.origin).toBe(DOUBLE_LOGIN);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe("api refresh_token");
    expect(d.state.lastVerifier?.length).toBeGreaterThan(40);
    expect(status.json.testDouble).toBe(true);
    expect(status.json.claim).toBe("Pending Owner Credentials");
    expect(status.json.connection.status).toBe("Connected Test");
  });

  it("a state value works once, and an unknown one not at all", async () => {
    const started = await owner("/api/v1/admin/integrations/salesforce/authorize", {
      method: "POST",
    });
    const state = new URL(started.json.authorizeUrl).searchParams.get("state");
    const path = `/api/v1/admin/integrations/salesforce/callback?code=good-code&state=${state}`;
    expect((await owner(path)).status).toBe(302);
    expect((await owner(path)).status).toBe(400);
    expect(
      (await owner("/api/v1/admin/integrations/salesforce/callback?code=good-code&state=forged"))
        .status,
    ).toBe(400);
  });

  it("refuses an instance URL that isn't an allowed https host, so no token reaches it", async () => {
    d = salesforceDouble({ instanceUrl: "https://attacker.example.com" });
    const started = await owner("/api/v1/admin/integrations/salesforce/authorize", {
      method: "POST",
    });
    const state = new URL(started.json.authorizeUrl).searchParams.get("state");
    const res = await owner(
      `/api/v1/admin/integrations/salesforce/callback?code=good-code&state=${state}`,
    );
    expect(res.status).toBe(502);
    expect(res.text).not.toContain("attacker");
  });

  it("stores only ciphertext, and the API never returns a token", async () => {
    const { id } = await connectOwner();
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT convert_from(ciphertext, 'latin1') AS c FROM app.connection_secrets WHERE workspace_id = $1",
      [OWNER_WS],
    );
    const dump = await mig.query(
      "SELECT row_to_json(c)::text AS r FROM app.external_connections c WHERE workspace_id = $1 AND id = $2",
      [OWNER_WS, id],
    );
    await mig.end();
    expect(rows[0].c).not.toContain("double-");
    expect(dump.rows[0].r).not.toContain("double-");
    const list = await owner("/api/v1/integrations");
    const status = await owner("/api/v1/admin/integrations/salesforce");
    expect(list.text + status.text).not.toMatch(
      /double-(access|refresh)|secret_reference|secretReference/,
    );
  });

  it("reads through pagination with GET only, and a replay adds nothing", async () => {
    const { id } = await connectOwner();
    const first = await sync(id);
    expect(first.json.status).toBe("succeeded");
    expect(first.json.pages).toBe(2);
    expect(first.json.counts.created).toBe(3);
    const replay = await owner(`/api/v1/admin/integrations/${id}/sync`, {
      method: "POST",
      headers: idempotencyKey(),
      body: { full: true },
    });
    expect(replay.json.counts.created).toBe(0);
    expect(replay.json.counts.unchanged).toBe(3);
    const data = d.state.requests.filter((r) => r.path.startsWith("/services/data"));
    expect(data.every((r) => r.method === "GET")).toBe(true);
    expect(data.length).toBeGreaterThan(0);
  });

  it("an expired token refreshes once, rotates, and the read continues", async () => {
    const { id } = await connectOwner();
    d.state.expired = true;
    const res = await sync(id);
    expect(res.json.status).toBe("succeeded");
    expect(d.state.rotations).toBe(1);
    // The rotated refresh token was saved: the next expiry works too.
    d.state.expired = true;
    const again = await owner(`/api/v1/admin/integrations/${id}/sync`, {
      method: "POST",
      headers: idempotencyKey(),
      body: { full: true },
    });
    expect(again.json.status).toBe("succeeded");
    expect(d.state.rotations).toBe(2);
  });

  it("E2E-09: a revoked token dead-letters the run and degrades the connection, safely", async () => {
    const { id } = await connectOwner();
    d.state.revoked = true;
    const res = await sync(id);
    expect(res.json.status).toBe("dead_letter");
    expect(res.json.error.code).toBe("token_revoked");
    const status = await owner("/api/v1/admin/integrations/salesforce");
    expect(status.json.connection.status).toBe("Degraded");
    expect(res.text).not.toMatch(/INVALID_SESSION_ID|invalid_grant/);
    expect((await owner("/api/v1/integrations")).status).toBe(200);
  });

  it("disconnect revokes at the provider, scrubs the token, and blocks further sync", async () => {
    const { id } = await connectOwner();
    const res = await owner(`/api/v1/admin/integrations/${id}/disconnect`, { method: "POST" });
    expect(res.json.providerRevoked).toBe(true);
    expect(d.state.revoked).toBe(true);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT ciphertext, iv, scrubbed_at FROM app.connection_secrets WHERE workspace_id = $1",
      [OWNER_WS],
    );
    await mig.end();
    expect(rows[0].ciphertext).toBeNull();
    expect(rows[0].iv).toBeNull();
    expect(rows[0].scrubbed_at).not.toBeNull();
    const status = await owner("/api/v1/admin/integrations/salesforce");
    expect(status.json.connection.status).toBe("Disconnected");
    expect((await sync(id)).json.code).toBe("not_connected");
  });

  it("a failed provider revoke still scrubs here, and says so", async () => {
    const { id } = await connectOwner();
    d.state.revokeFails = true;
    const res = await owner(`/api/v1/admin/integrations/${id}/disconnect`, { method: "POST" });
    expect(res.json.providerRevoked).toBe(false);
    const mig = await connect("opsbridge_migrator");
    const { rows } = await mig.query(
      "SELECT ciphertext FROM app.connection_secrets WHERE workspace_id = $1",
      [OWNER_WS],
    );
    await mig.end();
    expect(rows[0].ciphertext).toBeNull();
  });

  it("can connect again after a disconnect", async () => {
    const { id } = await connectOwner();
    await owner(`/api/v1/admin/integrations/${id}/disconnect`, { method: "POST" });
    d = salesforceDouble();
    const again = await connectOwner();
    expect(again.id).toBe(id);
    expect((await sync(id)).json.status).toBe("succeeded");
  });

  it("P3-E: a guest gets no answer from any owner route, and can't sync a live connection", async () => {
    const { id } = await connectOwner();
    const guest = await launch();
    await setRole(guest.cookie, "manager");
    const paths: [string, string][] = [
      ["GET", "/api/v1/admin/integrations/salesforce"],
      ["POST", "/api/v1/admin/integrations/salesforce/authorize"],
      ["GET", "/api/v1/admin/integrations/salesforce/callback?code=good-code&state=x"],
      ["POST", `/api/v1/admin/integrations/${id}/sync`],
      ["POST", `/api/v1/admin/integrations/${id}/disconnect`],
    ];
    const before = d.state.requests.length;
    for (const [method, path] of paths) {
      const res = await call(path, {
        method,
        cookie: guest.cookie,
        env: env(),
        ...(method === "POST" ? { body: {} } : {}),
      });
      expect(res.status, path).toBe(401);
    }
    const res = await call(`/api/v1/integrations/${id}/sync`, {
      method: "POST",
      cookie: guest.cookie,
      headers: idempotencyKey(),
      env: env(),
      body: {},
    });
    expect(res.status).toBe(404);
    expect(d.state.requests.length).toBe(before);
  });

  it("an owner token can't drive a live connection through the guest route either", async () => {
    const { id } = await connectOwner();
    const before = d.state.requests.length;
    const res = await owner(`/api/v1/integrations/${id}/sync`, {
      method: "POST",
      headers: idempotencyKey(),
      body: {},
    });
    expect(res.status).toBe(403);
    expect(d.state.requests.length).toBe(before);
  });

  it("guests read no live record: the owner's source rows are in no guest response", async () => {
    const { id } = await connectOwner();
    await sync(id);
    const guest = await launch();
    const list = await call("/api/v1/integrations", { cookie: guest.cookie, env: env() });
    const queue = await call("/api/v1/reconciliation?limit=100", {
      cookie: guest.cookie,
      env: env(),
    });
    expect(list.text + queue.text).not.toMatch(/DOUBLE|salesforce_test/i);
  });
});
