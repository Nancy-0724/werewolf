import type { PlayerView } from "../../projection/schemas.js";
import { NpcCognitiveStateSchema, type NpcCognitiveState } from "../cognition/schemas.js";
import { buildAdvancedSignals } from "./signals.js";
import { NpcAdvancedReasoningReportSchema, NpcAdvancedReasoningSnapshotSchema, type NpcAdvancedReasoningReport } from "./schemas.js";
import { buildWorldHypotheses } from "./worlds.js";

/**
 * C-03.5 advanced reasoning.
 * It consumes only PlayerView + the NPC's legal cognitive state. The output is hypothesis data, never authoritative identity truth.
 */
export function runAdvancedReasoning(view: PlayerView, stateInput: NpcCognitiveState): { state: NpcCognitiveState; report: NpcAdvancedReasoningReport } {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  if (view.public.gameId !== state.gameId || view.viewer.playerId !== state.npcPlayerId) throw new Error("Advanced reasoning state/view mismatch");
  if (view.identity === null || view.identity.roleId !== state.identityKnowledge.selfRoleId) throw new Error("Advanced reasoning requires matching NPC identity");

  const signals = buildAdvancedSignals(state);
  const worlds = buildWorldHypotheses(view, state, signals.evidence);
  const snapshot = NpcAdvancedReasoningSnapshotSchema.parse({
    contractVersion: "1.0.0",
    basis: {
      publicOrdinal: state.cursor.publicOrdinal,
      privateOrdinal: state.cursor.privateOrdinal,
      claimCount: state.claimLedger.length,
    },
    evidence: signals.evidence,
    temporalTransitions: signals.temporalTransitions,
    topWorlds: worlds.worlds,
    marginals: worlds.marginals,
  });

  const changed = JSON.stringify(snapshot) !== JSON.stringify(state.advancedReasoning);
  const next = NpcCognitiveStateSchema.parse(changed ? { ...state, revision: state.revision + 1, advancedReasoning: snapshot } : state);
  const report = NpcAdvancedReasoningReportSchema.parse({
    contractVersion: "1.0.0",
    gameId: state.gameId,
    npcPlayerId: state.npcPlayerId,
    inputRevision: state.revision,
    stateChanged: changed,
    snapshot,
  });
  return { state: next, report };
}
