import { cloneJson } from "../../core/domain/json.js";
import { NpcCognitiveStateSchema, type NpcBelief, type NpcClaim, type NpcCognitiveState } from "../cognition/schemas.js";
import { extractClaimsFromSpeechMemory } from "./claims.js";
import { NpcHeuristicReasoningReportSchema, type NpcHeuristicReasoningReport, type NpcReasoningEvidence } from "./schemas.js";

type MutableScore = { wolfDelta: number; trustDelta: number; suspicionDelta: number; evidenceMemoryIds: Set<string> };

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));
const alivePlayerIds = (state: NpcCognitiveState): Set<string> => new Set(state.publicSnapshot.seats.filter((seat) => seat.lifeState === "ALIVE").map((seat) => seat.playerId));
const memoryIdForOrdinal = (ordinal: number | null): string[] => ordinal === null ? [] : [`PUBLIC:${ordinal}`];

function personaScale(base: number, trait: number): number {
  return Math.round(base * (0.75 + trait / 200));
}

function exactKnown(state: NpcCognitiveState, playerId: string): { factionId: "WOLF" | "GOOD"; roleId: string | null } | null {
  const exact = state.identityKnowledge.exactIdentities.find((entry) => entry.playerId === playerId);
  if (exact) return { factionId: exact.factionId, roleId: exact.roleId };
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  if (belief?.knownFaction) return { factionId: belief.knownFaction, roleId: belief.knownRoleId };
  return null;
}

function initialScores(state: NpcCognitiveState): Map<string, MutableScore> {
  return new Map(state.publicSnapshot.seats.map((seat) => [seat.playerId, { wolfDelta: 0, trustDelta: 0, suspicionDelta: 0, evidenceMemoryIds: new Set<string>() }]));
}

function addEvidence(
  evidence: NpcReasoningEvidence[], scores: Map<string, MutableScore>,
  input: Omit<NpcReasoningEvidence, "evidenceId"> & { evidenceId?: string },
): void {
  const score = scores.get(input.subjectPlayerId);
  if (!score) return;
  score.wolfDelta += input.wolfLikelihoodDeltaBps;
  score.trustDelta += input.trustDelta;
  score.suspicionDelta += input.suspicionDelta;
  for (const id of input.memoryIds) score.evidenceMemoryIds.add(id);
  const { evidenceId, ...rest } = input;
  evidence.push({ evidenceId: evidenceId ?? `E:${evidence.length + 1}`, ...rest });
}

function applyPublicProofs(state: NpcCognitiveState, scores: Map<string, MutableScore>, evidence: NpcReasoningEvidence[], publicKnown: Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string }>): void {
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC") continue;
    const observation = memory.observation;
    if (observation.type === "SELF_EXPLOSION") {
      publicKnown.set(observation.playerId, { factionId: "WOLF", roleId: null, memoryId: memory.memoryId });
      addEvidence(evidence, scores, { code: "PUBLIC_SELF_EXPLOSION", subjectPlayerId: observation.playerId, sourcePlayerId: observation.playerId, memoryIds: [memory.memoryId], wolfLikelihoodDeltaBps: 10_000, trustDelta: -1_000, suspicionDelta: 1_000 });
    }
    if (observation.type === "HUNTER_SHOT") {
      publicKnown.set(observation.hunterPlayerId, { factionId: "GOOD", roleId: "HUNTER", memoryId: memory.memoryId });
      addEvidence(evidence, scores, { code: "PUBLIC_HUNTER_SHOT", subjectPlayerId: observation.hunterPlayerId, sourcePlayerId: observation.hunterPlayerId, memoryIds: [memory.memoryId], wolfLikelihoodDeltaBps: -10_000, trustDelta: 900, suspicionDelta: -900 });
    }
  }
}

