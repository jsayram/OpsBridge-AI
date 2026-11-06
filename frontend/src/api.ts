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
  options: {
    method?: string;
    body?: unknown;
    signal?: AbortSignal;
    idempotencyKey?: string;
  } = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method: options.method ?? "GET",
      credentials: "same-origin",
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.body !== undefined
        ? {
            headers: {
              "content-type": "application/json",
              ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
            },
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

// One key per intent, kept until the server has answered. A lost response then retries with
// the same key and replays the result, where a fresh key would repeat the effect.
export function intentKeys() {
  let held: { intent: string; key: string } | null = null;
  return {
    keyFor(intent: string) {
      if (held?.intent !== intent) held = { intent, key: crypto.randomUUID() };
      return held.key;
    },
    settle(error?: unknown) {
      if (!(error instanceof ApiFailure && error.status === 0)) held = null;
    },
  };
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
  queue: string;
  assigneeId: string | null;
  assignee: string | null;
  overdue: boolean;
  ageDays: number;
  readOnly: boolean;
};

export type ChecklistItem = {
  id: string;
  key: string;
  label: string;
  required: boolean;
  state: string;
  evidenceRef: string | null;
  version: number;
};

export type HandoffRow = {
  id: string;
  fromAssignee: string | null;
  toAssignee: string | null;
  fromQueue: string;
  toQueue: string;
  dueAt: string | null;
  reason: string;
  openRequired: number;
  occurredAt: string;
};

export type CaseFull = CaseRow & {
  checklist: ChecklistItem[];
  handoffs: HandoffRow[];
  approval: { id: string; status: string; reason: string | null } | null;
  documents: { id: string; title: string; category: string | null; status: string }[];
};

export type ActivityRow = {
  id: string;
  action: string;
  actor: string;
  summary: string | null;
  occurredAt: string;
};

export type Assignee = { id: string; name: string; team: string; canReceiveCases: boolean };
export type Customer = { id: string; name: string; accountCode: string };

export type Summary = {
  provenance: string;
  workspaceCases: Record<string, number>;
  templateCases: Record<string, number>;
};
