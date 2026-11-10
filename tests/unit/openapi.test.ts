// P7.1: the OpenAPI document and the Worker agree. The structural lint is
// scripts/openapi-lint.mjs; this adds the cross-check against the routes Hono registered.
import { describe, expect, it } from "vitest";
import { app } from "../../backend/src/app";
// @ts-expect-error plain ESM script without types
import { lintSpec, loadSpec, operations } from "../../scripts/openapi-lint.mjs";

const spec = loadSpec();
const key = (method: string, path: string) => `${method.toUpperCase()} ${path}`;
const documented = new Set<string>(
  operations(spec).map((o: { method: string; path: string }) => key(o.method, o.path)),
);
// Hono writes parameters as :id; OpenAPI as {id}. Middleware registrations use ALL.
const served = new Set(
  app.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => key(r.method, r.path.replace(/:([A-Za-z_]\w*)/g, "{$1}")))
    .filter((k) => / \/(api|health)\//.test(k)),
);

describe("OpenAPI document", () => {
  it("passes the structural lint", () => {
    expect(lintSpec(spec)).toEqual([]);
  });

  it("documents every API route the Worker serves", () => {
    expect([...served].filter((k) => !documented.has(k)).sort()).toEqual([]);
  });

  it("documents nothing the Worker does not serve", () => {
    expect([...documented].filter((k) => !served.has(k)).sort()).toEqual([]);
  });
});