function mergedClaims(state: NpcCognitiveState): { claims: NpcClaim[]; extractedIds: string[] } {
  const retainedSpeechOrdinals = new Set(state.memory.flatMap((memory) => memory.visibility === "PUBLIC" && memory.observation.type === "SPEECH" ? [memory.observation.ordinal] : []));
  const retained = state.claimLedger.filter((claim) => !claim.claimId.startsWith("AUTO:SPEECH:") || claim.sourcePublicOrdinal === null || !retainedSpeechOrdinals.has(claim.sourcePublicOrdinal));
  const auto = extractClaimsFromSpeechMemory(state);
  const byId = new Map<string, NpcClaim>();
  for (const claim of [...retained, ...auto]) byId.set(claim.claimId, cloneJson(claim));
  return { claims: [...byId.values()].sort((a, b) => (a.sourcePublicOrdinal ?? Number.MAX_SAFE_INTEGER) - (b.sourcePublicOrdinal ?? Number.MAX_SAFE_INTEGER) || a.claimId.localeCompare(b.claimId)), extractedIds: auto.map((claim) => claim.claimId) };
}

function effectiveKnownMap(state: NpcCognitiveState, publicKnown: Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string }>): Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string | null }> {
  const result = new Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string | null }>();
  for (const exact of state.identityKnowledge.exactIdentities) result.set(exact.playerId, { factionId: exact.factionId, roleId: exact.roleId, memoryId: null });
  for (const belief of state.beliefs) if (belief.knownFaction) result.set(belief.playerId, { factionId: belief.knownFaction, roleId: belief.knownRoleId, memoryId: belief.evidenceMemoryIds.at(-1) ?? null });
  for (const [playerId, known] of publicKnown) result.set(playerId, known);
  return result;
}

function applyClaimReasoning(state: NpcCognitiveState, claims: readonly NpcClaim[], known: Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string | null }>, scores: Map<string, MutableScore>, evidence: NpcReasoningEvidence[]): void {
  const skepticism = state.persona.skepticism;
  const consistency = state.persona.consistencyBias;
  const claimsBySource = new Map<string, NpcClaim[]>();
  for (const claim of claims) claimsBySource.set(claim.sourcePlayerId, [...(claimsBySource.get(claim.sourcePlayerId) ?? []), claim]);

  for (const [source, sourceClaims] of claimsBySource) {
    const roleClaims = sourceClaims.filter((claim) => claim.claimType === "ROLE_CLAIM" && claim.roleId !== null);
    const distinctRoles = new Set(roleClaims.map((claim) => claim.roleId));
    if (distinctRoles.size > 1) addEvidence(evidence, scores, { code: "ROLE_CLAIM_CONTRADICTION", subjectPlayerId: source, sourcePlayerId: source, memoryIds: roleClaims.flatMap((claim) => memoryIdForOrdinal(claim.sourcePublicOrdinal)).slice(-8), wolfLikelihoodDeltaBps: personaScale(2_800, skepticism), trustDelta: -personaScale(320, consistency), suspicionDelta: personaScale(420, skepticism) });

    const sourceKnown = known.get(source);
    for (const claim of roleClaims) {
      if (sourceKnown?.roleId && claim.roleId !== sourceKnown.roleId) addEvidence(evidence, scores, { code: "ROLE_CLAIM_CONTRADICTION", subjectPlayerId: source, sourcePlayerId: source, memoryIds: memoryIdForOrdinal(claim.sourcePublicOrdinal), wolfLikelihoodDeltaBps: personaScale(4_000, skepticism), trustDelta: -personaScale(500, consistency), suspicionDelta: personaScale(650, skepticism) });
      const selfRole = state.identityKnowledge.selfRoleId;
      if (source !== state.npcPlayerId && claim.roleId === selfRole && ["SEER", "WITCH", "HUNTER", "GUARD"].includes(selfRole)) {
        addEvidence(evidence, scores, { code: "ROLE_COUNTERCLAIM", subjectPlayerId: source, sourcePlayerId: source, memoryIds: memoryIdForOrdinal(claim.sourcePublicOrdinal), wolfLikelihoodDeltaBps: personaScale(selfRole === "SEER" ? 3_500 : 2_300, skepticism), trustDelta: -personaScale(350, skepticism), suspicionDelta: personaScale(520, skepticism) });
      }
    }

    const checks = sourceClaims.filter((claim) => claim.claimType === "CHECK_RESULT" && claim.targetPlayerId !== null && claim.alignment !== null);
    const byTarget = new Map<string, NpcClaim[]>();
    for (const check of checks) byTarget.set(check.targetPlayerId!, [...(byTarget.get(check.targetPlayerId!) ?? []), check]);
    for (const [target, targetChecks] of byTarget) {
      if (new Set(targetChecks.map((claim) => claim.alignment)).size > 1) addEvidence(evidence, scores, { code: "CHECK_INTERNAL_CONFLICT", subjectPlayerId: source, sourcePlayerId: source, memoryIds: targetChecks.flatMap((claim) => memoryIdForOrdinal(claim.sourcePublicOrdinal)).slice(-8), wolfLikelihoodDeltaBps: personaScale(4_500, skepticism), trustDelta: -personaScale(650, consistency), suspicionDelta: personaScale(750, skepticism) });
      const knownTarget = known.get(target);
      if (!knownTarget) continue;
      for (const check of targetChecks) {
        if (check.alignment === knownTarget.factionId) addEvidence(evidence, scores, { code: "CHECK_CONFIRMED", subjectPlayerId: source, sourcePlayerId: source, memoryIds: [...memoryIdForOrdinal(check.sourcePublicOrdinal), ...(knownTarget.memoryId ? [knownTarget.memoryId] : [])].slice(0, 8), wolfLikelihoodDeltaBps: -personaScale(1_000, skepticism), trustDelta: personaScale(240, consistency), suspicionDelta: -personaScale(180, skepticism) });
        else addEvidence(evidence, scores, { code: "CHECK_CONTRADICTION", subjectPlayerId: source, sourcePlayerId: source, memoryIds: [...memoryIdForOrdinal(check.sourcePublicOrdinal), ...(knownTarget.memoryId ? [knownTarget.memoryId] : [])].slice(0, 8), wolfLikelihoodDeltaBps: personaScale(4_200, skepticism), trustDelta: -personaScale(600, consistency), suspicionDelta: personaScale(680, skepticism) });
      }
    }

    const reads = sourceClaims.filter((claim) => claim.claimType === "ALIGNMENT_READ" && claim.targetPlayerId !== null && claim.alignment !== null);
    for (const read of reads) {
      const target = known.get(read.targetPlayerId!);
      if (!target) continue;
      const matches = read.alignment === target.factionId;
      addEvidence(evidence, scores, { code: matches ? "ALIGNMENT_READ_CONFIRMED" : "ALIGNMENT_READ_CONTRADICTED", subjectPlayerId: source, sourcePlayerId: source, memoryIds: memoryIdForOrdinal(read.sourcePublicOrdinal), wolfLikelihoodDeltaBps: matches ? -150 : 300, trustDelta: matches ? 80 : -80, suspicionDelta: matches ? -50 : 100 });
    }
  }
}

