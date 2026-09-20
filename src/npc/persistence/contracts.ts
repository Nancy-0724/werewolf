import type { NpcCognitiveState } from "../cognition/schemas.js";

export interface NpcCognitiveStore {
  load(gameId: string, npcPlayerId: string): Promise<NpcCognitiveState | null>;
  /** First insert uses expectedRevision=null. Updates must match the currently persisted revision. */
  save(state: NpcCognitiveState, expectedRevision: number | null): Promise<void>;
  deleteGame(gameId: string): Promise<void>;
}

export class NpcCognitiveConcurrencyError extends Error {
  public constructor(message = "NPC cognitive state revision conflict") { super(message); this.name = "NpcCognitiveConcurrencyError"; }
}
