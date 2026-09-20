import type { NpcBelief, NpcClaim, NpcCognitiveState } from "../cognition/schemas.js";
import type { PlayerActionPrompt, PlayerView } from "../../projection/schemas.js";
import { NpcStrategyDecisionSchema, NpcStrategyResultSchema, type NpcStrategyChoice, type NpcStrategyDecision, type NpcStrategyResult } from "./schemas.js";

const WOLF_ROLES = new Set(["WEREWOLF", "WOLF_BEAUTY"]);
const GOD_ROLES = new Set(["SEER", "WITCH", "HUNTER", "GUARD"]);
const CLAIM_PRIORITY: Readonly<Record<string, number>> = { SEER: 3_000, WITCH: 2_200, GUARD: 1_800, HUNTER: 1_400 };

function beliefMap(state: NpcCognitiveState): Map<string, NpcBelief> {
  return new Map(state.beliefs.map((belief) => [belief.playerId, belief]));
}

function packmateIds(state: NpcCognitiveState): Set<string> {
  if (state.identityKnowledge.selfFactionId !== "WOLF") return new Set();
  return new Set(state.identityKnowledge.exactIdentities.filter((entry) => entry.factionId === "WOLF").map((entry) => entry.playerId));
}

function seatOf(view: PlayerView, playerId: string): number | null {
  return view.public.seats.find((seat) => seat.playerId === playerId)?.seatNumber ?? null;
}

function label(view: PlayerView, playerId: string): string {
  const seat = seatOf(view, playerId);
  return seat === null ? "未知座位" : `${seat}號`;
}

function aliveSet(view: PlayerView): Set<string> {
  return new Set(view.public.seats.filter((seat) => seat.lifeState === "ALIVE").map((seat) => seat.playerId));
}

function claimRoleFor(state: NpcCognitiveState, playerId: string): string | null {
  const roleClaims = state.claimLedger
    .filter((claim) => claim.sourcePlayerId === playerId && claim.claimType === "ROLE_CLAIM" && claim.roleId !== null)
    .sort((a, b) => (b.sourcePublicOrdinal ?? 0) - (a.sourcePublicOrdinal ?? 0));
  return roleClaims[0]?.roleId ?? null;
}

function roleClaimValue(state: NpcCognitiveState, playerId: string): number {
  const roleId = claimRoleFor(state, playerId);
  return roleId === null ? 0 : CLAIM_PRIORITY[roleId] ?? 0;
}

function exactKnownFaction(state: NpcCognitiveState, playerId: string): "WOLF" | "GOOD" | null {
  const exact = state.identityKnowledge.exactIdentities.find((entry) => entry.playerId === playerId);
  if (exact) return exact.factionId;
  return state.beliefs.find((belief) => belief.playerId === playerId)?.knownFaction ?? null;
}

function effectiveWolfLikelihood(state: NpcCognitiveState, playerId: string): number {
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  if (!belief) return 5_000;
  if (belief.knownFaction !== null) return belief.knownFaction === "WOLF" ? 10_000 : 0;
  const world = state.advancedReasoning.marginals.find((entry) => entry.playerId === playerId);
  if (!world) return belief.wolfLikelihoodBps;
  // C-03.5 worlds are soft hypotheses: they can refine, but never dominate, C-02 evidence.
  return Math.round(belief.wolfLikelihoodBps * 0.75 + world.wolfLikelihoodBps * 0.25);
}

function targetScoreGood(state: NpcCognitiveState, playerId: string): number {
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  if (!belief) return 0;
  return effectiveWolfLikelihood(state, playerId) + belief.suspicionScore * 5 - belief.trustScore * 3;
}

function targetScoreTrusted(state: NpcCognitiveState, playerId: string): number {
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  if (!belief) return 0;
  return (10_000 - effectiveWolfLikelihood(state, playerId)) + belief.trustScore * 4 - belief.suspicionScore * 2;
}

function sortByScore(ids: readonly string[], score: (id: string) => number): string[] {
  return [...ids].sort((a, b) => score(b) - score(a) || a.localeCompare(b));
}

function highestSuspect(state: NpcCognitiveState, targets: readonly string[], excluded: ReadonlySet<string> = new Set()): string | null {
  return sortByScore(targets.filter((id) => !excluded.has(id)), (id) => targetScoreGood(state, id))[0] ?? null;
}

