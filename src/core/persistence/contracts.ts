import type { CommandReceipt, DomainEvent } from "../domain/schemas.js";
import type { GameSnapshot } from "./snapshot.js";

export type AtomicAppendResult =
  | { kind: "APPENDED"; receipt: CommandReceipt }
  | { kind: "IDEMPOTENT"; receipt: CommandReceipt };

/** Durable truth store. Implementations may be PostgreSQL, test memory, or another transactional store. */
export interface DurableGameStore {
  hasGame(gameId: string): Promise<boolean>;
  findReceiptByCommandId(commandId: string): Promise<CommandReceipt | null>;
  loadEvents(gameId: string): Promise<unknown[]>;
  loadEventsAfter(gameId: string, sequenceExclusive: number): Promise<unknown[]>;
  loadReceipts(gameId: string): Promise<CommandReceipt[]>;
  loadLatestSnapshot(gameId: string): Promise<unknown | null>;
  currentSequence(gameId: string): Promise<number | null>;
  atomicAppend(gameId: string, expectedSequence: number, events: readonly DomainEvent[], receipt: CommandReceipt): Promise<AtomicAppendResult>;
  saveSnapshot(snapshot: GameSnapshot): Promise<void>;
}
