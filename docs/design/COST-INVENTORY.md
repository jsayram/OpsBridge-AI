# Service, cost and ownership inventory

Checked 2026-11-06 against vendor pages. Prices and free tiers change, so recheck before creating any account. Nothing here is provisioned, and no account exists. Listing a service does not approve it (PRD 17, DEC-002).

| Service | Purpose | Plan | Cost | Limit that matters | Owner | Cancel or revoke | State |
|---|---|---|---|---|---|---|---|
| Cloudflare Workers | App and API | Free | $0 | 10 ms CPU per request and cron run, 100,000 requests a day, 50 subrequests, 64 MiB uncompressed | Jose | Delete Worker | Not created |
| Cloudflare Workers Paid | PDF extraction if wanted | Paid | $5 a month | 5 min CPU | Jose | Downgrade plan | Decision DEC-003 |
| Hyperdrive | Pooling to Neon | Included | $0 | Free: 100,000 queries a day, 10 configs, about 20 origin connections | Jose | Delete config | Not created |
| Neon | PostgreSQL | Free | $0, no card required | 100 CU-hours, 1 GB, 5 GB egress, 5-minute autosuspend, 6-hour restore window, 1 manual snapshot, 10 branches | Jose | Delete project | Not created |
| Cloudflare R2 | Private documents, `pg_dump` backups | Free tier | $0 within 10 GB-month, 1M Class A, 10M Class B, free egress | Bucket setup may require a payment method; not confirmed | Jose | Delete bucket | Proposed |
| Cloudflare Access | Owner login | Zero Trust Free | $0 up to 50 users | Community reports say free checkout may ask to authorize overage charges. Check before a card goes in. | Jose | Remove app | Proposed |
| Google Cloud project and service account | Sheets API credential for Mode A | Free | $0 | 300 writes a minute per project, 60 per user. Google says charges for exceeding quota are planned later in 2026. | Jose | Delete key, remove sheet share | Not created |
| Google Sheet | Bridge to Zapier | Free | $0 | Owner-held sheet | Jose | Delete sheet | Not created |
| Zapier | One trigger, one action | Free | $0 | 100 tasks a month, 15-minute polling, one trigger and one action, no premium apps | Jose | Turn off Zap, disconnect | Not created |
| Zapier paid webhook | Mode B | Paid | Not priced here | Optional | Jose | Cancel | Not approved |
| Salesforce Developer Edition | Live read-only CRM test | Free | $0 | Test org only | Jose | Revoke connected app | Not created |
| AI provider | Owner-only live extraction | Pay as you go | Not chosen | Needs a hard budget | Jose | Revoke key | DEC-002 |
| Domain | Friendly URL | Optional | Registrar price | `workers.dev` works without one | Jose | Let it lapse | Optional |
| GitHub | Repository and Actions | Free | $0 | Public repo minutes | Jose | Delete repo | Stop point |

## Neon free compute budget

Compute has to stay under 100 CU-hours a month. Autosuspend means every wake costs at least 5 idle minutes.

| Sweep interval | Wakes a day | Idle hours a day | CU-hours a month at 0.25 CU |
|---|---:|---:|---:|
| 1 minute | 1440 | always on | 180 (over budget) |
| 15 minutes | 96 | 8 | 60 |
| 30 minutes | 48 | 4 | 30 |

So the sweep runs every 30 minutes, the compute is capped at 0.25 CU, and real traffic has about 70 CU-hours left. A 15-minute sweep still fits but leaves little margin. Cron-time reasoning uses wakes times the 5-minute idle tail and ignores sweep work, which takes well under a second.

## Workers Free CPU budget

From `docs/evidence/P0.2/` on a local Mac. Production hardware may be slower, so P1.5 must read real values from a deployed Worker.

| Work | Local CPU per request | Fits 10 ms? |
|---|---:|---|
| No-op route | 1.3 ms | Yes |
| Scoped read | 3.8 ms | Yes |
| Approval command | 4.4 ms | Yes |
| PDF, 1 page, warm | 4.7 ms | Only when warm |
| PDF, 5 pages | 13.1 ms | No |
| PDF, 20 pages | 45.9 ms | No |
