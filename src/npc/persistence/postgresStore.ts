import type { PgDatabasePort } from "../../core/infrastructure/postgresPort.js";
import { NpcCognitiveStateSchema, parseNpcCognitiveState, type NpcCognitiveState } from "../cognition/schemas.js";
import { NpcCognitiveConcurrencyError, type NpcCognitiveStore } from "./contracts.js";

interface CognitiveRow extends Record<string, unknown> {
  state_json: unknown;
  revision: number | string;
}

function integerRevision(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("Invalid NPC cognitive revision in database");
  return parsed;
}

export class PostgresNpcCognitiveStore implements NpcCognitiveStore {
  readonly #db: PgDatabasePort;
  public constructor(db: PgDatabasePort) { this.#db = db; }

  public async load(gameId: string, npcPlayerId: string): Promise<NpcCognitiveState | null> {
    const result = await this.#db.query<CognitiveRow>(
      "select revision, state_json from werewolf_npc_cognitive_states where game_id = $1 and player_id = $2",
      [gameId, npcPlayerId],
    );
    const row = result.rows[0];
    if (row === undefined) return null;
    const state = parseNpcCognitiveState(row.state_json);
    if (state.revision !== integerRevision(row.revision)) throw new Error("NPC cognitive state JSON revision does not match row revision");
    return state;
  }

  public async save(stateInput: NpcCognitiveState, expectedRevision: number | null): Promise<void> {
    const state = NpcCognitiveStateSchema.parse(stateInput);
    await this.#db.transaction(async (session) => {
      const current = await session.query<CognitiveRow>(
        "select revision, state_json from werewolf_npc_cognitive_states where game_id = $1 and player_id = $2 for update",
        [state.gameId, state.npcPlayerId],
      );
      const row = current.rows[0];
      if (row === undefined) {
        if (expectedRevision !== null) throw new NpcCognitiveConcurrencyError(`Expected existing revision ${expectedRevision}, but cognitive state does not exist`);
        await session.query(
          "insert into werewolf_npc_cognitive_states (game_id, player_id, contract_version, revision, state_json) values ($1, $2, $3, $4, $5::jsonb)",
          [state.gameId, state.npcPlayerId, state.contractVersion, state.revision, JSON.stringify(state)],
        );
        return;
      }
      const actualRevision = integerRevision(row.revision);
      if (expectedRevision === null || actualRevision !== expectedRevision) throw new NpcCognitiveConcurrencyError(`Expected revision ${String(expectedRevision)}, actual revision ${actualRevision}`);
      await session.query(
        "update werewolf_npc_cognitive_states set contract_version = $3, revision = $4, state_json = $5::jsonb, updated_at = now() where game_id = $1 and player_id = $2",
        [state.gameId, state.npcPlayerId, state.contractVersion, state.revision, JSON.stringify(state)],
      );
    });
  }

  public async deleteGame(gameId: string): Promise<void> {
    await this.#db.query("delete from werewolf_npc_cognitive_states where game_id = $1", [gameId]);
  }
}