function voteObservations(state: NpcCognitiveState): Array<{ memoryId: string; ordinal: number; ballots: Array<{ voterPlayerId: string; targetPlayerId: string | null }>; voteKind: "SHERIFF" | "SHERIFF_PK" | "DAY" | "DAY_PK" }> {
  return state.memory.flatMap((memory) => memory.visibility === "PUBLIC" && memory.observation.type === "VOTE_RESULT" ? [{ memoryId: memory.memoryId, ordinal: memory.observation.ordinal, ballots: memory.observation.ballots, voteKind: memory.observation.voteKind }] : []);
}

function applyVoteReasoning(state: NpcCognitiveState, claims: readonly NpcClaim[], known: Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string | null }>, scores: Map<string, MutableScore>, evidence: NpcReasoningEvidence[]): void {
  const votes = voteObservations(state);
  for (const vote of votes) {
    const dayWeight = vote.voteKind === "DAY" || vote.voteKind === "DAY_PK" ? 1 : 0.55;
    for (const ballot of vote.ballots) {
      if (ballot.targetPlayerId === null) continue;
      const targetKnown = known.get(ballot.targetPlayerId);
      if (targetKnown?.factionId === "WOLF") addEvidence(evidence, scores, { code: "VOTE_AGAINST_KNOWN_WOLF", subjectPlayerId: ballot.voterPlayerId, sourcePlayerId: ballot.voterPlayerId, memoryIds: [vote.memoryId], wolfLikelihoodDeltaBps: Math.round(-650 * dayWeight), trustDelta: Math.round(180 * dayWeight), suspicionDelta: Math.round(-140 * dayWeight) });
      if (targetKnown?.factionId === "GOOD") addEvidence(evidence, scores, { code: "VOTE_AGAINST_KNOWN_GOOD", subjectPlayerId: ballot.voterPlayerId, sourcePlayerId: ballot.voterPlayerId, memoryIds: [vote.memoryId], wolfLikelihoodDeltaBps: Math.round(260 * dayWeight), trustDelta: Math.round(-70 * dayWeight), suspicionDelta: Math.round(90 * dayWeight) });
      const voterKnown = known.get(ballot.voterPlayerId);
      if (voterKnown?.factionId === "WOLF" && !known.has(ballot.targetPlayerId)) addEvidence(evidence, scores, { code: "KNOWN_WOLF_BALLOT_PRESSURE", subjectPlayerId: ballot.targetPlayerId, sourcePlayerId: ballot.voterPlayerId, memoryIds: [vote.memoryId], wolfLikelihoodDeltaBps: Math.round(-220 * dayWeight), trustDelta: Math.round(45 * dayWeight), suspicionDelta: Math.round(-45 * dayWeight) });
    }
  }

  const intents = claims.filter((claim) => claim.claimType === "VOTE_INTENT" && claim.targetPlayerId !== null && claim.sourcePublicOrdinal !== null);
  for (const intent of intents) {
    const laterVote = votes.find((vote) => vote.ordinal > intent.sourcePublicOrdinal! && vote.ballots.some((ballot) => ballot.voterPlayerId === intent.sourcePlayerId));
    if (!laterVote) continue;
    const ballot = laterVote.ballots.find((entry) => entry.voterPlayerId === intent.sourcePlayerId)!;
    const kept = ballot.targetPlayerId === intent.targetPlayerId;
    const scale = 0.75 + state.persona.consistencyBias / 200;
    addEvidence(evidence, scores, { code: kept ? "VOTE_INTENT_KEPT" : "VOTE_INTENT_BROKEN", subjectPlayerId: intent.sourcePlayerId, sourcePlayerId: intent.sourcePlayerId, memoryIds: [...memoryIdForOrdinal(intent.sourcePublicOrdinal), laterVote.memoryId].slice(0, 8), wolfLikelihoodDeltaBps: Math.round((kept ? -120 : 280) * scale), trustDelta: Math.round((kept ? 90 : -140) * scale), suspicionDelta: Math.round((kept ? -60 : 160) * scale) });
  }
}

