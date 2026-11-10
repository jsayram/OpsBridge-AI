# Security checklist (P7.1)

Prepared 2026-11-09 by the P7 phase session, on branch `phase/p7-release-gate`. This maps the OWASP API Security Top 10 (2023), the OWASP LLM Top 10 and the ASVS 5.0 areas that apply to this app onto the tests that cover each one, and lists what is not covered. These lists are engineering checklists, not compliance claims, and this is an AI-run review, not an independent audit. PRD 12.2 stays the master threat-to-control table and `THREAT-MODEL.md` the system analysis.

"Local" means the test ran on Docker Postgres and in-process Hono or workerd on this machine. Nothing here has run through Hyperdrive, Neon or Cloudflare hardware.

## How to rerun

| Check | Command | Reports |
|---|---|---|
| Dependency, license, SBOM, secret and SAST scans, with canaries | `npm run scan:security` (offline; needs gitleaks and trivy with a cached database) | `docs/evidence/P7.1/scans/` |
| Known vulnerabilities from the npm registry | `npm run audit` (asks the registry) | CI log |
| Project SAST rules | `npm run sast` | stdout |
| OpenAPI lint and route cross-check | `npm run lint:openapi`, `tests/unit/openapi.test.ts` | stdout |
| Negative sweep over every operation | `tests/integration/release-negative.test.ts` | Vitest |
| Provider outages | `tests/integration/provider-outages.test.ts` | Vitest |

## Scan results, 2026-11-09

| Scan | Tool and version | Result | Canary |
|---|---|---|---|
| Dependencies, app | trivy 0.76.1, database of 2026-11-02, production and dev dependencies | 0 findings | Planted `lodash` 4.17.15 lockfile: tripped |
| Dependencies, P0.2 spike | same | 1 High (`ws` 8.18.3, CVE-2026-48779, denial of service) and 1 Medium (CVE-2026-45736). **Fixed**: upgraded to 8.21.0 from the local npm cache. Now 0 | same |
| Licenses | trivy, with dev dependencies | MIT, Apache-2.0, ISC, BSD, 0BSD, CC0, MPL-2.0 and LGPL-3.0-or-later. The LGPL entries are `sharp`'s prebuilt `libvips` binaries, pulled in by Wrangler's local runtime, and MPL-2.0 is `lightningcss` in Vite. Neither ships in the Worker or the client bundle | n/a |
| SBOM | trivy CycloneDX | Runtime: 20 components. With build tools: 198 | n/a |
| Secrets, working tree and 67-commit history | gitleaks 8.30.1 | Clean | Random `ghp_` token in a temp folder: tripped |
| Static analysis | `scripts/sast.mjs`, 7 rules | Clean after one hardening change (below) | `eval` in a temp file: tripped; each rule has a unit test |
| OpenAPI | `scripts/openapi-lint.mjs` | 3 problems fixed, then clean on 64 operations. The route cross-check found 3 served routes missing from the spec; added | Lint rules unit-tested through the spec itself |

The trivy database was a week old when the scans ran. A newer advisory would not show until the cache is refreshed, which needs the network; CI's `npm audit` covers the npm advisory feed on every run.

SAST is a small project rule set, not Semgrep or CodeQL, which aren't installed. Its rules: raw HTML and `document.write`, `eval` and `new Function`, `fetch` outside five reviewed files, `Math.random` outside retry jitter, `console` outside the redacting logger, a session cookie without `httpOnly`, `secure` and `sameSite`, and SQL built from interpolated names that aren't module constants. The SQL rule found the report page splicing a validated `LIMIT` and `OFFSET` into its SQL text; both are now bound parameters. Five queries that choose between two constant fragments carry a reviewed `sast-ok` note.

## OWASP API Security Top 10 (2023)