function highestTrusted(state: NpcCognitiveState, targets: readonly string[], excluded: ReadonlySet<string> = new Set()): string | null {
  return sortByScore(targets.filter((id) => !excluded.has(id)), (id) => targetScoreTrusted(state, id))[0] ?? null;
}

function knownWolfTarget(state: NpcCognitiveState, targets: readonly string[]): string | null {
  return targets.find((id) => exactKnownFaction(state, id) === "WOLF") ?? null;
}

function claimedSeerCandidates(state: NpcCognitiveState, targets: readonly string[]): string[] {
  return targets.filter((id) => claimRoleFor(state, id) === "SEER");
}

function highValueGoodTarget(state: NpcCognitiveState, view: PlayerView, targets: readonly string[], excluded: ReadonlySet<string>): { playerId: string | null; score: number } {
  const candidates = targets.filter((id) => !excluded.has(id));
  const sorted = sortByScore(candidates, (id) => {
    const belief = state.beliefs.find((entry) => entry.playerId === id);
    const goodConfidence = belief ? 10_000 - belief.wolfLikelihoodBps : 5_000;
    const sheriffBonus = view.public.sheriff.holderPlayerId === id ? 1_800 : 0;
    return goodConfidence + roleClaimValue(state, id) + sheriffBonus + (belief?.trustScore ?? 0) * 2;
  });
  const playerId = sorted[0] ?? null;
  return { playerId, score: playerId === null ? 0 : candidates.includes(playerId) ? (10_000 - (state.beliefs.find((entry) => entry.playerId === playerId)?.wolfLikelihoodBps ?? 5_000)) + roleClaimValue(state, playerId) + (view.public.sheriff.holderPlayerId === playerId ? 1_800 : 0) : 0 };
}

function underPublicPressure(state: NpcCognitiveState): number {
  let pressure = 0;
  for (const claim of state.claimLedger) {
    if (claim.targetPlayerId !== state.npcPlayerId || claim.alignment !== "WOLF") continue;
    pressure += claim.claimType === "CHECK_RESULT" ? 2 : 1;
  }
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC" || memory.observation.type !== "VOTE_RESULT") continue;
    pressure += memory.observation.ballots.filter((ballot) => ballot.targetPlayerId === state.npcPlayerId).length;
  }
  return pressure;
}

function shouldSelfExplode(state: NpcCognitiveState, view: PlayerView): boolean {
  if (!WOLF_ROLES.has(state.identityKnowledge.selfRoleId)) return false;
  const pressure = underPublicPressure(state);
  const personaGate = state.persona.aggression >= 70 && state.persona.riskTolerance >= 60;
  const laterRound = (view.public.stage.round ?? 1) >= 2;
  return personaGate && (pressure >= 2 || (laterRound && pressure >= 1 && state.persona.aggression >= 85));
}

function decisionId(state: NpcCognitiveState, prompt: PlayerActionPrompt): string {
  return [
    "C03",
    state.gameId,
    state.npcPlayerId,
    String(state.publicSnapshot.round ?? 0),
    String(state.cursor.publicOrdinal),
    String(state.cursor.privateOrdinal),
    prompt.commandType,
  ].join(":");
}

function makeDecision(
  state: NpcCognitiveState,
  view: PlayerView,
  prompt: PlayerActionPrompt,
  choice: NpcStrategyChoice,
  targetPlayerId: string | null,
  rationaleCodes: string[],
  utilityScore: number,
): NpcStrategyDecision {
  return NpcStrategyDecisionSchema.parse({
    contractVersion: "1.0.0",
    decisionId: decisionId(state, prompt),
    gameId: state.gameId,
    npcPlayerId: state.npcPlayerId,
    sourceRevision: state.revision,
    roleId: state.identityKnowledge.selfRoleId,
    stage: view.public.stage.kind,
    round: view.public.stage.round,
    choice,
    targetPlayerId,
    rationaleCodes: rationaleCodes.slice(0, 16),
    utilityScore: Math.max(-100_000, Math.min(100_000, Math.round(utilityScore))),
  });
}

