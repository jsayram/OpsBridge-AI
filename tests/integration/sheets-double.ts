// LABELED TEST DOUBLE for the Google token endpoint and the two Sheets values calls the bridge
// uses. It follows Google's public request and response shapes; it is not Google, and nothing
// proven against it is evidence of a real sheet or Zap run (P4-C stays Pending Owner Credentials).
import { exportPKCS8, generateKeyPair } from "jose";
import type { Bindings } from "../../backend/src/env";

export type SheetFault =
  | { status: number; retryAfter?: number }
  | "timeout"
  // Google writes the row, then the response is lost: the late-landing write case.
  | "append_then_timeout"
  | "ok_without_range";

export type SheetsDouble = {
  rows: string[][];
  requests: { method: string; path: string }[];
  faults: { op: "token" | "read" | "append"; fault: SheetFault }[];
  env: Partial<Bindings>;
};

export const SHEET_ID = "double-sheet-0123456789abcdef";
const TOKEN = "double-access-token";

const timeout = () => {
  throw new DOMException("The operation timed out.", "TimeoutError");
};

export async function sheetsDouble(): Promise<SheetsDouble> {
  const { privateKey } = await generateKeyPair("RS256", { extractable: true });
  const key = JSON.stringify({
    client_email: "bridge@double.invalid",
    private_key: await exportPKCS8(privateKey),
  });
  const state: SheetsDouble = { rows: [], requests: [], faults: [], env: {} };

  const takeFault = (op: "token" | "read" | "append") => {
    const i = state.faults.findIndex((f) => f.op === op);
    return i < 0 ? null : (state.faults.splice(i, 1)[0]?.fault ?? null);
  };
  const failWith = (fault: SheetFault) => {
    if (fault === "timeout") timeout();
    if (typeof fault === "object") {
      return new Response("{}", {
        status: fault.status,
        headers: fault.retryAfter !== undefined ? { "retry-after": String(fault.retryAfter) } : {},
      });
    }
    return null;
  };

  const transport = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    state.requests.push({ method: req.method, path: url.pathname });
    if (url.host === "oauth2.googleapis.com" && url.pathname === "/token") {
      const fault = takeFault("token");
      const failed = fault && failWith(fault);
      if (failed) return failed;
      const form = new URLSearchParams(await req.text());
      if (form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer") {
        return new Response("{}", { status: 400 });
      }
      return Response.json({ access_token: TOKEN, expires_in: 3600, token_type: "Bearer" });
    }
    if (url.host !== "sheets.googleapis.com") return new Response("{}", { status: 404 });
    if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
      return new Response("{}", { status: 401 });
    }
    const base = `/v4/spreadsheets/${SHEET_ID}/values/`;
    if (!url.pathname.startsWith(base)) return new Response("{}", { status: 404 });
    const range = decodeURIComponent(url.pathname.slice(base.length));
    if (req.method === "GET" && range === "Events!A2:A") {
      const fault = takeFault("read");
      const failed = fault && failWith(fault);
      if (failed) return failed;
      return Response.json(
        state.rows.length ? { values: [state.rows.map((r) => r[0])] } : { range },
      );
    }
    if (req.method === "POST" && range === "Events!A:F:append") {
      const fault = takeFault("append");
      const failed = fault && failWith(fault);
      if (failed) return failed;
      const body = (await req.json()) as { values: string[][] };
      for (const row of body.values) state.rows.push(row);
      if (fault === "append_then_timeout") timeout();
      if (fault === "ok_without_range") return Response.json({});
      const n = state.rows.length + 1;
      return Response.json({ updates: { updatedRange: `Events!A${n}:F${n}`, updatedRows: 1 } });
    }
    return new Response("{}", { status: 400 });
  };

  state.env = {
    SHEETS_ENABLED: "true",
    SHEET_ID,
    GOOGLE_SA_KEY: key,
    SHEETS_TEST_DOUBLE: transport,
  };
  return state;
}