| Risk | Control | Tests | State |
|---|---|---|---|
| API1 Broken object level authorization | Every query scoped by workspace in SQL and by row-level security; IDs from the URL never pick the workspace | `release-negative.test.ts` (every operation with an ID, against another guest and the owner, rows fingerprinted before and after), `isolation-matrix.test.ts`, `roles-isolation.test.ts`, E2E-02 | Met locally |
| API2 Broken authentication | Opaque demo token stored as a hash; owner by Access JWT with issuer, audience, expiry, subject allowlist | `sessions.test.ts`, `owner-identity.test.ts`, forged-token sweep in `release-negative.test.ts` (wrong key, `alg: none`, junk) | Met locally against the identity double; real Access is P1-E |
| API3 Broken object property level authorization | Strict JSON readers with field allowlists; workspace, role and IDs never read from bodies | `isolation-matrix.test.ts` (bodies can't choose a workspace), `sessions.test.ts` (E2E-04), `faults.test.ts` (privileged source fields) | Met locally |
| API4 Unrestricted resource consumption | 16 KB JSON cap, list and export caps, demo launch and reset quotas, workspace cap, statement timeouts, AI daily and concurrency caps | `shell-api.test.ts`, `sessions.test.ts` (quotas, IPv6 /64), `analytics.test.ts` (export cap), `ai-gateway.test.ts`, `ai-review.test.ts` (locked quota) | Met locally; the Cloudflare rate limiter binding is only exercised as a stub |
| API5 Broken function level authorization | Capability checks per route; admin routes need a verified owner | `release-negative.test.ts` (no caller, viewer, forged owner on every operation), `tests/unit/policy.test.ts` | Met locally |
| API6 Unrestricted access to sensitive business flows | Demo reset and launch budgets; approvals need a manager and a current version | `sessions.test.ts` (E2E-18), `approvals.test.ts` (E2E-06) | Met locally |
| API7 Server-side request forgery | No guest input names a URL or host; outbound calls only from five reviewed files to configured hosts; Salesforce uses `redirect: manual` | Spec scan in `release-negative.test.ts`, SAST `ssrf-unreviewed-fetch`, `automation-rules.test.ts` (URL refused in rules), `dispatch.test.ts` (sheet ID that is a URL) | Met locally |
| API8 Security misconfiguration | CSP, `nosniff`, `no-referrer`, no-store on API; release config gate refuses local values, placeholders and shared Hyperdrive configs | `shell-api.test.ts`, `tests/e2e/shell.spec.ts`, `tests/e2e/security.spec.ts`, `tests/unit/release-config.test.mjs` | Met locally; HSTS waits for a stable domain (PRD 12.3) |
| API9 Improper inventory management | One OpenAPI file, linted, and held to the Worker's routes both ways | `tests/unit/openapi.test.ts` | Met locally |
| API10 Unsafe consumption of APIs | Source records validated and allowlisted; provider text never echoed; bounded retries | `faults.test.ts`, `salesforce.test.ts`, `ai-gateway.test.ts` (malformed and hostile model output) | Met locally against doubles |

## OWASP LLM Top 10

Names follow the 2025 list. The PRD cites the 2026 edition; check the names against it when it is read next.

| Risk | Control | Tests | State |
|---|---|---|---|
| LLM01 Prompt injection | Document text is data in a delimited field; no tools; strict output schema; every citation checked against the source text; a person decides | `ai-review.test.ts` (P5-C, E2E-12), the 10 adversarial fixtures in `npm run eval:ai` | Met in fixture mode; live model behavior unproven (P5.3 pending) |
| LLM02 Sensitive information disclosure | Fictional documents only; the key never in a response, row or log | `ai-gateway.test.ts` (key never written) | Met locally |
| LLM03 Supply chain | Pinned dependencies and actions, scans above | P7.1 scans | Met locally |
| LLM04 Data and model poisoning | No training or fine-tuning; fixture outputs hashed at build | `ai-documents.test.ts` (stored hashes) | Not applicable beyond that |
| LLM05 Improper output handling | Output parsed against a schema; URLs, tool calls and extra fields refused; rendered as text | `ai-gateway.test.ts` (hostile outputs), `tests/e2e/security.spec.ts` | Met locally |
| LLM06 Excessive agency | The model can't write: only an accept by a manager applies a change, through the ordinary command | `ai-review.test.ts` (P5-D), `release-negative.test.ts` | Met locally |
| LLM07 System prompt leakage | The prompt holds no secret | Review of `backend/src/ai/` | Met by design |
| LLM08 Vector and embedding weaknesses | No retrieval store | n/a | Not applicable |
| LLM09 Misinformation | Every field cites a page and text; missing fields reported, not invented; label says fixture or live | `ai-review.test.ts` | Met in fixture mode |
| LLM10 Unbounded consumption | Owner only; daily request, token, concurrency and timeout caps; one call per request, no hidden retry | `ai-gateway.test.ts`, `provider-outages.test.ts` | Met against the double |

## ASVS 5.0 areas

| Area | Where it is covered | Gap |
|---|---|---|
| Encoding and sanitization | React text rendering, CSV formula guard (`tests/unit/csv.test.ts`), stored XSS browser test | None found |
| Validation and business logic | Strict readers, enums, version checks, state machines | None found |
| Web frontend security | CSP without inline or remote script, `frame-ancestors 'none'` | No Trusted Types |
| API and web service | OpenAPI held to the routes; JSON-only writes | None found |
| File handling | Guests can't upload; owner upload validated by bytes then refused (DEC-003) | No malware scanner, by design while uploads stay off |
| Authentication and session management | Hashed opaque tokens, rotation on reset, expiry, fixation refused, Access JWT checks | Real Access and MFA unproven until P1-E |
| Authorization | RLS plus scoped SQL plus capability checks; four database roles | Hyperdrive repeat pending |
| Cryptography | Web Crypto; AES-GCM for stored Salesforce tokens; no custom primitives | Key rotation rehearsed only in tests |
| Secure communication | HTTPS at Cloudflare, `sslmode` on Hyperdrive | Not testable locally |
| Configuration | Release config gate; secrets only in bindings | None found |
| Data protection | 24-hour demo retention, purge with a retention record, no real data | Backup contents after purge: documented in `docs/runbooks/RECOVERY.md` |
| Security logging | Redacted structured logs with request IDs | No alerting until hosted |

## Permission matrix reconciliation

`docs/design/PERMISSIONS-MATRIX.md` was checked against the sweep. Every guest-reachable write refuses a viewer, a cross-site origin and an anonymous caller, and every owner route refuses a guest with forged credentials. One row changed: the dispatcher is now its own database role, `opsbridge_dispatcher` (D-076), which can claim and finish outbox events and read the rules of the workspace it sets, and nothing else. The request role lost both functions.

## Gaps and follow-ups

| Gap | Why it stays | When |
|---|---|---|
| Hyperdrive, Neon, Access, R2 behavior | No accounts (DEC-002, DEC-008) | First deploy |
| Rate limiter binding on Cloudflare | Only a stub locally | First deploy |
| HSTS | Needs a stable domain | P8.4 |
| Semgrep or CodeQL | Not installed; nothing downloaded | Optional: free on a public GitHub repository once Jose approves |
| Redocly lint | Not installed; the local lint covers structure and the route match | Optional |
| Live AI red-team | P5.3 has no provider account | When Jose creates one |
| Independent human security review | None has happened | Before wide sharing, if Jose wants one |
