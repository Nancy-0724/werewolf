# PostgreSQL setup for A-05

A-05 defines the durable contract and PostgreSQL adapter without embedding credentials or a specific cloud vendor in Core.

## Migration

Run:

```text
db/migrations/0001_a05_event_store.sql
db/migrations/0002_c01_npc_cognitive_state.sql
```

against the target PostgreSQL database.

It creates:

- `werewolf_games`
- `werewolf_events`
- `werewolf_command_receipts`
- `werewolf_snapshots`

## Runtime wiring

`PostgresGameStore` accepts the repository's `PgDatabasePort`. `createPgDatabasePortFromPool()` can wrap a node-postgres-compatible `Pool` supplied by the future Web infrastructure layer.

Conceptually:

```text
PostgreSQL / Neon driver Pool
        ↓
createPgDatabasePortFromPool(pool)
        ↓
PostgresGameStore
        ↓
DurableGameService
        ↓
Game Core
```

The Core package intentionally does not read `DATABASE_URL` itself. Environment variables and driver construction belong to the future Next.js/Vercel infrastructure layer.

## Required production rules

- use SSL according to provider requirements;
- store `DATABASE_URL` in hosting environment secrets, never Git;
- run migrations before serving traffic;
- use one durable database for Production and a separate database/branch for Preview/Test;
- do not treat `werewolf_snapshots` as backup truth;
- backup `werewolf_events` and `werewolf_command_receipts` as the authoritative game history.

## Current verification boundary

The A-05 unit/smoke suite tests durable semantics, migration contents and transaction-adapter BEGIN/COMMIT/ROLLBACK behavior. This delivery environment does not provide a live PostgreSQL instance or credentials, so live DB integration is intentionally not marked PASS.
