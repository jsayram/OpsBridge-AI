#!/usr/bin/env node
// P7.1: project static checks for the patterns this codebase must never grow. A small,
// dependency-free rule set, not a general SAST product: Semgrep and CodeQL are not installed
// here and nothing is downloaded. Each rule names the threat in PRD 12.2 it guards.
//   node scripts/sast.mjs [root]      exits 1 and lists findings if any rule matches
// A line can opt out only with `sast-ok: <reason>` in a comment on it or the line above.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const SOURCES = ["backend/src", "frontend/src"];

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return /\.(ts|tsx|mjs|js)$/.test(name) ? [p] : [];
  });

// Files allowed to reach the network, with the reason. Everything else in backend/src must not
// call fetch: a new outbound call has to be reviewed for SSRF and added here (PRD 12.2 SSRF).
const FETCH_ALLOWED = {
  "backend/src/ai/gateway.ts": "owner-only live AI, fixed provider host allowlist",
  "backend/src/auth/accessJwt.ts": "Access JWKS from the configured team domain",
  "backend/src/integrations/salesforce.ts": "owner-only connector, redirect: manual",
  "backend/src/integrations/sinks.ts": "owner-only Sheets bridge, fixed Google hosts",
  "backend/src/app.ts": "ASSETS binding, not the network",
};
// Math.random is fine for retry jitter, never for a token or identifier.
const RANDOM_ALLOWED = {
  "backend/src/integrations/http.ts": "retry jitter",
  "backend/src/integrations/sinks.ts": "retry jitter",
};

const rules = [
  {
    id: "xss-raw-html",
    threat: "Cross-site scripting",
    test: /dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML|document\.write\(/,
  },
  {
    id: "code-injection",
    threat: "Code injection",
    test: /\beval\(|new Function\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/,
  },
  {
    id: "ssrf-unreviewed-fetch",
    threat: "SSRF and untrusted URLs",
    scope: /^backend\/src\//,
    test: /\bfetch\(/,
    allowFile: FETCH_ALLOWED,
  },
  {
    id: "weak-random",
    threat: "Stolen or forged session (predictable tokens)",
    scope: /^backend\/src\//,
    test: /Math\.random/,
    allowFile: RANDOM_ALLOWED,
  },
  {
    id: "raw-console",
    threat: "Secrets in logs (bypasses the redacting logger)",
    scope: /^backend\/src\//,
    test: /\bconsole\.(log|info|warn|error|debug)\(/,
    allowFile: { "backend/src/http/log.ts": "the redacting logger itself" },
  },
  {
    id: "cookie-flags",
    threat: "Stolen or forged session (cookie flags)",
    scope: /^backend\/src\//,
    // A setCookie call must name httpOnly, secure and sameSite within the next few lines.
    block: (lines, i) => {
      if (!/\bsetCookie\(/.test(lines[i]) || /^\s*import\b/.test(lines[i])) return false;
      const window = lines.slice(i, i + 8).join("\n");
      return !(
        /httpOnly:\s*true/.test(window) &&
        /secure:/.test(window) &&
        /sameSite:/.test(window)
      );
    },
  },
];

// SQL built from interpolation. Every name in an interpolated expression must be a module-level
// constant (`const NAME = ...` at column 0 in the same file, or an imported SCREAMING_SNAKE name), so values can only arrive through
// $n parameters. A query whose fragments are chosen at run time from constants carries sast-ok
// on the line of `.query(` or the line above it, with the reason.
function sqlFindings(rel, text) {
  const out = [];
  const constants = new Set(
    [...text.matchAll(/^(?:export )?const ([A-Za-z_]\w*)\s*=/gm)].map((m) => m[1]),
  );
  const lines = text.split("\n");
  for (const m of text.matchAll(/\.query\(\s*`((?:[^`\\]|\\.)*)`/g)) {
    const start = text.slice(0, m.index).split("\n").length;
    if (optedOut(lines, start - 1)) continue;
    for (const v of m[1].matchAll(/\$\{([^}]*)\}/g)) {
      const expr = v[1].replace(/"[^"]*"|'[^']*'/g, "");
      const names = [...expr.matchAll(/(?<![.\w])([A-Za-z_]\w*)/g)].map((x) => x[1]);
      // SCREAMING_SNAKE names are imported module constants by this codebase's convention.
      if (names.length && names.every((n) => constants.has(n) || /^[A-Z][A-Z0-9_]*$/.test(n))) {
        continue;
      }
      const line = start + m[1].slice(0, v.index).split("\n").length - 1;
      out.push({
        rule: "sql-interpolation",
        threat: "SQL injection",
        file: rel,
        line,
        text: `\${${v[1].trim()}}`,
      });
    }
  }
  return out;
}

const optedOut = (lines, i) =>
  /sast-ok:\s*\S/.test(lines[i] ?? "") || /sast-ok:\s*\S/.test(lines[i - 1] ?? "");

const findings = [];
for (const base of SOURCES) {
  let files;
  try {
    files = walk(join(root, base));
  } catch {
    continue;
  }
  for (const file of files) {
    const rel = relative(root, file).split("\\").join("/");
    const text = readFileSync(file, "utf8");
    const lines = text.split("\n");
    for (const rule of rules) {
      if (rule.scope && !rule.scope.test(rel)) continue;
      if (rule.allowFile?.[rel]) continue;
      lines.forEach((l, i) => {
        const hit = rule.block ? rule.block(lines, i) : rule.test.test(l);
        if (hit && !optedOut(lines, i)) {
          findings.push({
            rule: rule.id,
            threat: rule.threat,
            file: rel,
            line: i + 1,
            text: l.trim().slice(0, 100),
          });
        }
      });
    }
    if (rel.startsWith("backend/src/")) findings.push(...sqlFindings(rel, text));
  }
}

const ruleCount = rules.length + 1;
if (findings.length) {
  console.error(`SAST FAILED: ${findings.length} finding(s) across ${ruleCount} rules`);
  for (const f of findings)
    console.error(`- [${f.rule}] ${f.file}:${f.line} ${f.text} (${f.threat})`);
  process.exit(1);
}
console.log(`SAST passed: ${ruleCount} rules, sources ${SOURCES.join(", ")}`);
