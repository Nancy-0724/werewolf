import { randomUUID } from "node:crypto";
import { replay } from "../../core/domain/reducer.js";
import type { Command } from "../../core/domain/schemas.js";
import { projectPlayerView } from "../../projection/playerView.js";
import { WebActionRequestSchema } from "../shared/actionRequest.js";
import { buildPlayerCommand } from "./commandBuilder.js";
import { getWebRuntime } from "./runtime.js";

function hostCommand(gameId: string, commandType: "ResolveNight" | "BeginDay"): Command {
  return { commandId: randomUUID(), gameId, actorPlayerId: null, windowToken: null, commandType, payload: {} };
}

export interface AutoAdvanceResult {
  steps: number;
  stoppedForHuman: boolean;
  terminal: boolean;
  capped: boolean;
}

/**
 * Web Alpha/C-03 deterministic orchestrator.
 * Host automation may inspect truth only for host lifecycle phases; every NPC action is planned from its own PlayerView + persisted cognition.
 */
export async function autoAdvanceUntilHuman(gameId: string, humanPlayerId: string, maxSteps = 160): Promise<AutoAdvanceResult> {
  const runtime = getWebRuntime();
  for (let steps = 0; steps < maxSteps; steps += 1) {
    const events = await runtime.store.loadEvents(gameId);
    const state = replay(events);
    if (state === null || state.status === "ENDED" || state.status === "ABORTED") {
      return { steps, stoppedForHuman: false, terminal: true, capped: false };
    }

    const humanView = projectPlayerView(events, humanPlayerId);
    if (humanView.availableActions.length > 0) return { steps, stoppedForHuman: true, terminal: false, capped: false };

    const phaseType = state.runtime?.phase?.phaseType;
    if (phaseType === "NIGHT_READY_FOR_RESOLUTION") {
      await runtime.gameService.handle({ kind: "HOST", hostId: "web-alpha-host" }, hostCommand(gameId, "ResolveNight"));
      continue;
    }
    if (phaseType === "DAWN_READY_FOR_DAY") {
      await runtime.gameService.handle({ kind: "HOST", hostId: "web-alpha-host" }, hostCommand(gameId, "BeginDay"));
      continue;
    }

    const publicView = humanView.public;
    let npcActed = false;
    for (const seat of [...publicView.seats].sort((a, b) => a.seatNumber - b.seatNumber)) {
      if (seat.controllerType !== "NPC") continue;
      const view = projectPlayerView(events, seat.playerId);
      if (view.availableActions.length === 0) continue;

      // Lazy cognition: synchronize, reason, and plan only for the NPC that currently has a legal action to consider.
      const cognition = await runtime.cognitiveStateService.loadSynchronizeReasonAndStrategize(view);
      const decision = cognition.strategy.decision;
      if (decision === null) continue;
      const request = WebActionRequestSchema.parse(decision.choice);
      const command = buildPlayerCommand(gameId, seat.playerId, view, request, "NPC_TEXT");
      try {
        await runtime.gameService.handle({ kind: "PLAYER", playerId: seat.playerId }, command);
      } catch (error) {
        try { await runtime.cognitiveStateService.markStrategyDecision(gameId, seat.playerId, decision.decisionId, "REJECTED"); } catch { /* cognition history is non-authoritative */ }
        throw error;
      }
      try { await runtime.cognitiveStateService.markStrategyDecision(gameId, seat.playerId, decision.decisionId, "COMMITTED"); } catch { /* Core command already committed; advisory history may recover later. */ }
      npcActed = true;
      break;
    }
    if (npcActed) continue;

    return { steps, stoppedForHuman: false, terminal: false, capped: false };
  }
  return { steps: maxSteps, stoppedForHuman: false, terminal: false, capped: true };
}
