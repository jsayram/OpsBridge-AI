# AI provider data handling (P5.3)

Status: written before any provider is chosen. Live AI review is **Pending Owner Credentials** under DEC-008: no account, key or budget exists, and the gateway has only met a labeled in-process test double. Nothing in this note has been checked against a live provider.

## What would be sent

Only to the owner, only when `AI_LIVE_ENABLED` and every limit in `docs/ENVIRONMENTS.md` are set:

- A fixed system instruction (`doc-review-v1`, in `backend/src/ai/gateway.ts`).
- The page-numbered text segments of one **fictional** document from `sample-data/documents/`, extracted at build time. Never a PDF, never a real document (DEC-003: fixtures only).

Never sent: case records, customer names from the database, user or session identifiers, cookies, tokens, other integrations' secrets, the database, or any tool definition. The model gets no tools and its answer is text that must pass `backend/src/ai/validate.ts`.

## Destination and limits

| Control | Where | Value |
|---|---|---|
| Provider allowlist | `PROVIDERS` in `gateway.ts` | Anthropic Messages API, `https://api.anthropic.com/v1/messages`. A setting can't change the URL; redirects are not followed |
| Requests per workspace and UTC day | `app.ai_usage`, reserved under a row lock before the call | Owner setting, hard cap 200 |
| Input and output tokens | Estimated before the call; `max_tokens` on the call; usage checked after | Hard caps 8,000 and 2,000 |
| Concurrency | Live reviews in Processing per workspace | Hard cap 2 |
| Timeout and retries | `callWithPolicy` with `retries: 0` | Hard cap 20 s, one call per click |
| Fallback | Any refusal or failure | The labeled fixture result, with a `degraded` code |
| Local runs | `gatewayState` | Only the in-process double; never the network. Tests also load `tests/setup/no-network.ts` |

## Retention, region and opt-out

To be filled in from the chosen provider's current terms before the first live call, and reviewed by Jose:

- How long the provider keeps prompts and outputs, and whether they are used for training. Choose the setting that keeps neither, if offered.
- Where requests are processed.
- How to delete data held by the provider.

The app itself stores, per live review: model and prompt version, input document hash, validated output or rejection codes, token counts, an estimated cost and latency. Provider error text is never stored or logged; only a code.

## Choice for Jose

The provider, the model and the daily budget are Jose's to decide. Anthropic is the coded candidate because one adapter is enough for a bounded pilot. Adding another provider is a code change with its own allowlist entry and tests. Until then live review stays off and every review in the app is the labeled deterministic fixture.
