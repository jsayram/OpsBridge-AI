import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const notFound = () => new ApiError(404, "not_found", "Not found");
export const forbidden = () => new ApiError(403, "forbidden", "You can't do that here");
export const invalidRequest = (message = "Invalid request") =>
  new ApiError(400, "invalid_request", message);

export const errorBody = (code: string, message: string, requestId: string) => ({
  code,
  message,
  requestId,
});

// Database outcomes a request can legitimately meet. Everything else stays a 500.
export function databaseError(code: string | undefined): ApiError | null {
  switch (code) {
    case "P0008":
      return new ApiError(
        429,
        "demo_write_limit",
        "This demo workspace has reached its limit. Reset it to keep going.",
      );
    case "23505":
      return new ApiError(409, "conflict", "That was already done. Reload and check.");
    case "55P03": // lock_timeout
    case "57014": // statement_timeout
    case "40P01": // deadlock
      return new ApiError(503, "busy", "The system is busy. Try again in a moment.");
    default:
      return null;
  }
}
