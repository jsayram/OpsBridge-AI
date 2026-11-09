#!/usr/bin/env node
// P7.1: structural lint of docs/design/openapi.yaml. Redocly and Spectral are not installed and
// nothing is downloaded, so this checks the rules that matter here directly. YAML is read through
// the system Ruby's standard library (Psych), which every macOS and GitHub Ubuntu runner has.
//   node scripts/openapi-lint.mjs [spec]    exits 1 and lists problems
// The route cross-check against the Worker lives in tests/unit/openapi.test.ts.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const SPEC = "docs/design/openapi.yaml";
const METHODS = ["get", "put", "post", "delete", "options", "head", "patch", "trace"];

export function loadSpec(path = SPEC) {
  const r = spawnSync(
    "ruby",
    ["-ryaml", "-rjson", "-e", "puts JSON.generate(YAML.load_file(ARGV[0]))", path],
    { encoding: "utf8" },
  );
  if (r.error || r.status !== 0) {
    throw new Error(`could not read ${path} as YAML: ${r.error?.message ?? r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

export const operations = (spec) =>
  Object.entries(spec.paths ?? {}).flatMap(([path, item]) =>
    METHODS.filter((m) => item[m]).map((method) => ({ path, method, op: item[method], item })),
  );

const resolve = (spec, ref) => {
  if (!ref.startsWith("#/")) return undefined;
  return ref
    .slice(2)
    .split("/")
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .reduce((node, key) => (node == null ? undefined : node[key]), spec);
};

export function lintSpec(spec) {
  const problems = [];
  const bad = (where, msg) => problems.push(`${where}: ${msg}`);

  if (!/^3\.(0|1)\.\d+$/.test(String(spec.openapi))) bad("openapi", "must be 3.0.x or 3.1.x");
  if (!spec.info?.title || !spec.info?.version) bad("info", "title and version are required");
  if (!Array.isArray(spec.servers) || spec.servers.length === 0) bad("servers", "none declared");

  // Every $ref resolves.
  const walk = (node, at) => {
    if (Array.isArray(node)) {
      for (const [i, n] of node.entries()) walk(n, `${at}/${i}`);
    } else if (node && typeof node === "object") {
      if (typeof node.$ref === "string" && resolve(spec, node.$ref) === undefined) {
        bad(at, `unresolved $ref ${node.$ref}`);
      }
      for (const [k, v] of Object.entries(node)) walk(v, `${at}/${k}`);
    }
  };
  walk(spec, "#");

  const tags = new Set((spec.tags ?? []).map((t) => t.name));
  const schemes = new Set(Object.keys(spec.components?.securitySchemes ?? {}));
  for (const req of spec.security ?? []) {
    for (const name of Object.keys(req)) {
      if (!schemes.has(name)) bad("security", `unknown scheme ${name}`);
    }
  }
  const seen = new Map();
  for (const { path, method, op, item } of operations(spec)) {
    const where = `${method.toUpperCase()} ${path}`;
    if (!path.startsWith("/")) bad(where, "path must start with /");
    if (!op.operationId) bad(where, "operationId missing");
    else if (seen.has(op.operationId))
      bad(where, `operationId ${op.operationId} also on ${seen.get(op.operationId)}`);
    else seen.set(op.operationId, where);
    if (!op.summary && !op.description) bad(where, "summary or description missing");
    for (const t of op.tags ?? []) if (!tags.has(t)) bad(where, `tag ${t} not declared`);
    if (!op.tags?.length) bad(where, "no tag");
    const responses = Object.keys(op.responses ?? {});
    if (!responses.length) bad(where, "no responses");
    // x-disabled marks an operation that is deliberately refused every time (DEC-003 upload).
    if (!op["x-disabled"] && !responses.some((c) => /^[23]\d\d$/.test(c))) {
      bad(where, "no success response");
    }
    for (const req of op.security ?? []) {
      for (const name of Object.keys(req))
        if (!schemes.has(name)) bad(where, `unknown scheme ${name}`);
    }
    // A write must say what happens to a refused caller.
    if (["post", "put", "patch", "delete"].includes(method) && op.security?.length !== 0) {
      if (!responses.some((c) => /^4\d\d$/.test(c) || c === "default")) {
        bad(where, "a write documents no 4xx response");
      }
    }
    // Path template parameters are declared, in: path, required.
    const params = [...(item.parameters ?? []), ...(op.parameters ?? [])].map((p) =>
      p.$ref ? resolve(spec, p.$ref) : p,
    );
    for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1])) {
      const p = params.find((x) => x?.in === "path" && x?.name === name);
      if (!p) bad(where, `path parameter {${name}} not declared`);
      else if (p.required !== true) bad(where, `path parameter {${name}} must be required`);
    }
    for (const p of params) {
      if (p?.in === "path" && !path.includes(`{${p.name}}`))
        bad(where, `declares path parameter ${p.name} not in the path`);
    }
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2] ?? SPEC;
  const spec = loadSpec(path);
  const problems = lintSpec(spec);
  if (problems.length) {
    console.error(`OpenAPI lint FAILED: ${problems.length} problem(s) in ${path}`);
    for (const p of problems) console.error(`- ${p}`);
    process.exit(1);
  }
  console.log(`OpenAPI lint passed: ${operations(spec).length} operations in ${path}`);
}
