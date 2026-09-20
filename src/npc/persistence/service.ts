import type { PlayerView } from "../../projection/schemas.js";
import { initializeNpcCognitiveState, recordNpcDecision, synchronizeNpcCognitiveState, updateNpcDecisionStatus } from "../cognition/state.js";
import type { NpcCognitiveState } from "../cognition/schemas.js";
import { runHeuristicReasoning } from "../reasoning/heuristics.js";
import { runAdvancedReasoning } from "../advanced/engine.js";
import type { NpcAdvancedReasoningReport } from "../advanced/schemas.js";
import type { NpcHeuristicReasoningReport } from "../reasoning/schemas.js";
import { planNpcStrategy, strategyActionCode, strategyDecisionKind } from "../strategy/engine.js";
import type { NpcStrategyResult } from "../strategy/schemas.js";
import type { NpcCognitiveStore } from "./contracts.js";

/** Durable cognition coordinator. It accepts PlayerView only; SYSTEM_TRUTH is intentionally absent from this API. */
export class NpcCognitiveStateService {
  readonly #store: NpcCognitiveStore;
  public constructor(store: NpcCognitiveStore) { this.#store = store; }

  public async loadOrInitialize(view: PlayerView): Promise<NpcCognitiveState> {
    const current = await this.#store.load(view.public.gameId, view.viewer.playerId);
    if (current === null) {
      const initialized = initializeNpcCognitiveState(view);
      await this.#store.save(initialized, null);
      return initialized;
    }
    const synchronized = synchronizeNpcCognitiveState(current, view);
    if (synchronized.revision !== current.revision) await this.#store.save(synchronized, current.revision);
    return synchronized;
  }

  /** C-02: synchronize legal observations, then recompute deterministic heuristic beliefs. */
  public async loadSynchronizeAndReason(view: PlayerView): Promise<{ state: NpcCognitiveState; report: NpcHeuristicReasoningReport }> {
    const synchronized = await this.loadOrInitialize(view);
    const reasoned = runHeuristicReasoning(synchronized);
    if (reasoned.state.revision !== synchronized.revision) await this.#store.save(reasoned.state, synchronized.revision);
    return reasoned;
  }

  /** C-03.5: add five-layer soft evidence + constrained world hypotheses without mutating SYSTEM_TRUTH. */
  public async loadSynchronizeReasonAndAdvance(view: PlayerView): Promise<{ state: NpcCognitiveState; report: NpcHeuristicReasoningReport; advancedReport: NpcAdvancedReasoningReport }> {
    const reasoned = await this.loadSynchronizeAndReason(view);
    const advanced = runAdvancedReasoning(view, reasoned.state);
    if (advanced.state.revision !== reasoned.state.revision) await this.#store.save(advanced.state, reasoned.state.revision);
    return { state: advanced.state, report: reasoned.report, advancedReport: advanced.report };
  }

  /** C-03: turn beliefs and C-03.5 world hypotheses into a role-aware action plan. No capability token is persisted in cognition. */
  public async loadSynchronizeReasonAndStrategize(view: PlayerView): Promise<{ state: NpcCognitiveState; report: NpcHeuristicReasoningReport; advancedReport: NpcAdvancedReasoningReport; strategy: NpcStrategyResult }> {
    const reasoned = await this.loadSynchronizeReasonAndAdvance(view);
    const strategy = planNpcStrategy(view, reasoned.state);
    const decision = strategy.decision;
    if (decision === null) return { ...reasoned, strategy };

    let planned = recordNpcDecision(reasoned.state, {
      decisionId: decision.decisionId,
      round: decision.round,
      stage: decision.stage,
      decisionKind: strategyDecisionKind(decision),
      actionCode: strategyActionCode(decision),
      targetPlayerId: decision.targetPlayerId,
      rationaleCodes: decision.rationaleCodes,
      status: "PLANNED",
    });
    if (planned.revision !== reasoned.state.revision) await this.#store.save(planned, reasoned.state.revision);
    return { state: planned, report: reasoned.report, advancedReport: reasoned.advancedReport, strategy };
  }

  public async markStrategyDecision(gameId: string, npcPlayerId: string, decisionId: string, status: "COMMITTED" | "REJECTED"): Promise<NpcCognitiveState | null> {
    const current = await this.#store.load(gameId, npcPlayerId);
    if (current === null) return null;
    const next = updateNpcDecisionStatus(current, decisionId, status);
    if (next.revision !== current.revision) await this.#store.save(next, current.revision);
    return next;
  }
}
