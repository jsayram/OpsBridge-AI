// Event sinks, docs/design/INTEGRATION-CONTRACTS.md. The simulated sink is the only one a demo
// workspace can reach. The sheet bridge (PRD 9.2 Mode A) is owner-only, off unless every value
// is configured, and has only met the labeled double in tests/integration/sheets-double.ts:
// P4-C stays Pending Owner Credentials until Jose's sheet and Zap exist.
import { importPKCS8, SignJWT } from "jose";
import type { Bindings } from "../env";
import { callWithPolicy, readJson, type RetryPolicy } from "./http";
import { AdapterError, type Transport } from "./types";

export type SinkMode = "simulated" | "sheet_bridge";

export type DeliverableEvent = {
  id: string;
  type: string;
  occurredAt: string;
  data: Record<string, unknown>;
};

export type DeliveryResult =
  | { kind: "accepted"; evidenceRef: string }
  | { kind: "simulated"; evidenceRef: string }
  | { kind: "retryable"; code: string; retryAfterSeconds?: number }
  | { kind: "permanent"; code: string };

export interface EventSink {
  readonly mode: SinkMode;
  deliver(event: DeliverableEvent): Promise<DeliveryResult>;
}

// Nothing leaves the system. The effects ledger row written by finish_outbox is the whole effect.
export const simulatedSink = (matched: number): EventSink => ({
  mode: "simulated",
  deliver: async () => ({
    kind: "simulated",
    evidenceRef: matched
      ? `simulated:${matched}-rule${matched === 1 ? "" : "s"}`
      : "no-matching-rule",
  }),
});

export type SheetConfig = {
  spreadsheetId: string;
  clientEmail: string;
  privateKey: string;
  transport: Transport;
  double: boolean;
};

const SHEET_ID = /^[A-Za-z0-9_-]{20,100}$/;

// Off unless every value is present. The double is accepted only in local runs and only as an
// in-process function, which a deployed Worker can't be given.
export function sheetConfig(env: Bindings): SheetConfig | null {
  if (env.SHEETS_ENABLED !== "true") return null;
  const double =
    env.ENVIRONMENT === "local" && typeof env.SHEETS_TEST_DOUBLE === "function"
      ? env.SHEETS_TEST_DOUBLE
      : null;
  if (!env.SHEET_ID || !SHEET_ID.test(env.SHEET_ID) || !env.GOOGLE_SA_KEY) return null;
  let key: { client_email?: unknown; private_key?: unknown };
  try {
    key = JSON.parse(env.GOOGLE_SA_KEY);
  } catch {
    return null;
  }
  if (typeof key.client_email !== "string" || typeof key.private_key !== "string") return null;
  return {
    spreadsheetId: env.SHEET_ID,
    clientEmail: key.client_email,
    privateKey: key.private_key,
    transport: double ?? ((r) => fetch(r)),
    double: double !== null,
  };
}

const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";
export const SHEET_ROW_CAP = 2000;
// One call, 10-second timeout, no inner retry: the dispatcher owns retries and their 120 s floor.
const ONE_CALL: RetryPolicy = {
  timeoutMs: 10_000,
  retries: 0,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterSeconds: 0,
  sleep: async () => {},
  random: Math.random,
};

// Held in memory for this isolate only, never stored.
let cachedToken: { email: string; token: string; expiresAt: number } | null = null;
export const forgetSheetToken = () => {
  cachedToken = null;
};

async function accessToken(config: SheetConfig, refresh: boolean): Promise<string> {
  if (!refresh && cachedToken?.email === config.clientEmail && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }
  const now = Math.floor(Date.now() / 1000);
  let assertion: string;
  try {
    const key = await importPKCS8(config.privateKey, "RS256");
    assertion = await new SignJWT({ scope: "https://www.googleapis.com/auth/spreadsheets" })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(config.clientEmail)
      .setAudience(GOOGLE_TOKEN)
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(key);
  } catch {
    throw new AdapterError("auth", "service_key_unreadable");
  }
  const res = await callWithPolicy(
    config.transport,
    () =>
      new Request(GOOGLE_TOKEN, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion,
        }),
      }),
    ONE_CALL,
  );
  const body = (await readJson(res)) as { access_token?: unknown; expires_in?: unknown };
  if (typeof body.access_token !== "string") throw new AdapterError("auth", "token_missing");
  const ttl = typeof body.expires_in === "number" ? body.expires_in : 3600;
  cachedToken = {
    email: config.clientEmail,
    token: body.access_token,
    expiresAt: Date.now() + Math.max(0, ttl - 60) * 1000,
  };
  return body.access_token;
}