function planGuard(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitGuardAction" }>): NpcStrategyDecision {
  const last = view.abilityState.kind === "GUARD" ? view.abilityState.lastTargetPlayerId : null;
  const legal = prompt.legalTargetPlayerIds.filter((id) => id !== last);
  const target = sortByScore(legal, (id) => targetScoreTrusted(state, id) + roleClaimValue(state, id) + (view.public.sheriff.holderPlayerId === id ? 1_200 : 0) - (id === state.npcPlayerId ? 7_000 : 0))[0] ?? null;
  return makeDecision(state, view, prompt, { commandType: "CommitGuardAction", targetPlayerId: target }, target, ["ROLE:GUARD", last ? "NO_CONSECUTIVE_GUARD" : "FIRST_GUARD", target ? "PROTECT_TRUSTED_OR_HIGH_VALUE" : "PASS_NO_TARGET"], target ? targetScoreTrusted(state, target) : 0);
}

function planWolfBallot(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitWolfBallot" }>): NpcStrategyDecision {
  const pack = packmateIds(state);
  const result = highValueGoodTarget(state, view, prompt.legalTargetPlayerIds, pack);
  const target = result.playerId;
  return makeDecision(state, view, prompt, { commandType: "CommitWolfBallot", targetPlayerId: target }, target, ["ROLE:WOLF", "AVOID_KNOWN_PACKMATE", target ? "TARGET_HIGH_VALUE_GOOD" : "PASS_NO_NONPACK_TARGET"], result.score);
}

function planBeauty(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitBeautyAction" }>): NpcStrategyDecision {
  const pack = packmateIds(state);
  const result = highValueGoodTarget(state, view, prompt.legalTargetPlayerIds, pack);
  const current = view.abilityState.kind === "BEAUTY" ? view.abilityState.activeCharmTargetPlayerId : null;
  const currentAlive = current !== null && aliveSet(view).has(current);
  const currentScore = current === null ? -1 : targetScoreTrusted(state, current) + roleClaimValue(state, current) + (view.public.sheriff.holderPlayerId === current ? 1_800 : 0);
  if (currentAlive && prompt.modes.includes("KEEP") && (result.playerId === null || currentScore + 800 >= result.score)) {
    return makeDecision(state, view, prompt, { commandType: "CommitBeautyAction", mode: "KEEP", targetPlayerId: null }, null, ["ROLE:WOLF_BEAUTY", "KEEP_ACTIVE_HIGH_VALUE_CHARM"], currentScore);
  }
  if (result.playerId !== null) return makeDecision(state, view, prompt, { commandType: "CommitBeautyAction", mode: "CHARM", targetPlayerId: result.playerId }, result.playerId, ["ROLE:WOLF_BEAUTY", "CHARM_HIGH_VALUE_GOOD"], result.score);
  return makeDecision(state, view, prompt, { commandType: "CommitBeautyAction", mode: "KEEP", targetPlayerId: null }, null, ["ROLE:WOLF_BEAUTY", "NO_LEGAL_CHARM_TARGET"], 0);
}

function planWitch(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitWitchAction" }>): NpcStrategyDecision {
  const night = view.public.stage.round ?? 1;
  if (prompt.healRemaining === 1 && prompt.healTargetPlayerId !== null) {
    const target = prompt.healTargetPlayerId;
    const known = exactKnownFaction(state, target);
    const belief = state.beliefs.find((entry) => entry.playerId === target);
    const selfHeal = target === state.npcPlayerId && night === 1;
    const safeEnough = known !== "WOLF" && (selfHeal || known === "GOOD" || (belief?.wolfLikelihoodBps ?? 5_000) <= 6_200 || state.persona.riskTolerance <= 45);
    if (safeEnough) return makeDecision(state, view, prompt, { commandType: "CommitWitchAction", action: "HEAL", targetPlayerId: target }, target, ["ROLE:WITCH", selfHeal ? "FIRST_NIGHT_SELF_HEAL" : "HEAL_NONWOLF_KNIFE_TARGET"], 8_000 - (belief?.wolfLikelihoodBps ?? 5_000));
  }
  if (prompt.poisonRemaining === 1) {
    const certainWolf = knownWolfTarget(state, prompt.poisonTargetPlayerIds);
    if (certainWolf !== null) return makeDecision(state, view, prompt, { commandType: "CommitWitchAction", action: "POISON", targetPlayerId: certainWolf }, certainWolf, ["ROLE:WITCH", "POISON_KNOWN_WOLF"], 10_000);
    const suspect = highestSuspect(state, prompt.poisonTargetPlayerIds);
    if (suspect !== null) {
      const belief = state.beliefs.find((entry) => entry.playerId === suspect)!;
      const threshold = 7_600 - state.persona.aggression * 12;
      if (belief.wolfLikelihoodBps >= threshold || belief.suspicionScore >= 500) {
        return makeDecision(state, view, prompt, { commandType: "CommitWitchAction", action: "POISON", targetPlayerId: suspect }, suspect, ["ROLE:WITCH", "POISON_HIGH_CONFIDENCE_SUSPECT"], targetScoreGood(state, suspect));
      }
    }
  }
  return makeDecision(state, view, prompt, { commandType: "CommitWitchAction", action: "PASS", targetPlayerId: null }, null, ["ROLE:WITCH", "CONSERVE_POTION_OR_LOW_CONFIDENCE"], 0);
}

