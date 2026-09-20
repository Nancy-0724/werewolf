import { CoreError } from "../domain/errors.js";
import { replay, replayFromState } from "../domain/reducer.js";
import { GameStateSchema, type GameState } from "../domain/schemas.js";
import { assertRulesetRegistryCompatible } from "../rulesets/registry.js";
import { assertSupportedRuleset } from "../rulesets/wb12.js";
import type { DurableGameStore } from "./contracts.js";
import { parseAndVerifySnapshot, type GameSnapshot } from "./snapshot.js";


function assertRawEventCompatibility(rawEvents: readonly unknown[]): void {
  for (const raw of rawEvents) {
    if (raw === null || typeof raw !== "object") continue;
    const event = raw as Record<string, unknown>;
    if ("eventVersion" in event && event.eventVersion !== "1.0.0") throw new CoreError("UNSUPPORTED_ENGINE_VERSION", `Unsupported event version ${String(event.eventVersion)}`);
    const payload = event.payload;
    if (event.eventType === "GameCreated" && payload !== null && typeof payload === "object") {
      const rulesetDraft = (payload as Record<string, unknown>).rulesetDraft;
      if (rulesetDraft !== null && typeof rulesetDraft === "object" && (rulesetDraft as Record<string, unknown>).engineContractVersion !== "1.0.0") {
        throw new CoreError("UNSUPPORTED_ENGINE_VERSION", "GameCreated ruleset uses an unsupported engine contract");
      }
    }
    if (event.eventType === "SetupLocked" && payload !== null && typeof payload === "object") {
      const manifest = (payload as Record<string, unknown>).manifest;
      if (manifest !== null && typeof manifest === "object") {
        const value = manifest as Record<string, unknown>;
        if (value.dataSchemaVersion !== "1.0.0" || value.engineContractVersion !== "1.0.0") throw new CoreError("UNSUPPORTED_ENGINE_VERSION", "Locked manifest uses an unsupported schema/engine contract");
      }
    }
  }
}

export interface RecoveryResult {
  state: GameState | null;
  source: "EMPTY" | "SNAPSHOT" | "FULL_REPLAY";
  snapshot: GameSnapshot | null;
  discardedSnapshotReason: string | null;
}

export type ContinuationCompatibility =
  | { mode: "CONTINUABLE"; reason: null }
  | { mode: "HISTORY_ONLY"; reason: string };

function assertCurrentRulesCompatible(state: GameState): void {
  const parsed = GameStateSchema.parse(state);
  if (parsed.manifest !== null) {
    if (parsed.manifest.dataSchemaVersion !== "1.0.0" || parsed.manifest.engineContractVersion !== "1.0.0") {
      throw new CoreError("UNSUPPORTED_ENGINE_VERSION", "Game manifest uses an unsupported schema/engine contract");
    }
    const ruleset = assertSupportedRuleset(parsed.manifest.rulesetSnapshot);
    assertRulesetRegistryCompatible(ruleset);
    return;
  }
  if (parsed.lobby !== null) {
    const ruleset = assertSupportedRuleset(parsed.lobby.rulesetDraft);
    assertRulesetRegistryCompatible(ruleset);
  }
}

function normalizeContinuationError(error: unknown): never {
  if (error instanceof CoreError) {
    if (error.code === "UNSUPPORTED_EVENT_VERSION" || error.code === "UNSUPPORTED_RULESET") {
      throw new CoreError("UNSUPPORTED_ENGINE_VERSION", error.message);
    }
    throw error;
  }
  throw error;
}

function replayAll(rawEvents: readonly unknown[]): GameState | null {
  try {
    assertRawEventCompatibility(rawEvents);
    const state = replay(rawEvents);
    if (state !== null) assertCurrentRulesCompatible(state);
    return state;
  } catch (error) {
    normalizeContinuationError(error);
  }
}

export async function recoverGame(store: DurableGameStore, gameId: string): Promise<RecoveryResult> {
  const gameExists = await store.hasGame(gameId);
  if (!gameExists) return { state: null, source: "EMPTY", snapshot: null, discardedSnapshotReason: null };

  const rawSnapshot = await store.loadLatestSnapshot(gameId);
  let discardedSnapshotReason: string | null = null;
  if (rawSnapshot !== null) {
    try {
      const snapshot = parseAndVerifySnapshot(rawSnapshot);
      if (snapshot.gameId !== gameId) throw new CoreError("INVALID_SNAPSHOT", "Snapshot belongs to a different game");
      assertCurrentRulesCompatible(snapshot.state);
      const currentSequence = await store.currentSequence(gameId);
      if (currentSequence === null || snapshot.sequence > currentSequence) throw new CoreError("INVALID_SNAPSHOT", "Snapshot is ahead of durable event stream");
      const tail = await store.loadEventsAfter(gameId, snapshot.sequence);
      try {
        assertRawEventCompatibility(tail);
        const state = replayFromState(snapshot.state, tail);
        if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Snapshot recovery unexpectedly produced an empty game");
        assertCurrentRulesCompatible(state);
        return { state, source: "SNAPSHOT", snapshot, discardedSnapshotReason: null };
      } catch (error) {
        if (error instanceof CoreError && error.code === "UNSUPPORTED_EVENT_VERSION") normalizeContinuationError(error);
        discardedSnapshotReason = error instanceof Error ? `Snapshot/tail replay rejected: ${error.message}` : "Snapshot/tail replay rejected";
      }
    } catch (error) {
      if (error instanceof CoreError && error.code === "UNSUPPORTED_ENGINE_VERSION") throw error;
      discardedSnapshotReason = error instanceof Error ? error.message : "Snapshot validation failed";
    }
  }

  const allEvents = await store.loadEvents(gameId);
  if (allEvents.length === 0) throw new CoreError("PERSISTENCE_ERROR", "Durable game row exists without an event stream");
  const state = replayAll(allEvents);
  return { state, source: "FULL_REPLAY", snapshot: null, discardedSnapshotReason };
}

export async function assessContinuationCompatibility(store: DurableGameStore, gameId: string): Promise<ContinuationCompatibility> {
  try {
    const recovered = await recoverGame(store, gameId);
    if (recovered.state === null) return { mode: "HISTORY_ONLY", reason: "Game does not exist" };
    return { mode: "CONTINUABLE", reason: null };
  } catch (error) {
    if (error instanceof CoreError && (error.code === "UNSUPPORTED_ENGINE_VERSION" || error.code === "UNSUPPORTED_EVENT_VERSION" || error.code === "UNSUPPORTED_RULESET")) {
      return { mode: "HISTORY_ONLY", reason: error.message };
    }
    throw error;
  }
}
