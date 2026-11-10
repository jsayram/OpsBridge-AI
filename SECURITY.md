# Security policy

OpsBridge AI is an independent portfolio application. All data is synthetic. It holds no certification, and it isn't affiliated with any named vendor or employer. Passing a test in this repository is not a compliance claim.

## Supported versions

Pre-release. Only the latest commit on the default branch receives fixes.

## Reporting a vulnerability

A private reporting channel isn't set up yet. Before the public release (P8.4) this section will name one. Until then, please don't include exploit details in a public issue.

## How this project handles security

- `THREAT-MODEL.md` lists assets, threats, controls and residual risks.
- `docs/design/PERMISSIONS-MATRIX.md` lists every role and action.
- CI runs dependency and secret scans. Known limits are recorded and not hidden.
- Secrets live in host-managed environment bindings, never in the repository. `.env.example` lists names only.
- Real personal, employer or immigration data must never enter this project.
