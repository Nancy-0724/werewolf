import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { CommandReceiptSchema, type CommandReceipt, type DomainEvent, parseEvent } from "../domain/schemas.js";
import type { AtomicAppendResult, DurableGameStore } from "../persistence/contracts.js";
import { parseAndVerifySnapshot, type GameSnapshot } from "../persistence/snapshot.js";
import type { PgDatabasePort, PgSessionPort } from "./postgresPort.js";

type JsonRow = { value: unknown };
type SequenceRow = { current_sequence: unknown };
type BoundaryRow = { ok: unknown };

function parseSequence(value: unknown): number {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(numeric) || numeric < 0) throw new CoreError("PERSISTENCE_ERROR", "Database returned an invalid sequence");
  return numeric;
}

function parseJsonCell(value: unknown): unknown {
  if (typeof value !== "string") return cloneJson(value);
  try { return JSON.parse(value) as unknown; } catch { throw new CoreError("PERSISTENCE_ERROR", "Database JSON column is not valid JSON"); }
}

function validateStorageBatch(gameId: string, expectedSequence: number, rawEvents: readonly DomainEvent[], rawReceipt: CommandReceipt): { events: DomainEvent[]; receipt: CommandReceipt } {
  const events = rawEvents.map(parseEvent);
  const receipt = CommandReceiptSchema.parse(cloneJson(rawReceipt));
  const first = events[0]; const last = events.at(-1);
  if (first === undefined || last === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Append batch cannot be empty");
  if (first.sequence !== expectedSequence + 1 || receipt.firstSequence !== first.sequence || receipt.lastSequence !== last.sequence) throw new CoreError("INVALID_EVENT_STREAM", "Append batch/receipt sequence mismatch");
  let next = expectedSequence + 1;
  const ids = new Set<string>();
  for (const event of events) {
    if (event.sequence !== next) throw new CoreError("INVALID_EVENT_STREAM", "Append sequence is not contiguous");
    next += 1;
    if (event.gameId !== gameId || event.causationCommandId !== receipt.commandId) throw new CoreError("INVALID_EVENT_STREAM", "Append event/receipt mismatch");
    if (ids.has(event.eventId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate eventId inside batch");
    ids.add(event.eventId);
  }
  if (receipt.gameId !== gameId || receipt.canonicalRequest.gameId !== gameId) throw new CoreError("INVALID_EVENT_STREAM", "Receipt gameId mismatch");
  return { events, receipt };
}

async function selectReceipt(session: PgSessionPort, commandId: string): Promise<CommandReceipt | null> {
  const result = await session.query<JsonRow>("select receipt_json as value from werewolf_command_receipts where command_id = $1", [commandId]);
  const row = result.rows[0];
  return row === undefined ? null : CommandReceiptSchema.parse(parseJsonCell(row.value));
}

export class PostgresGameStore implements DurableGameStore {
  readonly #db: PgDatabasePort;
  public constructor(db: PgDatabasePort) { this.#db = db; }

  async hasGame(gameId: string): Promise<boolean> {
    const result = await this.#db.query<{ game_id: unknown }>("select game_id from werewolf_games where game_id = $1", [gameId]);
    return result.rows.length > 0;
  }

  async findReceiptByCommandId(commandId: string): Promise<CommandReceipt | null> { return selectReceipt(this.#db, commandId); }

  async loadEvents(gameId: string): Promise<unknown[]> {
    const result = await this.#db.query<JsonRow>("select event_json as value from werewolf_events where game_id = $1 order by sequence asc", [gameId]);
    return result.rows.map((row) => parseJsonCell(row.value));
  }

  async loadEventsAfter(gameId: string, sequenceExclusive: number): Promise<unknown[]> {
    const result = await this.#db.query<JsonRow>("select event_json as value from werewolf_events where game_id = $1 and sequence > $2 order by sequence asc", [gameId, sequenceExclusive]);
    return result.rows.map((row) => parseJsonCell(row.value));
  }

  async loadReceipts(gameId: string): Promise<CommandReceipt[]> {
    const result = await this.#db.query<JsonRow>("select receipt_json as value from werewolf_command_receipts where game_id = $1 order by first_sequence asc", [gameId]);
    return result.rows.map((row) => CommandReceiptSchema.parse(parseJsonCell(row.value)));
  }

  async loadLatestSnapshot(gameId: string): Promise<unknown | null> {
    const result = await this.#db.query<JsonRow>("select snapshot_json as value from werewolf_snapshots where game_id = $1 order by sequence desc limit 1", [gameId]);
    const row = result.rows[0];
    return row === undefined ? null : parseJsonCell(row.value);
  }

  async currentSequence(gameId: string): Promise<number | null> {
    const result = await this.#db.query<SequenceRow>("select current_sequence from werewolf_games where game_id = $1", [gameId]);
    const row = result.rows[0];
    return row === undefined ? null : parseSequence(row.current_sequence);
  }

  async atomicAppend(gameId: string, expectedSequence: number, rawEvents: readonly DomainEvent[], rawReceipt: CommandReceipt): Promise<AtomicAppendResult> {
    const { events, receipt } = validateStorageBatch(gameId, expectedSequence, rawEvents, rawReceipt);
    try {
      return await this.#db.transaction(async (session) => {
        const existing = await selectReceipt(session, receipt.commandId);
        if (existing !== null) {
          if (existing.principalKey === receipt.principalKey && stableStringify(existing.canonicalRequest) === stableStringify(receipt.canonicalRequest)) return { kind: "IDEMPOTENT" as const, receipt: existing };
          throw new CoreError("COMMAND_ID_REUSED", "commandId already exists with different request/principal");
        }

        if (expectedSequence === 0) {
          await session.query("insert into werewolf_games (game_id, current_sequence, created_at, updated_at) values ($1, 0, now(), now()) on conflict (game_id) do nothing", [gameId]);
        }
        const locked = await session.query<SequenceRow>("select current_sequence from werewolf_games where game_id = $1 for update", [gameId]);
        const row = locked.rows[0];
        if (row === undefined) throw new CoreError("GAME_NOT_FOUND", "Durable game does not exist");
        const current = parseSequence(row.current_sequence);
        if (current !== expectedSequence) throw new CoreError("CONCURRENCY_CONFLICT", `Expected ${expectedSequence}, current ${current}`);

        for (const event of events) {
          await session.query(
            "insert into werewolf_events (game_id, sequence, event_id, transaction_id, command_id, event_type, event_version, event_json, recorded_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz)",
            [event.gameId, event.sequence, event.eventId, event.transactionId, event.causationCommandId, event.eventType, event.eventVersion, JSON.stringify(event), event.recordedAtIso],
          );
        }
        await session.query(
          "insert into werewolf_command_receipts (command_id, game_id, principal_key, first_sequence, last_sequence, outcome_code, receipt_json, created_at) values ($1,$2,$3,$4,$5,$6,$7::jsonb,now())",
          [receipt.commandId, receipt.gameId, receipt.principalKey, receipt.firstSequence, receipt.lastSequence, receipt.outcomeCode, JSON.stringify(receipt)],
        );
        await session.query("update werewolf_games set current_sequence = $2, updated_at = now() where game_id = $1", [gameId, receipt.lastSequence]);
        return { kind: "APPENDED" as const, receipt: cloneJson(receipt) };
      });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("PERSISTENCE_ERROR", error instanceof Error ? error.message : "PostgreSQL append failed");
    }
  }

  async saveSnapshot(rawSnapshot: GameSnapshot): Promise<void> {
    const snapshot = parseAndVerifySnapshot(rawSnapshot);
    try {
      await this.#db.transaction(async (session) => {
        const game = await session.query<SequenceRow>("select current_sequence from werewolf_games where game_id = $1", [snapshot.gameId]);
        const row = game.rows[0];
        if (row === undefined) throw new CoreError("GAME_NOT_FOUND", "Cannot snapshot missing game");
        if (snapshot.sequence > parseSequence(row.current_sequence)) throw new CoreError("INVALID_SNAPSHOT", "Snapshot is ahead of event stream");
        const boundary = await session.query<BoundaryRow>("select 1 as ok from werewolf_command_receipts where game_id = $1 and last_sequence = $2 limit 1", [snapshot.gameId, snapshot.sequence]);
        if (boundary.rows.length === 0) throw new CoreError("INVALID_SNAPSHOT", "Snapshot sequence is not a committed command boundary");
        await session.query(
          "insert into werewolf_snapshots (game_id, sequence, snapshot_format_version, data_schema_version, engine_contract_version, engine_build_id, state_hash_sha256, snapshot_json, created_at) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::timestamptz) on conflict (game_id, sequence) do update set snapshot_format_version = excluded.snapshot_format_version, data_schema_version = excluded.data_schema_version, engine_contract_version = excluded.engine_contract_version, engine_build_id = excluded.engine_build_id, state_hash_sha256 = excluded.state_hash_sha256, snapshot_json = excluded.snapshot_json, created_at = excluded.created_at",
          [snapshot.gameId, snapshot.sequence, snapshot.snapshotFormatVersion, snapshot.dataSchemaVersion, snapshot.engineContractVersion, snapshot.engineBuildId, snapshot.stateHashSha256, JSON.stringify(snapshot), snapshot.createdAtIso],
        );
      });
    } catch (error) {
      if (error instanceof CoreError) throw error;
      throw new CoreError("PERSISTENCE_ERROR", error instanceof Error ? error.message : "PostgreSQL snapshot write failed");
    }
  }
}
