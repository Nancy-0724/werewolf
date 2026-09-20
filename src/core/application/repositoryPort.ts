import type { CommandReceipt, DomainEvent, GameState } from "../domain/schemas.js";

/** Synchronous command-side repository used by the deterministic core planner. */
export interface GameRepositoryPort {
  hasGame(gameId: string): boolean;
  loadState(gameId: string): GameState | null;
  findReceiptByCommandId(commandId: string): CommandReceipt | null;
  append(gameId: string, expectedSequence: number, events: readonly DomainEvent[], receipt: CommandReceipt): void;
}
