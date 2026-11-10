#!/usr/bin/env bash
# P7.1: the release scans, offline. Writes reports to an output folder and exits non-zero if
# any scan finds something or any canary fails to trip its scanner.
#   scripts/security-scan.sh [out-dir]        default docs/evidence/P7.1/scans
# Needs gitleaks and trivy on the path, and a trivy vulnerability database already in its
# cache: this script never downloads one (--skip-db-update, --offline-scan). The database date
# is printed so a stale cache is visible. npm audit is separate (npm run audit), because it
# asks the npm registry.
set -euo pipefail

repo="$(git rev-parse --show-toplevel)"
cd "$repo"
out="${1:-docs/evidence/P7.1/scans}"
mkdir -p "$out"
canary="$(mktemp -d)"
trap 'rm -r "$canary"' EXIT
fail=0
note() { echo "$*" | tee -a "$out/summary.txt"; }
: >"$out/summary.txt"
t() { trivy fs --skip-db-update --skip-java-db-update --offline-scan --skip-version-check --quiet "$@"; }

note "Scan run $(date -u +%Y-%m-%dT%H:%M:%SZ) at $(git rev-parse --short HEAD)"
note "gitleaks $(gitleaks version) | trivy $(trivy --version | head -1 | awk '{print $2}') | node $(node -v)"
note "trivy DB: $(trivy --version | sed -n 's/.*UpdatedAt: //p' | head -1)"

# 1. Dependency vulnerabilities, production and development, app and the P0.2 spike.
for target in . spikes/p0.2; do
  name="$(echo "$target" | tr '/.' '__')"
  skip=(--skip-dirs node_modules)
  [[ "$target" == . ]] && skip+=(--skip-dirs spikes)
  t --scanners vuln --include-dev-deps "${skip[@]}" --format json --output "$out/vuln$name.json" "$target"
  n="$(node -e 'const r=require(process.argv[1]);let n=0;for(const x of r.Results??[])n+=(x.Vulnerabilities??[]).length;console.log(n)' "$PWD/$out/vuln$name.json")"
  note "vulnerabilities in $target: $n"
  [[ "$n" == 0 ]] || fail=1
done

# 2. Licenses, including development tools, with the restrictive ones listed.
t --scanners license --include-dev-deps --skip-dirs spikes --format json --output "$out/licenses.json" .
node -e '
const r = require(process.argv[1]); const c = {}; const flagged = new Set();
for (const x of r.Results ?? []) for (const l of x.Licenses ?? []) {
  c[l.Name] = (c[l.Name] ?? 0) + 1;
  if (["HIGH", "CRITICAL", "UNKNOWN"].includes(l.Severity)) flagged.add(`${l.PkgName} (${l.Name})`);
}
console.log("licenses: " + Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("restrictive or unknown: " + ([...flagged].join(", ") || "none"));
' "$PWD/$out/licenses.json" | tee -a "$out/summary.txt"

# 3. SBOMs: what ships (runtime dependencies) and the whole tree including build tools.
t --format cyclonedx --skip-dirs spikes --output "$out/sbom-runtime.cdx.json" .
t --format cyclonedx --include-dev-deps --skip-dirs spikes --output "$out/sbom-all.cdx.json" .
count() { node -e 'console.log(require(process.argv[1]).components.length)' "$PWD/$1"; }
note "SBOM runtime: $(count "$out/sbom-runtime.cdx.json") components; with build tools: $(count "$out/sbom-all.cdx.json")"

# 4. Secrets: working tree and full git history.
if gitleaks dir --config .gitleaks.toml --redact --exit-code 1 --no-banner \
  --report-format json --report-path "$out/gitleaks-dir.json" . >/dev/null 2>&1; then
  note "gitleaks working tree: clean"
else
  note "gitleaks working tree: FINDINGS"; fail=1
fi
if gitleaks git --config .gitleaks.toml --redact --exit-code 1 --no-banner \
  --report-format json --report-path "$out/gitleaks-git.json" . >/dev/null 2>&1; then
  note "gitleaks history ($(git rev-list --count HEAD) commits): clean"
else
  note "gitleaks history: FINDINGS"; fail=1
fi

# 5. Project static checks.
if node scripts/sast.mjs >"$out/sast.txt" 2>&1; then note "$(cat "$out/sast.txt")"; else
  note "SAST: FINDINGS (see $out/sast.txt)"; fail=1
fi

# Canaries: each scanner must fail on a planted problem. Nothing planted is committed; the
# secret is generated here and lives only in a temporary folder.
mkdir -p "$canary/secret" "$canary/vuln" "$canary/sast/backend/src"
secret="ghp_$(node -e 'const a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";console.log(Array.from(crypto.getRandomValues(new Uint8Array(36)),(b)=>a[b%62]).join(""))')"
printf 'const token = "%s";\n' "$secret" >"$canary/secret/config.ts"
if gitleaks dir --redact --exit-code 1 --no-banner "$canary/secret" >/dev/null 2>&1; then
  note "CANARY gitleaks: did NOT trip"; fail=1
else note "canary gitleaks: tripped on a planted token"; fi
cat >"$canary/vuln/package-lock.json" <<'EOF'
{"name":"canary","lockfileVersion":3,"requires":true,"packages":{"":{"name":"canary","dependencies":{"lodash":"4.17.15"}},"node_modules/lodash":{"version":"4.17.15"}}}
EOF
if t --scanners vuln --exit-code 1 --severity HIGH,CRITICAL "$canary/vuln" >/dev/null 2>&1; then
  note "CANARY trivy: did NOT trip"; fail=1
else note "canary trivy: tripped on lodash 4.17.15"; fi
printf 'export const x = (s: string) => eval(s);\n' >"$canary/sast/backend/src/bad.ts"
if node scripts/sast.mjs "$canary/sast" >/dev/null 2>&1; then
  note "CANARY sast: did NOT trip"; fail=1
else note "canary sast: tripped on eval"; fi

[[ $fail == 0 ]] && note "SECURITY SCAN PASSED" || note "SECURITY SCAN FAILED"
exit $fail
