#!/usr/bin/env node
// Fails if the seed manifest misses a PRD Section 16 minimum, or if any sample or
// prototype file contains something that looks like a real identifier.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const m = JSON.parse(readFileSync("sample-data/seed-manifest.json", "utf8"));
const t = m.template;
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const errors = [];
const need = (ok, msg) => {
  if (!ok) errors.push(msg);
};

need(t.organizations >= 6, "6 organizations");
need(t.contacts >= 40, "40 contacts");
need(t.cases.total >= 120 && sum(t.cases.byStatus) === t.cases.total, "120 cases across statuses");
need(Object.keys(t.cases.byStatus).length === 6, "cases span all six statuses");
need(t.cases.needingReview >= 20, "20 cases needing review");
need(
  t.documents.total >= 40 &&
    t.documents.standard + t.documents.messy + t.documents.adversarial === t.documents.total,
  "40 documents",
);
need(
  t.documents.standard >= 20 && t.documents.messy >= 10 && t.documents.adversarial >= 10,
  "document categories",
);
need(t.invoices >= 80, "80 invoices");
need(t.inventoryReferences >= 20, "20 inventory references");
need(t.reconciliationDiscrepancies >= 15, "15 discrepancies");
need(t.activityEvents >= 30, "30 activity events");
need(
  t.automationEvents.total >= 20 && sum(t.automationEvents.byLabel) === t.automationEvents.total,
  "20 automation events",
);
need(!("Delivered" in t.automationEvents.byLabel), "no Delivered label");
need(t.snapshotDays >= 90, "90 days of snapshots");
need(t.teams.length >= 2, "two teams");
need(new Set(m.namedFixtures.map((f) => f.prd)).size === 8, "named fixtures 1 to 8");
const packRows = sum(m.scenarioPack.rows);
need(packRows <= 40, `scenario pack stays small, got ${packRows}`);
need(
  m.organizationNames.every((n) => n.endsWith("(fictional)")),
  "organization names marked fictional",
);

const banned = [
  [/\b\d{3}-\d{2}-\d{4}\b/, "SSN pattern"],
  [/\b[A-Z]\d{8}\b/, "passport-like number"],
  [/\b(?:\d[ -]?){15,16}\b/, "card-like number"],
  [/[a-z0-9._%+-]+@(?!example\.com\b)[a-z0-9-]+\.[a-z]{2,}/i, "non-example email"],
  [/m[aá]s ?labor/i, "employer name"],
  [/\b(?:Salesforce|NetSuite) (?:connected|live)\b/i, "false live claim"],
];
const walk = (d) =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
// P5 fixture PDFs: their extracted text is in sample-data/documents/manifest.json, which is
// scanned below. The binary files are held to that manifest by hash instead, since PDF offsets
// look like long digit runs. `npm run check:documents` regenerates them and compares bytes.
const library = JSON.parse(readFileSync("sample-data/documents/manifest.json", "utf8"));
const byCat = (c) => library.documents.filter((d) => d.category === c).length;
need(library.documents.length === t.documents.total, "40 fixture documents in the library");
need(
  byCat("standard") === t.documents.standard &&
    byCat("messy") === t.documents.messy &&
    byCat("adversarial") === t.documents.adversarial,
  "fixture library categories match the manifest",
);
for (const d of library.documents) {
  const sha = createHash("sha256")
    .update(readFileSync(`sample-data/documents/${d.file}`))
    .digest("hex");
  need(sha === d.sha256, `${d.file} matches its recorded hash`);
}
const files = [...walk("sample-data"), ...walk("docs/prototypes")].filter(
  (f) => !f.endsWith(".pdf"),
);
for (const f of files) {
  const text = readFileSync(f, "utf8");
  for (const [re, name] of banned) if (re.test(text)) errors.push(`${f}: ${name}`);
}
if (errors.length) {
  console.error(`Fixture check FAILED:\n- ${errors.join("\n- ")}`);
  process.exit(1);
}
console.log(
  `Fixture check passed: ${files.length} files scanned, pack ${packRows} rows, template ${t.cases.total} cases.`,
);
