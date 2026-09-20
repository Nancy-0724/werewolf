import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { replay } from "../domain/reducer.js";
import { CommandReceiptSchema, type CommandReceipt, type DomainEvent } from "../domain/schemas.js";
import { validateAppendBatch } from "../persistence/appendValidation.js";
import type { AtomicAppendResult, DurableGameStore } from "../persistence/contracts.js";
import { GameSnapshotSchema, type GameSnapshot } from "../persistence/snapshot.js";

interface DurableGameRecord {
  events: DomainEvent[];
  receipts: CommandReceipt[];
  snapshots: unknown[];
}

/** Test/local durable store. Reusing the same instance simulates process restarts against persistent truth. */
export class InMemoryDurableGameStore implements DurableGameStore {
  readonly #games = new Map<string, DurableGameRecord>();

  async hasGame(gameId: string): Promise<boolean> { return this.#games.has(gameId); }

  async findReceiptByCommandId(commandId: string): Promise<CommandReceipt | null> {
    for (const record of this.#games.values()) {
      const found = record.receipts.find((entry) => entry.commandId === commandId);
      if (found !== undefined) return cloneJson(found);
    }
    return null;
  }

  async loadEvents(gameId: string): Promise<unknown[]> { return cloneJson(this.#games.get(gameId)?.events ?? []); }
  async loadEventsAfter(gameId: string, sequenceExclusive: number): Promise<unknown[]> { return cloneJson((this.#games.get(gameId)?.events ?? []).filter((event) => event.sequence > sequenceExclusive)); }
  async loadReceipts(gameId: string): Promise<CommandReceipt[]> { return cloneJson(this.#games.get(gameId)?.receipts ?? []); }
  async loadLatestSnapshot(gameId: string): Promise<unknown | null> {
    const snapshots = this.#games.get(gameId)?.snapshots ?? [];
    if (snapshots.length === 0) return null;
    return cloneJson(snapshots.at(-1) ?? null);
  }
  async currentSequence(gameId: string): Promise<number | null> {
    const record = this.#games.get(gameId);
    if (record === undefined) return null;
    return record.events.at(-1)?.sequence ?? 0;
  }

  async atomicAppend(gameId: string, expectedSequence: number, rawEvents: readonly DomainEvent[], rawReceipt: CommandReceipt): Promise<AtomicAppendResult> {
    const receipt = CommandReceiptSchema.parse(cloneJson(rawReceipt));
    const existing = await this.findReceiptByCommandId(receipt.commandId);
    if (existing !== null) {
      if (existing.principalKey === receipt.principalKey && stableStringify(existing.canonicalRequest) === stableStringify(receipt.canonicalRequest)) {
        return { kind: "IDEMPOTENT", receipt: existing };
      }
      throw new CoreError("COMMAND_ID_REUSED", "commandId already exists with different request/principal");
    }

    const current = this.#games.get(gameId);
    const currentEvents = current?.events ?? [];
    const state = replay(currentEvents);
    const validated = validateAppendBatch(gameId, expectedSequence, state, rawEvents, receipt);
    const existingEventIds = new Set<string>();
    for (const game of this.#games.values()) for (const event of game.events) existingEventIds.add(event.eventId);
    if (validated.events.some((event) => existingEventIds.has(event.eventId))) throw new CoreError("INVALID_EVENT_STREAM", "eventId already exists in durable store");
    const next: DurableGameRecord = current ?? { events: [], receipts: [], snapshots: [] };
    next.events = [...cloneJson(currentEvents), ...cloneJson(validated.events)];
    next.receipts = [...cloneJson(next.receipts), cloneJson(receipt)];
    this.#games.set(gameId, next);
    return { kind: "APPENDED", receipt: cloneJson(receipt) };
  }

  async saveSnapshot(rawSnapshot: GameSnapshot): Promise<void> {
    const snapshot = GameSnapshotSchema.parse(cloneJson(rawSnapshot));
    const record = this.#games.get(snapshot.gameId);
    if (record === undefined) throw new CoreError("GAME_NOT_FOUND", "Cannot snapshot missing game");
    const currentSequence = record.events.at(-1)?.sequence ?? 0;
    if (snapshot.sequence > currentSequence) throw new CoreError("INVALID_SNAPSHOT", "Snapshot is ahead of event stream");
    if (!record.receipts.some((receipt) => receipt.lastSequence === snapshot.sequence)) throw new CoreError("INVALID_SNAPSHOT", "Snapshot sequence must be a command transaction boundary");
    record.snapshots = [...record.snapshots.filter((candidate) => {
      const parsed = GameSnapshotSchema.safeParse(candidate);
      return !parsed.success || parsed.data.sequence !== snapshot.sequence;
    }), cloneJson(snapshot)].sort((a, b) => {
      const pa = GameSnapshotSchema.safeParse(a); const pb = GameSnapshotSchema.safeParse(b);
      return (pa.success ? pa.data.sequence : -1) - (pb.success ? pb.data.sequence : -1);
    });
  }

  /** A-05 test hook; simulates lost cache without touching truth. */
  clearSnapshots(gameId: string): void {
    const record = this.#games.get(gameId);
    if (record !== undefined) record.snapshots = [];
  }

  /** A-05 compatibility/corruption test hook; not part of DurableGameStore. */
  mutateEvent(gameId: string, sequence: number, mutate: (event: unknown) => unknown): void {
    const record = this.#games.get(gameId);
    if (record === undefined) throw new Error("Game not found");
    const index = record.events.findIndex((event) => event.sequence === sequence);
    if (index < 0) throw new Error("Event not found");
    record.events[index] = cloneJson(mutate(cloneJson(record.events[index]))) as DomainEvent;
  }

  /** A-05 corruption test hook; not part of DurableGameStore. */
  corruptLatestSnapshot(gameId: string, mutate: (snapshot: unknown) => unknown): void {
    const record = this.#games.get(gameId);
    if (record === undefined || record.snapshots.length === 0) throw new Error("No snapshot to corrupt");
    const index = record.snapshots.length - 1;
    record.snapshots[index] = cloneJson(mutate(cloneJson(record.snapshots[index])));
  }
}
