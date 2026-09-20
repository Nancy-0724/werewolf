import { cloneJson } from "../../core/domain/json.js";
import { NpcCognitiveStateSchema, parseNpcCognitiveState, type NpcCognitiveState } from "../cognition/schemas.js";
import { NpcCognitiveConcurrencyError, type NpcCognitiveStore } from "./contracts.js";

function key(gameId: string, npcPlayerId: string): string { return `${gameId}\u0000${npcPlayerId}`; }

export class InMemoryNpcCognitiveStore implements NpcCognitiveStore {
  readonly #states = new Map<string, NpcCognitiveState>();

  public async load(gameId: string, npcPlayerId: string): Promise<NpcCognitiveState | null> {
    const state = this.#states.get(key(gameId, npcPlayerId));
    return state === undefined ? null : parseNpcCognitiveState(cloneJson(state));
  }

  public async save(stateInput: NpcCognitiveState, expectedRevision: number | null): Promise<void> {
    const state = NpcCognitiveStateSchema.parse(stateInput);
    const stateKey = key(state.gameId, state.npcPlayerId);
    const current = this.#states.get(stateKey);
    if (current === undefined) {
      if (expectedRevision !== null) throw new NpcCognitiveConcurrencyError(`Expected existing revision ${expectedRevision}, but cognitive state does not exist`);
    } else if (expectedRevision === null || current.revision !== expectedRevision) {
      throw new NpcCognitiveConcurrencyError(`Expected revision ${String(expectedRevision)}, actual revision ${current.revision}`);
    }
    this.#states.set(stateKey, parseNpcCognitiveState(cloneJson(state)));
  }

  public async deleteGame(gameId: string): Promise<void> {
    for (const [stateKey, state] of this.#states) if (state.gameId === gameId) this.#states.delete(stateKey);
  }
}