function rebuildBeliefs(state: NpcCognitiveState, known: Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string | null }>, scores: Map<string, MutableScore>): NpcBelief[] {
  return state.publicSnapshot.seats.map((seat) => {
    const original = state.beliefs.find((belief) => belief.playerId === seat.playerId);
    const fact = known.get(seat.playerId);
    const score = scores.get(seat.playerId)!;
    if (fact) {
      const knownPackmate = state.identityKnowledge.selfFactionId === "WOLF" && fact.factionId === "WOLF";
      const baseTrust = knownPackmate ? 850 : fact.factionId === "GOOD" ? 700 : -700;
      const baseSuspicion = knownPackmate ? -850 : fact.factionId === "WOLF" ? 850 : -650;
      return {
      playerId: seat.playerId,
      knownFaction: fact.factionId,
      knownRoleId: fact.roleId,
      wolfLikelihoodBps: fact.factionId === "WOLF" ? 10_000 : 0,
      trustScore: seat.playerId === state.npcPlayerId ? 1_000 : clamp(baseTrust + score.trustDelta, -1_000, 1_000),
      suspicionScore: seat.playerId === state.npcPlayerId ? -1_000 : clamp(baseSuspicion + score.suspicionDelta, -1_000, 1_000),
      evidenceMemoryIds: [...new Set([...(original?.evidenceMemoryIds ?? []), ...(fact.memoryId ? [fact.memoryId] : []), ...score.evidenceMemoryIds])].slice(-32),
      };
    }
    return {
      playerId: seat.playerId,
      knownFaction: null,
      knownRoleId: null,
      wolfLikelihoodBps: clamp(5_000 + score.wolfDelta, 0, 10_000),
      trustScore: seat.playerId === state.npcPlayerId ? 1_000 : clamp(score.trustDelta, -1_000, 1_000),
      suspicionScore: seat.playerId === state.npcPlayerId ? -1_000 : clamp(score.suspicionDelta, -1_000, 1_000),
      evidenceMemoryIds: [...score.evidenceMemoryIds].slice(-32),
    };
  }).sort((a, b) => a.playerId.localeCompare(b.playerId));
}

