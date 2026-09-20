import { CoreError } from "../domain/errors.js";
import type { GameRepositoryPort } from "../application/repositoryPort.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { replay } from "../domain/reducer.js";
import { CommandReceiptSchema, type CommandReceipt, type DomainEvent, type GameState, parseEvent } from "../domain/schemas.js";

interface StoredGame {
  events: DomainEvent[];
  receipts: CommandReceipt[];
}

export class InMemoryGameRepository implements GameRepositoryPort {
  readonly #games = new Map<string, StoredGame>();

  hasGame(gameId: string): boolean {
    return this.#games.has(gameId);
  }

  loadEvents(gameId: string): DomainEvent[] {
    return cloneJson(this.#games.get(gameId)?.events ?? []);
  }

  loadState(gameId: string): GameState | null {
    return replay(this.loadEvents(gameId));
  }

  loadReceipts(gameId: string): CommandReceipt[] {
    return cloneJson(this.#games.get(gameId)?.receipts ?? []);
  }

  findReceiptByCommandId(commandId: string): CommandReceipt | null {
    for (const game of this.#games.values()) {
      const found = game.receipts.find((receipt) => receipt.commandId === commandId);
      if (found !== undefined) return cloneJson(found);
    }
    return null;
  }

  append(gameId: string, expectedSequence: number, rawEvents: readonly unknown[], rawReceipt: unknown): void {
    const current = this.#games.get(gameId) ?? { events: [], receipts: [] };
    const currentSequence = current.events.at(-1)?.sequence ?? 0;
    if (currentSequence !== expectedSequence) throw new CoreError("CONCURRENCY_CONFLICT", `Expected ${expectedSequence}, current ${currentSequence}`);
    if (rawEvents.length === 0) throw new CoreError("INVALID_EVENT_STREAM", "Append batch must contain an event");

    const events = rawEvents.map(parseEvent);
    const receiptResult = CommandReceiptSchema.safeParse(rawReceipt);
    if (!receiptResult.success) throw new CoreError("INVALID_EVENT_STREAM", receiptResult.error.message);
    const receipt = receiptResult.data;
    if (receipt.gameId !== gameId || receipt.canonicalRequest.gameId !== gameId) throw new CoreError("INVALID_EVENT_STREAM", "Receipt gameId mismatch");
    if (this.findReceiptByCommandId(receipt.commandId) !== null) throw new CoreError("COMMAND_ID_REUSED", "Receipt commandId already exists");

    const nextEvents = [...cloneJson(current.events), ...cloneJson(events)];
    replay(nextEvents);
    const batchFirst = events[0]?.sequence;
    const batchLast = events.at(-1)?.sequence;
    if (batchFirst === undefined || batchLast === undefined || receipt.firstSequence !== batchFirst || receipt.lastSequence !== batchLast) {
      throw new CoreError("INVALID_EVENT_STREAM", "Receipt sequence range does not match batch");
    }
    for (const event of events) {
      if (event.gameId !== gameId || event.causationCommandId !== receipt.commandId) throw new CoreError("INVALID_EVENT_STREAM", "Event/receipt causation mismatch");
    }
    const nextReceipts = [...cloneJson(current.receipts), cloneJson(receipt)];
    this.#games.set(gameId, { events: nextEvents, receipts: nextReceipts });
  }

  importValidatedGame(gameId: string, events: readonly DomainEvent[], receipts: readonly CommandReceipt[]): void {
    if (this.#games.has(gameId)) throw new CoreError("GAME_ALREADY_EXISTS", "Import will not overwrite an existing game");
    const clonedEvents = cloneJson([...events]);
    const clonedReceipts = cloneJson([...receipts]);
    replay(clonedEvents);
    for (const receipt of clonedReceipts) {
      CommandReceiptSchema.parse(receipt);
      if (this.findReceiptByCommandId(receipt.commandId) !== null) throw new CoreError("COMMAND_ID_REUSED", "Imported commandId already exists in repository");
    }
    this.#games.set(gameId, { events: clonedEvents, receipts: clonedReceipts });
  }

  debugSnapshot(gameId: string): { events: DomainEvent[]; receipts: CommandReceipt[] } {
    return { events: this.loadEvents(gameId), receipts: this.loadReceipts(gameId) };
  }

  equals(gameId: string, other: InMemoryGameRepository): boolean {
    return stableStringify(this.debugSnapshot(gameId)) === stableStringify(other.debugSnapshot(gameId));
  }
}
