export interface PgQueryResult<Row extends Record<string, unknown>> {
  rows: Row[];
  rowCount: number;
}

export interface PgSessionPort {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PgQueryResult<Row>>;
}

/** Adapter boundary for pg / Neon / another PostgreSQL client. */
export interface PgDatabasePort extends PgSessionPort {
  transaction<T>(work: (session: PgSessionPort) => Promise<T>): Promise<T>;
}
