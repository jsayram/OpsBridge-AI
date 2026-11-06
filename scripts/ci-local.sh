#!/usr/bin/env bash
# Runs the same steps as .github/workflows/ci.yml from a clean copy of tracked and
# staged files, so nothing local leaks into the result. Exits non-zero on the first failure.
# Usage: scripts/ci-local.sh [path-to-existing-clean-copy]
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
if [[ $# -ge 1 ]]; then
  work="$1"
else
  work="$(mktemp -d)"
  trap 'rm -rf "$work"' EXIT
  git -C "$repo" ls-files -z --cached --others --exclude-standard |
    rsync -a --from0 --files-from=- "$repo"/ "$work"/
fi
cd "$work"
step() { echo; echo "=== $1"; shift; "$@"; }
step "npm ci" npm ci --no-audit --no-fund
step "format" npm run -s format:check
step "lint" npm run -s lint
step "typecheck" npm run -s typecheck
step "unit tests" npm test --silent
step "database" npm run -s db:up
step "integration tests" npm run -s test:integration
step "build" npm run -s build
step "client bundle" npm run -s check:bundle
step "fixtures" npm run -s check:fixtures
step "browser tests" npm run -s test:e2e
step "dependency audit" npm run -s audit
step "secret scan" gitleaks dir --config .gitleaks.toml --redact --exit-code 1 --no-banner .
echo; echo "ALL CHECKS PASSED"