function planSeer(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitSeerAction" }>): NpcStrategyDecision {
  const unknown = prompt.legalTargetPlayerIds.filter((id) => exactKnownFaction(state, id) === null);
  const pool = unknown.length > 0 ? unknown : prompt.legalTargetPlayerIds;
  const target = sortByScore(pool, (id) => targetScoreGood(state, id) + (claimRoleFor(state, id) === "SEER" ? 2_200 : 0) + roleClaimValue(state, id) / 3)[0] ?? null;
  return makeDecision(state, view, prompt, { commandType: "CommitSeerAction", targetPlayerId: target }, target, ["ROLE:SEER", target ? "CHECK_HIGH_INFORMATION_SUSPECT" : "PASS_NO_TARGET"], target ? targetScoreGood(state, target) : 0);
}

function planHunter(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitHunterReaction" }>): NpcStrategyDecision {
  const certainWolf = knownWolfTarget(state, prompt.legalTargetPlayerIds);
  if (certainWolf !== null) return makeDecision(state, view, prompt, { commandType: "CommitHunterReaction", action: "SHOOT", targetPlayerId: certainWolf }, certainWolf, ["ROLE:HUNTER", "SHOOT_KNOWN_WOLF"], 10_000);
  const target = highestSuspect(state, prompt.legalTargetPlayerIds);
  if (target !== null) {
    const belief = state.beliefs.find((entry) => entry.playerId === target)!;
    const threshold = 6_800 - state.persona.aggression * 8;
    if (belief.wolfLikelihoodBps >= threshold || belief.suspicionScore >= 450) return makeDecision(state, view, prompt, { commandType: "CommitHunterReaction", action: "SHOOT", targetPlayerId: target }, target, ["ROLE:HUNTER", "SHOOT_HIGH_CONFIDENCE_SUSPECT"], targetScoreGood(state, target));
  }
  return makeDecision(state, view, prompt, { commandType: "CommitHunterReaction", action: "PASS", targetPlayerId: null }, null, ["ROLE:HUNTER", "PASS_LOW_CONFIDENCE"], 0);
}

function latestPrivateCheck(view: PlayerView): Extract<PlayerView["privateObservations"][number], { type: "SEER_CHECK" }> | null {
  const checks = view.privateObservations.filter((entry): entry is Extract<PlayerView["privateObservations"][number], { type: "SEER_CHECK" }> => entry.type === "SEER_CHECK");
  return checks.at(-1) ?? null;
}

function fakeSeerSpeech(state: NpcCognitiveState, view: PlayerView): string | null {
  if (state.persona.deceptionComfort < 75 || state.persona.assertiveness < 60) return null;
  const pack = packmateIds(state);
  const alive = view.public.seats.filter((seat) => seat.lifeState === "ALIVE" && seat.playerId !== state.npcPlayerId && !pack.has(seat.playerId)).map((seat) => seat.playerId);
  const target = highestSuspect(state, alive) ?? alive[0] ?? null;
  if (target === null) return null;
  return `我是預言家，${label(view, target)}是查殺；今天我會優先投${label(view, target)}。`;
}

