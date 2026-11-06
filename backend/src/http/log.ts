// Structured logs use an allowlist of fields. Nothing request-supplied goes in except the
// matched route pattern, so cookies, tokens, bodies and query strings can't reach a log.
type LogFields = {
  level: "info" | "warn" | "error";
  event: string;
  requestId?: string;
  method?: string;
  route?: string;
  status?: number;
  durationMs?: number;
  actor?: "anonymous" | "guest" | "owner";
  code?: string;
  errorName?: string;
  dbCode?: string;
  purged?: number;
};

export function log(fields: LogFields): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...fields });
  if (fields.level === "error") console.error(line);
  else console.log(line);
}
