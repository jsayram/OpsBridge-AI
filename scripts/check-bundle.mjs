#!/usr/bin/env node
// P1-D: fails if the client bundle or anything else built for the browser contains a
// credential shape, a server-only variable name or a connection string.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const banned = [
  [/postgres(ql)?:\/\//i, "connection string"],
  [/local_dev_only/, "local database password"],
  [/IP_HASH_KEY|OWNER_TEST_JWKS|OWNER_SUBJECT_ALLOWLIST|ACCESS_AUD|HYPERDRIVE/, "server variable"],
  [/GOOGLE_SA_KEY|SALESFORCE_CLIENT|ZAPIER_HOOK_URL|AI_PROVIDER_KEY/, "provider secret name"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "private key"],
  [/\bsk-[A-Za-z0-9]{20,}\b|\bAKIA[0-9A-Z]{16}\b|\bghp_[A-Za-z0-9]{36}\b/, "API key shape"],
  [/hooks\.zapier\.com/, "webhook URL"],
];
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const files = walk("dist/client");
const hits = [];
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [re, name] of banned) if (re.test(text)) hits.push(`${f}: ${name}`);
}
if (hits.length) {
  console.error(`Bundle check FAILED:\n- ${hits.join("\n- ")}`);
  process.exit(1);
}
console.log(`Bundle check passed: ${files.length} files in dist/client.`);