function rankSuspects(state: NpcCognitiveState, beliefs: readonly NpcBelief[]): NpcBelief[] {
  const alive = alivePlayerIds(state);
  return [...beliefs].filter((belief) => belief.playerId !== state.npcPlayerId && alive.has(belief.playerId)).sort((a, b) => b.wolfLikelihoodBps - a.wolfLikelihoodBps || b.suspicionScore - a.suspicionScore || a.trustScore - b.trustScore || a.playerId.localeCompare(b.playerId));
}
function rankTrusted(state: NpcCognitiveState, beliefs: readonly NpcBelief[]): NpcBelief[] {
  const alive = alivePlayerIds(state);
  return [...beliefs].filter((belief) => belief.playerId !== state.npcPlayerId && alive.has(belief.playerId)).sort((a, b) => b.trustScore - a.trustScore || a.wolfLikelihoodBps - b.wolfLikelihoodBps || a.playerId.localeCompare(b.playerId));
}

function workingVoteTarget(state: NpcCognitiveState, suspects: readonly NpcBelief[]): string | null {
  const selfWolf = state.identityKnowledge.selfFactionId === "WOLF";
  const pack = new Set(state.identityKnowledge.exactIdentities.filter((entry) => entry.factionId === "WOLF").map((entry) => entry.playerId));
  return suspects.find((belief) => !(selfWolf && pack.has(belief.playerId)))?.playerId ?? null;
}

export function runHeuristicReasoning(stateInput: NpcCognitiveState): { state: NpcCognitiveState; report: NpcHeuristicReasoningReport } {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  const scores = initialScores(state);
  const evidence: NpcReasoningEvidence[] = [];
  const publicKnown = new Map<string, { factionId: "WOLF" | "GOOD"; roleId: string | null; memoryId: string }>();
  applyPublicProofs(state, scores, evidence, publicKnown);
  const { claims, extractedIds } = mergedClaims(state);
  const known = effectiveKnownMap(state, publicKnown);
  applyClaimReasoning(state, claims, known, scores, evidence);
  applyVoteReasoning(state, claims, known, scores, evidence);
  const beliefs = rebuildBeliefs(state, known, scores);
  const suspects = rankSuspects(state, beliefs);
  const trusted = rankTrusted(state, beliefs);
  const voteTarget = workingVoteTarget(state, suspects);
  const notes = [
    "HEURISTIC:C02",
    ...(suspects[0] ? [`TOP_SUSPECT:${suspects[0].playerId}:${suspects[0].wolfLikelihoodBps}`] : []),
    ...(trusted[0] ? [`TOP_TRUSTED:${trusted[0].playerId}:${trusted[0].trustScore}`] : []),
  ];
  const nextShape = {
    ...state,
    beliefs,
    claimLedger: claims,
    workingTheory: {
      ...state.workingTheory,
      supportedPlayerId: trusted[0]?.playerId ?? null,
      opposedPlayerId: suspects[0]?.playerId ?? null,
      voteIntentPlayerId: voteTarget,
      notes,
    },
  };
  const changed = JSON.stringify({ beliefs: state.beliefs, claimLedger: state.claimLedger, workingTheory: state.workingTheory }) !== JSON.stringify({ beliefs: nextShape.beliefs, claimLedger: nextShape.claimLedger, workingTheory: nextShape.workingTheory });
  const next = NpcCognitiveStateSchema.parse(changed ? { ...nextShape, revision: state.revision + 1 } : nextShape);
  const report = NpcHeuristicReasoningReportSchema.parse({
    contractVersion: "1.0.0",
    gameId: state.gameId,
    npcPlayerId: state.npcPlayerId,
    sourceRevision: state.revision,
    extractedClaimIds: extractedIds,
    evidence,
    topSuspects: suspects.slice(0, 5).map((belief) => ({ playerId: belief.playerId, wolfLikelihoodBps: belief.wolfLikelihoodBps, trustScore: belief.trustScore, suspicionScore: belief.suspicionScore })),
    topTrusted: trusted.slice(0, 5).map((belief) => ({ playerId: belief.playerId, wolfLikelihoodBps: belief.wolfLikelihoodBps, trustScore: belief.trustScore, suspicionScore: belief.suspicionScore })),
    recommendedVoteTargetPlayerId: voteTarget,
  });
  return { state: next, report };
}
