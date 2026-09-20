import type { PgDatabasePort, PgQueryResult, PgSessionPort } from "./postgresPort.js";

export interface PgPoolQueryResultLike {
  rows: readonly Record<string, unknown>[];
  rowCount?: number | null;
}

export interface PgPoolClientLike {
  query(sql: string, params?: readonly unknown[]): Promise<PgPoolQueryResultLike>;
  release(): void;
}

export interface PgPoolLike {
  query(sql: string, params?: readonly unknown[]): Promise<PgPoolQueryResultLike>;
  connect(): Promise<PgPoolClientLike>;
}

function adaptSession(queryable: Pick<PgPoolClientLike, "query">): PgSessionPort {
  return {
    async query<Row extends Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PgQueryResult<Row>> {
      const result = await queryable.query(sql, params);
      return { rows: result.rows.map((row) => ({ ...row }) as Row), rowCount: result.rowCount ?? result.rows.length };
    },
  };
}

/**
 * Wraps a node-postgres-compatible Pool (including Neon Pool) without coupling Core to a driver package.
 * The caller owns pool lifecycle and should close it according to the hosting runtime.
 */
export function createPgDatabasePortFromPool(pool: PgPoolLike): PgDatabasePort {
  return {
    ...adaptSession(pool),
    async transaction<T>(work: (session: PgSessionPort) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(adaptSession(client));
        await client.query("commit");
        return result;
      } catch (error) {
        try { await client.query("rollback"); } catch { /* original error wins */ }
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