function neutralStrategicSpeech(state: NpcCognitiveState, view: PlayerView): string {
  const suspect = state.workingTheory.voteIntentPlayerId ?? state.workingTheory.opposedPlayerId;
  const trusted = state.workingTheory.supportedPlayerId;
  if (state.identityKnowledge.selfRoleId === "SEER") {
    const check = latestPrivateCheck(view);
    if (check) return `我是預言家，${label(view, check.targetPlayerId)}是${check.result === "WOLF" ? "查殺" : "金水"}；今天我會優先看${suspect ? label(view, suspect) : "票型"}。`;
  }
  if (WOLF_ROLES.has(state.identityKnowledge.selfRoleId)) {
    const fake = fakeSeerSpeech(state, view);
    if (fake !== null) return fake;
  }
  if (suspect && trusted && suspect !== trusted) return `目前我比較信${label(view, trusted)}，優先懷疑${label(view, suspect)}，今天票型先往${label(view, suspect)}看。`;
  if (suspect) return `目前我優先懷疑${label(view, suspect)}，今天先看${label(view, suspect)}的發言與票型。`;
  return `${view.viewer.seatNumber}號：目前資訊不足，我先依公開發言與票型保留判斷。`;
}

function planSpeech(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitSpeech" }>): NpcStrategyDecision {
  const text = neutralStrategicSpeech(state, view);
  const target = state.workingTheory.voteIntentPlayerId ?? state.workingTheory.opposedPlayerId;
  const rationale = ["ROLE_STRATEGY_SPEECH", state.identityKnowledge.selfRoleId === "SEER" ? "SEER_REVEAL_LATEST_CHECK" : WOLF_ROLES.has(state.identityKnowledge.selfRoleId) && text.startsWith("我是預言家") ? "WOLF_FAKE_SEER_CLAIM" : "STATE_CURRENT_STANCE"];
  return makeDecision(state, view, prompt, { commandType: "CommitSpeech", mode: "SPEAK", text }, target, rationale, target ? targetScoreGood(state, target) : 0);
}

function planSheriffSignup(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitSheriffSignup" }>): NpcStrategyDecision {
  const role = state.identityKnowledge.selfRoleId;
  let join = false;
  const rationale = ["SHERIFF_SIGNUP"];
  if (role === "SEER") { join = true; rationale.push("SEER_SEEKS_SHERIFF"); }
  else if (WOLF_ROLES.has(role)) { join = state.persona.leadership + state.persona.deceptionComfort >= 130; rationale.push(join ? "WOLF_CONTEST_BADGE" : "WOLF_STAY_OFF_BADGE"); }
  else if (role === "VILLAGER") { join = state.persona.leadership >= 75 && state.persona.assertiveness >= 70 && state.persona.riskTolerance >= 45; rationale.push(join ? "CIVILIAN_LEADERSHIP" : "CIVILIAN_PASS"); }
  else if (GOD_ROLES.has(role)) { join = state.persona.leadership >= 80 && state.persona.riskTolerance >= 55; rationale.push(join ? "GOD_LEADERSHIP" : "GOD_HIDE_ROLE"); }
  return makeDecision(state, view, prompt, { commandType: "CommitSheriffSignup", choice: join ? "JOIN" : "PASS" }, null, rationale, join ? state.persona.leadership * 80 + state.persona.assertiveness * 20 : 0);
}

function planSheriffWithdrawal(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitSheriffWithdrawal" }>): NpcStrategyDecision {
  const role = state.identityKnowledge.selfRoleId;
  let stay = role === "SEER";
  if (WOLF_ROLES.has(role)) stay = state.persona.deceptionComfort >= 65 && state.persona.assertiveness >= 55;
  else if (role !== "SEER") stay = state.persona.leadership >= 72 && state.persona.assertiveness >= 62;
  return makeDecision(state, view, prompt, { commandType: "CommitSheriffWithdrawal", choice: stay ? "STAY" : "WITHDRAW" }, null, ["SHERIFF_WITHDRAWAL", stay ? "KEEP_CANDIDACY" : "REDUCE_EXPOSURE"], stay ? state.persona.leadership * 100 : 0);
}

