# Threat model

Review date: 2026-11-06, P0.3. Next review: end of P4 and at P7.1. This is engineering work against OWASP ASVS, the API and LLM Top 10 lists and NIST SSDF as checklists. It is not a compliance claim and not an independent audit. PRD 12.2 stays the master threat-to-control table; this document adds the system-specific analysis.

Trust boundaries TB1 to TB10 and the diagram are in `ARCHITECTURE.md`.

## Assets

| Asset | Sensitivity | Where it lives |
|---|---|---|
| Deployment credentials | Critical | GitHub and Cloudflare, owner only |
| OIDC identity | Critical | Identity provider, MFA |
| Database role credentials (app, cleanup, migrator) | Critical | Hyperdrive configs; migrator in CI secret only |
| Salesforce tokens | High | Encrypted server-side reference, never the browser |
| Google service account key | High | Worker secret `GOOGLE_SA_KEY`; can reach one sheet |
| Zapier account and its Google connection | High | Jose's Zapier account |
| Zapier hook URL, AI key | High | Worker secrets, if ever approved |
| Demo session tokens | Medium | Browser cookie; only the hash in the database |
| Audit evidence | Medium | `audit_events` |
| Cost budget | Medium | Neon compute, Zapier tasks, AI budget |
| Synthetic records and documents | Low | Database, private R2 |

## Attacker models

1. Anonymous visitor scripting the public API.
2. Guest editing cookies and bodies to reach another workspace or admin.
3. Malicious document text, or a hostile CRM or webhook value.
4. A compromised dependency or CI action.
5. A bug in our own code, such as a missing `WHERE`. Controls below assume this happens.

## Flow-by-flow analysis

| Flow | Threat | Control | Test | Residual |
|---|---|---|---|---|
| Launch demo | Session flood burns Neon compute and storage | Per IP-hash hourly launch cap in `demo_quota` (5), a cap of 150 unpurged demo workspaces that counts expired ones, the Workers rate-limit binding as an approximate outer layer if the plan offers it, 2-hour TTL | Quota exhaustion, E2E-18 | Distributed flood could still wake Neon. A separate launch-pause flag then stops new workspaces and shows the recorded walkthrough; emergency mode itself keeps the demo, per PRD 17 |
| Launch demo | Token guessing | 256-bit random token, SHA-256 hash stored, `__Host-` cookie | Forged cookie test | None known |
| Any read | Missing workspace filter | Query scoping, then RLS, then composite FKs | P3.a to P3.e proofs; ID-swap matrix in P1.3, P2.2 | A bug in `set_config` handling; tested by a canary query in integration tests |
| Any read | Connection reuse leaks workspace | `set_config(..., true)` scope ends with the transaction | P3.e local; **must repeat through real Hyperdrive** | Pending Hyperdrive |
| Any write | CSRF | `SameSite=Strict`, Origin must equal the app origin on every non-GET, JSON content type required | Cross-origin rejection | None known |
| Any write | Mass assignment, role edit | Strict DTOs reject unknown fields; role read from the server | E2E-04 | None known |
| Approve | Double click or race | Conditional update, version check, unique key | P2.a to P2.e proofs | Hyperdrive repeat pending |
| Dispatch | Replay sends twice | Lease plus check-before-append | P4.a to P4.e proofs with a simulated sheet | Late-landing append, see `docs/design/INTEGRATION-CONTRACTS.md` |
| Dispatch | Guest reaches a live sink | Transport chosen from workspace mode read from the database | P4.1 denial, E2E-17 | None known |
| Dispatch | Sheet formula injection | Prefix values starting with `= + - @` with a quote; `valueInputOption=RAW` | P4.3 test | None known |
| Cleanup | Purge hits the wrong workspace | Cleanup role has no table rights; purge function refuses owner, template and unexpired | P3.n to P3.u proofs | None known |
| Cleanup | A bug flips an owner workspace to demo so the purge takes it | Runtime role has no UPDATE on `workspaces`; expire function acts on demo rows only | P3.s2, P3.s5 | None known |
| Cleanup | Audit tampering through the cleanup role | Only reaches rows via the purge function | P3.n, P3.q | A leaked cleanup credential could purge demo workspaces early only after they expire, which is the policy anyway |
| Dispatch | Template rows claimed or sent | `claim_due_outbox` excludes template mode | P4.f | None known |
| Dispatch | Poison event loops forever | Attempt cap inside the claim | P4.g | None known |
| Any write | Retry repeats a create | `idempotency_keys` row in the same transaction | E2E-05 at P2.2 | None known |
| Documents | Malicious upload | Guests can't upload. Owner path: byte sniffing, limits, quarantine | Guest denial now; P5.1 for the rest | PDF parser bugs on the owner path |
| AI | Prompt injection | No tools, no secrets, strict schema, human decision, abstention | Adversarial suite in P5.5 | Quality of extraction is bounded by the fixture set |
| Reports | CSV formula injection | Prefix neutralization, row and range caps | JOB-TEST-04 | None known |
| Admin | Guest reaches admin | Verified JWT, subject allowlist; path 404 when unconfigured | E2E-03, E2E-04 | Provider choice pending DEC-002; behavior fixed either way |
| Secrets | Leak to bundle, logs, repo | Env bindings, log allowlist, gitleaks in CI | P0.5 canary, E2E-27 | Local history scan only until a remote exists |
| Supply chain | Malicious package | Lockfile, `npm ci`, pinned actions by SHA, `npm audit` | P0.5 | `npm audit` covers known issues only |
| Cost | Neon compute exhausted, DB suspended | 0.25 CU cap, 30-minute sweep, no keep-warm, launch caps | Budget table in `docs/design/COST-INVENTORY.md` | Suspension until the next billing period is a real outage; landing page and recording survive |
| Availability | Free-plan 10 ms CPU exceeded | Requests measured at about 4 ms locally; no PDF parsing on public paths | P1.5 reads real CPU time | Production CPU unknown until a Worker is deployed |
| Network | Neon endpoint reachable from the internet | TLS required, strong generated passwords, least-privilege roles, no anonymous access | Check at P1.1 with a real project | See below |

## Database network exposure (ADR proof 5)

Status: **Pending Owner Configuration.** Treat Neon's endpoint as reachable from the internet. Neon lists IP Allow as a Scale plan feature, so the Free plan is assumed not to have it. Compensating controls are TLS, long generated passwords, separate roles, RLS and no public role. A leaked `opsbridge_app` credential would let an attacker read every workspace by setting `app.workspace_id`, but the data is synthetic and the role can't delete. Jose must review this residual risk at P1.1, per PRD 6.3.

## Open items

Nothing security-critical is unspecified. These are pending configuration, each with a safe default that applies until it's resolved:

| Item | Safe default | Decide by |
|---|---|---|
| Owner identity provider (DEC-002) | Admin paths return 404 | P1.2 |
| Hyperdrive repeat of proofs 2 and 3 | Stay local, no release | P1.5 |
| Neon exposure review | No hosted database | P1.1 |
| Live AI provider | Fixtures only | P5.3 |
| PDF extraction location (DEC-003) | No owner upload | P5.1 |

The words "TBD" and "to be decided" don't appear in the security design documents. `docs/reports/P0.6.md` records that check.
