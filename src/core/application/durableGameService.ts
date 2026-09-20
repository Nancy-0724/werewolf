import { GameService, type GameServiceDependencies } from "./gameService.js";
import type { ClockPort, IdPort, RandomPort } from "./ports.js";
import { CoreError } from "../domain/errors.js";
import { cloneJson } from "../domain/json.js";
import { parseCommand, type CommandReceipt, type GameState } from "../domain/schemas.js";
import { PlanningGameRepository } from "../infrastructure/planningRepository.js";
import type { DurableGameStore } from "../persistence/contracts.js";
import { recoverGame, type RecoveryResult } from "../persistence/recovery.js";
import { createGameSnapshot, parseAndVerifySnapshot } from "../persistence/snapshot.js";

export interface DurableGameServiceDependencies {
  store: DurableGameStore;
  random: RandomPort;
  clock: ClockPort;
  ids: IdPort;
  engineBuildId: string;
  snapshotEveryEvents?: number | undefined;
  onSnapshotError?: ((error: unknown) => void) | undefined;
}

export class DurableGameService {
  readonly #deps: DurableGameServiceDependencies;

  public constructor(deps: DurableGameServiceDependencies) {
    this.#deps = deps;
    if (deps.snapshotEveryEvents !== undefined && (!Number.isInteger(deps.snapshotEveryEvents) || deps.snapshotEveryEvents < 0)) {
      throw new CoreError("INVALID_INPUT", "snapshotEveryEvents must be a non-negative integer");
    }
  }

  async recover(gameId: string): Promise<RecoveryResult> {
    return recoverGame(this.#deps.store, gameId);
  }

  async handle(rawPrincipal: unknown, rawCommand: unknown): Promise<CommandReceipt> {
    const commandForLookup = parseCommand(rawCommand);
    const existingReceipt = await this.#deps.store.findReceiptByCommandId(commandForLookup.commandId);

    if (existingReceipt !== null) {
      const repository = new PlanningGameRepository(null, existingReceipt);
      const service = this.#createCoreService(repository);
      return service.handle(rawPrincipal, rawCommand);
    }

    const recovered = await recoverGame(this.#deps.store, commandForLookup.gameId);
    const repository = new PlanningGameRepository(recovered.state);
    const service = this.#createCoreService(repository);
    service.handle(rawPrincipal, rawCommand);
    const planned = repository.takePlannedAppend();
    if (planned === null) throw new CoreError("PERSISTENCE_ERROR", "Successful command produced no durable append plan");

    const appendResult = await this.#deps.store.atomicAppend(planned.gameId, planned.expectedSequence, planned.events, planned.receipt);
    if (appendResult.kind === "APPENDED") await this.#maybeCheckpoint(planned.resultingState);
    return cloneJson(appendResult.receipt);
  }

  async checkpoint(gameId: string): Promise<void> {
    const recovered = await recoverGame(this.#deps.store, gameId);
    if (recovered.state === null) throw new CoreError("GAME_NOT_FOUND", "Cannot checkpoint missing game");
    const receipts = await this.#deps.store.loadReceipts(gameId);
    if (!receipts.some((receipt) => receipt.lastSequence === recovered.state?.lastSequence)) {
      throw new CoreError("INVALID_SNAPSHOT", "Snapshot can only be created at a completed command transaction boundary");
    }
    await this.#deps.store.saveSnapshot(createGameSnapshot(recovered.state, this.#deps.engineBuildId, this.#deps.clock));
  }

  #createCoreService(repository: PlanningGameRepository): GameService {
    const deps: GameServiceDependencies = {
      repository,
      random: this.#deps.random,
      clock: this.#deps.clock,
      ids: this.#deps.ids,
      engineBuildId: this.#deps.engineBuildId,
    };
    return new GameService(deps);
  }

  async #maybeCheckpoint(state: GameState): Promise<void> {
    const interval = this.#deps.snapshotEveryEvents ?? 50;
    const terminalOrLocked = state.status === "LOCKED" || state.status === "ENDED" || state.status === "ABORTED";
    if (interval === 0 && !terminalOrLocked) return;

    let lastSnapshotSequence = 0;
    try {
      const raw = await this.#deps.store.loadLatestSnapshot(state.gameId);
      if (raw !== null) lastSnapshotSequence = parseAndVerifySnapshot(raw).sequence;
    } catch {
      lastSnapshotSequence = 0;
    }
    if (!terminalOrLocked && state.lastSequence - lastSnapshotSequence < interval) return;

    try {
      await this.#deps.store.saveSnapshot(createGameSnapshot(state, this.#deps.engineBuildId, this.#deps.clock));
    } catch (error) {
      this.#deps.onSnapshotError?.(error);
    }
  }
}