function planBallot(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitBallot" }>): NpcStrategyDecision {
  const pack = packmateIds(state);
  let target: string | null = null;
  const rationale = [`BALLOT:${prompt.voteKind}`];
  if (prompt.voteKind === "SHERIFF" || prompt.voteKind === "SHERIFF_PK") {
    if (state.identityKnowledge.selfFactionId === "WOLF") {
      target = prompt.legalTargetPlayerIds.find((id) => pack.has(id)) ?? null;
      if (target) rationale.push("SUPPORT_PACKMATE_SHERIFF");
    }
    if (target === null) {
      const seerCandidates = claimedSeerCandidates(state, prompt.legalTargetPlayerIds);
      target = highestTrusted(state, seerCandidates.length > 0 ? seerCandidates : prompt.legalTargetPlayerIds);
      rationale.push(seerCandidates.length > 0 ? "PREFER_CREDIBLE_SEER_CANDIDATE" : "PREFER_TRUSTED_CANDIDATE");
    }
  } else {
    const legal = state.identityKnowledge.selfFactionId === "WOLF" ? prompt.legalTargetPlayerIds.filter((id) => !pack.has(id)) : prompt.legalTargetPlayerIds;
    target = highestSuspect(state, legal);
    rationale.push(state.identityKnowledge.selfFactionId === "WOLF" ? "BLEND_WITH_NONPACK_VOTE" : "VOTE_TOP_SUSPECT");
  }
  return makeDecision(state, view, prompt, { commandType: "CommitBallot", targetPlayerId: target }, target, [...rationale, target ? "TARGET_SELECTED" : "ABSTAIN_NO_TARGET"], target ? targetScoreGood(state, target) : 0);
}

function planSpeechOrder(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "ChooseDaySpeechOrder" }>): NpcStrategyDecision {
  const target = highestSuspect(state, prompt.legalFirstSpeakerPlayerIds) ?? prompt.legalFirstSpeakerPlayerIds[0] ?? null;
  if (target === null) throw new Error("ChooseDaySpeechOrder prompt has no legal first speaker");
  const direction = state.persona.assertiveness >= 50 ? "ASC" as const : "DESC" as const;
  return makeDecision(state, view, prompt, { commandType: "ChooseDaySpeechOrder", firstSpeakerPlayerId: target, direction }, target, ["SHERIFF_ORDER", "START_NEAR_TOP_SUSPECT", `DIRECTION:${direction}`], targetScoreGood(state, target));
}

function planBadge(state: NpcCognitiveState, view: PlayerView, prompt: Extract<PlayerActionPrompt, { commandType: "CommitSheriffBadgeAction" }>): NpcStrategyDecision {
  const pack = packmateIds(state);
  if (state.identityKnowledge.selfFactionId === "WOLF") {
    const packTarget = prompt.transferTargetPlayerIds.find((id) => pack.has(id));
    if (packTarget) return makeDecision(state, view, prompt, { commandType: "CommitSheriffBadgeAction", action: "TRANSFER", targetPlayerId: packTarget }, packTarget, ["ROLE:WOLF", "TRANSFER_BADGE_TO_PACKMATE"], 9_000);
  }
  const target = highestTrusted(state, prompt.transferTargetPlayerIds, state.identityKnowledge.selfFactionId === "GOOD" ? new Set([...pack].filter((id) => exactKnownFaction(state, id) === "WOLF")) : new Set());
  if (target !== null) return makeDecision(state, view, prompt, { commandType: "CommitSheriffBadgeAction", action: "TRANSFER", targetPlayerId: target }, target, ["TRANSFER_BADGE_TO_TRUSTED"], targetScoreTrusted(state, target));
  return makeDecision(state, view, prompt, { commandType: "CommitSheriffBadgeAction", action: "DESTROY", targetPlayerId: null }, null, ["DESTROY_BADGE_NO_SUITABLE_TARGET"], 0);
}

