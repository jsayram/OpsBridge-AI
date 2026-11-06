export class ApiFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export async function api<T>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body !== undefined
        ? {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(options.body),
          }
        : {}),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiFailure(0, "offline", "We couldn't reach the server.", null);
  }
  const body = (await res.json().catch(() => null)) as Record<string, string> | null;
  if (!res.ok) {
    throw new ApiFailure(
      res.status,
      body?.code ?? "unknown",
      body?.message ?? "Something went wrong.",
      body?.requestId ?? res.headers.get("x-request-id"),
    );
  }
  return body as T;
}

export type Me =
  | {
      kind: "guest";
      demoRole: "viewer" | "analyst" | "manager";
      capabilities: string[];
      workspaceName: string;
      expiresAt: string;
      expiresInSeconds: number;
      environment: string;
    }
  | { kind: "owner"; capabilities: string[] };

export type CaseRow = {
  id: string;
  title: string;
  caseType: string;
  status: string;
  dueAt: string | null;
  version: number;
  customer: string;
  readOnly: boolean;
};

export type Summary = {
  provenance: string;
  workspaceCases: Record<string, number>;
  templateCases: Record<string, number>;
};