// A cell that starts with one of these is a formula in a spreadsheet. RAW input already stores it
// as text; the apostrophe keeps it text if anyone ever switches the input option.
export const sheetCell = (value: unknown) => {
  const text = String(value ?? "").slice(0, 200);
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
};

export const summaryOf = (event: DeliverableEvent) =>
  Object.entries(event.data)
    .filter(([k]) => k !== "caseRef" && k !== "findingRef")
    .map(([k, v]) => `${k}=${String(v)}`)
    .join("; ");

// Check-before-append (PRD 9.2): read the event ID column, append only when the ID is absent.
// A retry after a crash finds its own row and stops there.
export const sheetSink = (config: SheetConfig): EventSink => ({
  mode: "sheet_bridge",
  async deliver(event) {
    const call = async (build: (token: string) => Request) => {
      try {
        return await callWithPolicy(
          config.transport,
          () => build(cachedToken?.token ?? ""),
          ONE_CALL,
        );
      } catch (e) {
        // One refresh on 401, then the dispatcher's retry takes over.
        if (e instanceof AdapterError && e.failure === "auth" && e.code === "http_401") {
          await accessToken(config, true);
          return callWithPolicy(config.transport, () => build(cachedToken?.token ?? ""), ONE_CALL);
        }
        throw e;
      }
    };
    try {
      await accessToken(config, false);
      const base = `${SHEETS}/${config.spreadsheetId}/values`;
      const read = await call(
        (token) =>
          new Request(`${base}/${encodeURIComponent("Events!A2:A")}?majorDimension=COLUMNS`, {
            headers: { authorization: `Bearer ${token}` },
          }),
      );
      const column = ((await readJson(read)) as { values?: unknown }).values;
      const ids = Array.isArray(column) && Array.isArray(column[0]) ? (column[0] as unknown[]) : [];
      const at = ids.indexOf(event.id);
      if (at >= 0) return { kind: "accepted", evidenceRef: `found-by-check:Events!A${at + 2}` };
      if (ids.length >= SHEET_ROW_CAP) return { kind: "permanent", code: "sheet_full" };
      const ref = (event.data.caseRef ??
        event.data.findingRef ??
        event.data.provider ??
        "") as string;
      const row = [event.id, event.type, event.occurredAt, ref, summaryOf(event), "TEST"].map(
        sheetCell,
      );
      const appended = await call(
        (token) =>
          new Request(
            `${base}/${encodeURIComponent("Events!A:F")}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
            {
              method: "POST",
              headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
              body: JSON.stringify({ values: [row] }),
            },
          ),
      );
      const updates = ((await readJson(appended)) as { updates?: { updatedRange?: unknown } })
        .updates;
      const range = typeof updates?.updatedRange === "string" ? updates.updatedRange : "appended";
      return { kind: "accepted", evidenceRef: range.slice(0, 200) };
    } catch (e) {
      if (!(e instanceof AdapterError)) return { kind: "retryable", code: "network_error" };
      // 403 or 404: the share is broken, and retrying won't mend it.
      if (e.failure === "permission" || e.code === "http_404") {
        return {
          kind: "permanent",
          code: e.code === "http_404" ? "sheet_not_found" : "sheet_forbidden",
        };
      }
      if (e.failure === "invalid_payload") return { kind: "permanent", code: e.code };
      if (e.failure === "auth") return { kind: "retryable", code: "sheet_auth" };
      return {
        kind: "retryable",
        code:
          e.code === "timeout"
            ? "timeout"
            : e.failure === "rate_limited"
              ? "rate_limited"
              : "provider_unavailable",
        ...(e.retryAfterSeconds !== undefined
          ? { retryAfterSeconds: Math.ceil(e.retryAfterSeconds) }
          : {}),
      };
    }
  },
});