function planPrompt(state: NpcCognitiveState, view: PlayerView, prompt: PlayerActionPrompt): NpcStrategyDecision | null {
  switch (prompt.commandType) {
    case "CommitGuardAction": return planGuard(state, view, prompt);
    case "CommitWolfBallot": return planWolfBallot(state, view, prompt);
    case "CommitBeautyAction": return planBeauty(state, view, prompt);
    case "CommitWitchAction": return planWitch(state, view, prompt);
    case "CommitSeerAction": return planSeer(state, view, prompt);
    case "CommitHunterReaction": return planHunter(state, view, prompt);
    case "CommitSpeech": return planSpeech(state, view, prompt);
    case "CommitSheriffSignup": return planSheriffSignup(state, view, prompt);
    case "CommitSheriffWithdrawal": return planSheriffWithdrawal(state, view, prompt);
    case "CommitBallot": return planBallot(state, view, prompt);
    case "ChooseDaySpeechOrder": return planSpeechOrder(state, view, prompt);
    case "CommitSelfExplosion": return shouldSelfExplode(state, view) ? makeDecision(state, view, prompt, { commandType: "CommitSelfExplosion" }, null, ["ROLE:WOLF", "SELF_EXPLODE_UNDER_PRESSURE"], underPublicPressure(state) * 2_500) : null;
    case "CommitSheriffBadgeAction": return planBadge(state, view, prompt);
  }
}

const PRIORITY: Readonly<Record<PlayerActionPrompt["commandType"], number>> = {
  CommitHunterReaction: 100,
  CommitWitchAction: 95,
  CommitSeerAction: 94,
  CommitGuardAction: 93,
  CommitWolfBallot: 92,
  CommitBeautyAction: 91,
  CommitSheriffBadgeAction: 90,
  CommitSelfExplosion: 85,
  CommitSpeech: 80,
  CommitSheriffSignup: 75,
  CommitSheriffWithdrawal: 74,
  CommitBallot: 70,
  ChooseDaySpeechOrder: 65,
};

/** Deterministic, zero-network role strategy. It never accepts raw GameState or SYSTEM_TRUTH. */
export function planNpcStrategy(view: PlayerView, state: NpcCognitiveState): NpcStrategyResult {
  if (view.public.gameId !== state.gameId || view.viewer.playerId !== state.npcPlayerId) throw new Error("NPC strategy state/view mismatch");
  if (view.identity === null || view.identity.roleId !== state.identityKnowledge.selfRoleId) throw new Error("NPC strategy requires matching locked identity");
  const prompts = [...view.availableActions].sort((a, b) => PRIORITY[b.commandType] - PRIORITY[a.commandType] || a.commandType.localeCompare(b.commandType));
  const considered = prompts.map((prompt) => prompt.commandType);

  // Speech and self-explosion may coexist. Evaluate explosion first, but fall back to speech when pressure is insufficient.
  for (const prompt of prompts) {
    const decision = planPrompt(state, view, prompt);
    if (decision !== null) return NpcStrategyResultSchema.parse({ decision, consideredCommandTypes: considered });
  }
  return NpcStrategyResultSchema.parse({ decision: null, consideredCommandTypes: considered });
}

export function strategyDecisionKind(decision: NpcStrategyDecision): "SPEECH" | "VOTE" | "ABILITY" | "SHERIFF" | "BADGE" | "SELF_EXPLOSION" | "OTHER" {
  switch (decision.choice.commandType) {
    case "CommitSpeech": return "SPEECH";
    case "CommitBallot": return "VOTE";
    case "CommitGuardAction":
    case "CommitWolfBallot":
    case "CommitBeautyAction":
    case "CommitWitchAction":
    case "CommitSeerAction":
    case "CommitHunterReaction": return "ABILITY";
    case "CommitSheriffSignup":
    case "CommitSheriffWithdrawal":
    case "ChooseDaySpeechOrder": return "SHERIFF";
    case "CommitSheriffBadgeAction": return "BADGE";
    case "CommitSelfExplosion": return "SELF_EXPLOSION";
  }
}

export function strategyActionCode(decision: NpcStrategyDecision): string {
  const choice = decision.choice;
  switch (choice.commandType) {
    case "CommitBeautyAction": return `${choice.commandType}:${choice.mode}`;
    case "CommitWitchAction": return `${choice.commandType}:${choice.action}`;
    case "CommitHunterReaction": return `${choice.commandType}:${choice.action}`;
    case "CommitSpeech": return `${choice.commandType}:${choice.mode}`;
    case "CommitSheriffSignup": return `${choice.commandType}:${choice.choice}`;
    case "CommitSheriffWithdrawal": return `${choice.commandType}:${choice.choice}`;
    case "CommitSheriffBadgeAction": return `${choice.commandType}:${choice.action}`;
    default: return choice.commandType;
  }
}
