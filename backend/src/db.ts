import { Client, type ClientBase, type QueryResultRow } from "pg";
import { ApiError } from "./http/errors";

export type Db = Pick<ClientBase, "query">;
export type { QueryResultRow };

const CONNECT_TIMEOUT_MS = 10_000;

const open = async (hyperdrive: Hyperdrive): Promise<Client> => {
  const client = new Client({
    connectionString: hyperdrive.connectionString,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
  });
  try {
    await client.connect();
  } catch {
    await client.end().catch(() => {});
    throw new ApiError(503, "database_unavailable", "The database is not responding. Try again.");
  }
  return client;
};

// One client per request, as Cloudflare recommends for Hyperdrive.
export async function withClient<T>(
  hyperdrive: Hyperdrive,
  fn: (db: Client) => Promise<T>,
): Promise<T> {
  const client = await open(hyperdrive);
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

export async function inTransaction<T>(db: Client, fn: () => Promise<T>): Promise<T> {
  await db.query("BEGIN");
  try {
    const out = await fn();
    await db.query("COMMIT");
    return out;
  } catch (e) {
    await db.query("ROLLBACK").catch(() => {});
    throw e;
  }
}

// An explicit transaction is required: set_config(..., true) ends with it, so a pooled
// connection can never carry one visitor's workspace into the next request.
export const withWorkspace = <T>(
  hyperdrive: Hyperdrive,
  workspaceId: string,
  fn: (db: Db) => Promise<T>,
): Promise<T> =>
  withClient(hyperdrive, (db) =>
    inTransaction(db, async () => {
      await db.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
      return fn(db);
    }),
  );

export const pgCode = (e: unknown): string | undefined =>
  typeof e === "object" && e !== null && "code" in e ? String(e.code) : undefined;
