// A LABELED TEST DOUBLE of Salesforce's documented OAuth and REST behavior. It is not Salesforce.
// Nothing proven against this says anything about a real org, which is why P3-D stays Pending
// Owner Credentials.
export const DOUBLE_LOGIN = "https://login.test-double.invalid";
export const DOUBLE_INSTANCE = "https://org.test-double.invalid";

const API = "/services/data/v62.0";
const accounts = [
  {
    Id: "001DOUBLE0001",
    Name: "Double Org One (fictional)",
    Type: "Customer",
    AccountNumber: "SF-1",
    LastModifiedDate: "2026-11-01T10:00:00.000+0000",
  },
  {
    Id: "001DOUBLE0002",
    Name: "Double Org Two (fictional)",
    Type: "Prospect",
    AccountNumber: null,
    LastModifiedDate: "2026-11-02T10:00:00.000+0000",
  },
  {
    Id: "001DOUBLE0003",
    Name: "Double Org Three (fictional)",
    Type: "Customer",
    AccountNumber: "SF-3",
    LastModifiedDate: "2026-11-03T10:00:00.000+0000",
  },
];

export function salesforceDouble(options: { instanceUrl?: string } = {}) {
  const state = {
    requests: [] as { method: string; path: string; auth: string | null }[],
    access: "double-access-1",
    refresh: "double-refresh-1",
    expired: false,
    revoked: false,
    rotations: 0,
    lastVerifier: null as string | null,
    revokeFails: false,
  };
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchDouble = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    state.requests.push({
      method: req.method,
      path: url.pathname,
      auth: req.headers.get("authorization"),
    });
    if (url.pathname === "/services/oauth2/token") {
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") === "authorization_code") {
        state.lastVerifier = form.get("code_verifier");
        if (form.get("code") !== "good-code" || !state.lastVerifier)
          return json(400, { error: "invalid_grant" });
        return json(200, {
          access_token: state.access,
          refresh_token: state.refresh,
          instance_url: options.instanceUrl ?? DOUBLE_INSTANCE,
        });
      }
      if (state.revoked || form.get("refresh_token") !== state.refresh)
        return json(400, { error: "invalid_grant" });
      state.rotations++;
      state.expired = false;
      state.access = `double-access-${state.rotations + 1}`;
      state.refresh = `double-refresh-${state.rotations + 1}`;
      return json(200, { access_token: state.access, refresh_token: state.refresh });
    }
    if (url.pathname === "/services/oauth2/revoke") {
      if (state.revokeFails) return json(400, { error: "unsupported_token_type" });
      state.revoked = true;
      return json(200, {});
    }
    if (req.method !== "GET") return json(405, [{ errorCode: "METHOD_NOT_ALLOWED" }]);
    if (
      state.revoked ||
      state.expired ||
      req.headers.get("authorization") !== `Bearer ${state.access}`
    ) {
      return json(401, [
        { message: "Session expired or invalid", errorCode: "INVALID_SESSION_ID" },
      ]);
    }
    if (url.pathname === `${API}/query`) {
      const rows = accounts;
      return json(200, {
        totalSize: rows.length,
        done: false,
        nextRecordsUrl: `${API}/query/DOUBLE-2`,
        records: rows.slice(0, 2).map((r) => ({ attributes: { type: "Account" }, ...r })),
      });
    }
    if (url.pathname === `${API}/query/DOUBLE-2`) {
      return json(200, {
        totalSize: 3,
        done: true,
        records: accounts.slice(2).map((r) => ({ attributes: { type: "Account" }, ...r })),
      });
    }
    return json(404, [{ errorCode: "NOT_FOUND" }]);
  };
  return { state, fetchDouble };
}

export const doubleEnv = (fetchDouble: (r: Request) => Promise<Response>) => ({
  SALESFORCE_ENABLED: "true",
  SALESFORCE_LOGIN_URL: DOUBLE_LOGIN,
  SALESFORCE_CLIENT_ID: "double-client",
  SALESFORCE_REDIRECT_URI: "http://localhost:8787/api/v1/admin/integrations/salesforce/callback",
  TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  SALESFORCE_TEST_DOUBLE: fetchDouble,
});
