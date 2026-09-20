import type { GameRepositoryPort } from "../application/repositoryPort.js";
import { CoreError } from "../domain/errors.js";
import { cloneJson } from "../domain/json.js";
import type { CommandReceipt, DomainEvent, GameState } from "../domain/schemas.js";
import { validateAppendBatch } from "../persistence/appendValidation.js";

export interface PlannedAppend {
  gameId: string;
  expectedSequence: number;
  events: DomainEvent[];
  receipt: CommandReceipt;
  resultingState: GameState;
}

/**
 * One-command repository used by DurableGameService after recovery.
 * It lets the existing synchronous command engine plan/validate a batch without writing durable truth.
 */
export class PlanningGameRepository implements GameRepositoryPort {
  #state: GameState | null;
  readonly #existingReceipt: CommandReceipt | null;
  #planned: PlannedAppend | null = null;

  public constructor(state: GameState | null, existingReceipt: CommandReceipt | null = null) {
    this.#state = state === null ? null : cloneJson(state);
    this.#existingReceipt = existingReceipt === null ? null : cloneJson(existingReceipt);
  }

  hasGame(gameId: string): boolean {
    return this.#state?.gameId === gameId;
  }

  loadState(gameId: string): GameState | null {
    if (this.#state === null || this.#state.gameId !== gameId) return null;
    return cloneJson(this.#state);
  }

  findReceiptByCommandId(commandId: string): CommandReceipt | null {
    if (this.#existingReceipt?.commandId === commandId) return cloneJson(this.#existingReceipt);
    if (this.#planned?.receipt.commandId === commandId) return cloneJson(this.#planned.receipt);
    return null;
  }

  append(gameId: string, expectedSequence: number, events: readonly DomainEvent[], receipt: CommandReceipt): void {
    if (this.#planned !== null) throw new CoreError("PERSISTENCE_ERROR", "Planning repository accepts exactly one append");
    const validated = validateAppendBatch(gameId, expectedSequence, this.#state, events, receipt);
    this.#state = cloneJson(validated.resultingState);
    this.#planned = {
      gameId,
      expectedSequence,
      events: cloneJson(validated.events),
      receipt: cloneJson(validated.receipt),
      resultingState: cloneJson(validated.resultingState),
    };
  }

  takePlannedAppend(): PlannedAppend | null {
    return this.#planned === null ? null : cloneJson(this.#planned);
  }
}
