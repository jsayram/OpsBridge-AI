#!/usr/bin/env node
// Black-box smoke test against a running instance. Creates one demo session and resets it.
// Sends no credential. A non-local URL needs --allow-remote, so nothing here reaches a
// hosted environment by accident.
//   node scripts/smoke.mjs http://localhost:8787
//   node scripts/smoke.mjs https://<staging-origin> --allow-remote
const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://localhost:8787").replace(/\/$/, "");
const url = new URL(base);
const local = ["localhost", "127.0.0.1"].includes(url.hostname);
if (!local && !args.includes("--allow-remote")) {
  console.error("Refusing a non-local URL without --allow-remote");
  process.exit(2);
}

let failed = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const hit = (path, options = {}) =>
  fetch(`${base}${path}`, {
    redirect: "manual",
    ...options,
    headers: {
      ...(options.method && options.method !== "GET" ? { origin: url.origin } : {}),
      ...options.headers,
    },
  });
const cookieOf = (res) => (res.headers.get("set-cookie") ?? "").split(";")[0];

for (const path of ["/health/live", "/health/ready"]) {
  const r = await hit(path);
  const body = await r.text();
  check(`${path} is minimal`, r.status === 200 && body === '{"status":"ok"}', `${r.status}`);
}
const started = Date.now();
const landing = await hit("/");
check("landing page", landing.status === 200, `${Date.now() - started} ms`);
check(
  "landing has a CSP",
  (landing.headers.get("content-security-policy") ?? "").includes("default-src 'self'"),
);
check("SPA route falls back to the app", (await hit("/app/overview")).status === 200);

const miss = await hit("/api/v1/does-not-exist");
const missBody = await miss.json();
check(
  "404 envelope has a request ID",
  miss.status === 404 && missBody.requestId === miss.headers.get("x-request-id"),
);
check("anonymous /me is 401", (await hit("/api/v1/me")).status === 401);

const launchStart = Date.now();
const launch = await hit("/api/v1/demo/sessions", { method: "POST" });
const launchMs = Date.now() - launchStart;
check("demo launch", launch.status === 201, `${launch.status}, ${launchMs} ms`);
const raw = launch.headers.get("set-cookie") ?? "";
check(
  "cookie flags",
  raw.startsWith("__Host-obs_demo=") &&
    ["HttpOnly", "Secure", "SameSite=Strict", "Path=/"].every((f) => raw.includes(f)),
);
const cookie = cookieOf(launch);
const me = await hit("/api/v1/me", { headers: { cookie } });
const meBody = await me.json();
check("session works", me.status === 200 && meBody.kind === "guest", meBody.demoRole);
check("no admin capability", !meBody.capabilities?.includes("admin:access"));
const list = await (await hit("/api/v1/cases?limit=5", { headers: { cookie } })).json();
check(
  "cases list opens with own rows",
  list.items?.length === 5 && list.items[0].readOnly === false,
);
const other = await hit("/api/v1/demo/sessions", { method: "POST" });
const otherCookie = cookieOf(other);
const swapped = await hit(`/api/v1/cases/${list.items[0].id}`, {
  headers: { cookie: otherCookie },
});
check(
  "a second visitor can't read the first one's case",
  other.status === 201 && swapped.status === 404,
  `${swapped.status}`,
);

const evil = await hit("/api/v1/demo/reset", {
  method: "POST",
  headers: { cookie, origin: "https://evil.example.com" },
});
check("cross-origin write refused", evil.status === 403);
const admin = await hit("/api/v1/admin/status", { headers: { cookie } });
check("guest cannot reach admin", [401, 403, 404].includes(admin.status), `${admin.status}`);
const adminPage = await hit("/admin", { headers: { cookie } });
check(
  "guest cannot load the admin page",
  [401, 403, 404].includes(adminPage.status),
  `${adminPage.status}`,
);

const reset = await hit("/api/v1/demo/reset", { method: "POST", headers: { cookie } });
check("reset", reset.status === 200, `${reset.status}`);
check(
  "old cookie is dead after reset",
  (await hit("/api/v1/me", { headers: { cookie } })).status === 401,
);
const fresh = cookieOf(reset);
check("new cookie works", (await hit("/api/v1/me", { headers: { cookie: fresh } })).status === 200);

console.log(failed ? `SMOKE FAILED: ${failed}` : "SMOKE PASSED");
process.exit(failed ? 1 : 0);
