// P8.1: the browser API client. An abort that lands while the body is read must reject as an
// AbortError, never resolve with null, or a cancelled request looks like an empty success.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, api } from "../../frontend/src/api";

const abortedBody = () =>
  ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.reject(new DOMException("The operation was aborted.", "AbortError")),
  }) as unknown as Response;

afterEach(() => vi.unstubAllGlobals());

describe("api()", () => {
  it("rejects with AbortError when the body read is aborted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => abortedBody()),
    );
    await expect(api("/cases")).rejects.toMatchObject({ name: "AbortError" });
  });

  it("still treats an unreadable error body as a failure with a code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 502,
            headers: new Headers({ "x-request-id": "r-1" }),
            json: () => Promise.reject(new SyntaxError("Unexpected token")),
          }) as unknown as Response,
      ),
    );
    const err = (await api("/cases").catch((e: unknown) => e)) as ApiFailure;
    expect(err).toBeInstanceOf(ApiFailure);
    expect([err.status, err.code, err.requestId]).toEqual([502, "unknown", "r-1"]);
  });

  it("returns the parsed body on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 })),
    );
    await expect(api("/cases")).resolves.toEqual({ items: [] });
  });
});
