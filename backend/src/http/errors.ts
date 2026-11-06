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
