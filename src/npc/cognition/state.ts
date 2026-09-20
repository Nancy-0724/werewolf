import { cloneJson } from "../../core/domain/json.js";
import type { PlayerView, PrivateObservation, PublicObservation } from "../../projection/schemas.js";
import { deriveNpcPersona } from "./persona.js";
import { EMPTY_ADVANCED_REASONING } from "../advanced/schemas.js";
import {
  DecisionInputSchema,
  NpcCognitiveStateSchema,
  StructuredClaimInputSchema,
  type DecisionInput,
  type NpcBelief,
  type NpcClaim,
  type NpcCognitiveState,
  type NpcExactIdentityKnowledge,
  type NpcMemoryEntry,
  type NpcWorkingTheory,
  type StructuredClaimInput,
} from "./schemas.js";

export const MAX_NPC_MEMORIES = 256;
export const MAX_NPC_DECISIONS = 256;

export class NpcCognitionError extends Error {
  public readonly code: "NPC_VIEW_REQUIRED" | "NPC_IDENTITY_REQUIRED" | "COGNITIVE_STATE_MISMATCH" | "COGNITIVE_VIEW_REGRESSION" | "INVALID_OBSERVATION_STREAM" | "INVALID_COGNITIVE_TARGET";
  public constructor(code: NpcCognitionError["code"], message: string) { super(message); this.name = "NpcCognitionError"; this.code = code; }
}

function memoryImportance(observation: PublicObservation | PrivateObservation): "ROUTINE" | "IMPORTANT" | "CRITICAL" {
  if (observation.type === "GAME_ENDED" || observation.type === "SEER_CHECK" || observation.type === "SELF_EXPLOSION" || observation.type === "HUNTER_SHOT") return "CRITICAL";
  if (observation.type === "DAWN" || observation.type === "DEATHS_REVEALED" || observation.type === "VOTE_RESULT" || observation.type === "SHERIFF_ELECTED" || observation.type === "WOLF_TARGET" || observation.type === "WITCH_KNIFE_INFO") return "IMPORTANT";
  return "ROUTINE";
}

function publicMemory(observation: PublicObservation): NpcMemoryEntry {
  return { memoryId: `PUBLIC:${observation.ordinal}`, visibility: "PUBLIC", importance: memoryImportance(observation), observation: cloneJson(observation) };
}
function privateMemory(observation: PrivateObservation): NpcMemoryEntry {
  return { memoryId: `PRIVATE:${observation.ordinal}`, visibility: "PRIVATE", importance: memoryImportance(observation), observation: cloneJson(observation) };
}

function pruneMemory(entries: readonly NpcMemoryEntry[]): { memory: NpcMemoryEntry[]; pruned: number } {
  if (entries.length <= MAX_NPC_MEMORIES) return { memory: cloneJson([...entries]), pruned: 0 };
  const keep = [...entries];
  let toRemove = keep.length - MAX_NPC_MEMORIES;
  for (const importance of ["ROUTINE", "IMPORTANT", "CRITICAL"] as const) {
    for (let index = 0; index < keep.length && toRemove > 0;) {
      if (keep[index]?.importance === importance) { keep.splice(index, 1); toRemove -= 1; } else index += 1;
    }
  }
  return { memory: cloneJson(keep.slice(-MAX_NPC_MEMORIES)), pruned: entries.length - Math.min(entries.length, MAX_NPC_MEMORIES) };
}

function exactIdentityMap(state: NpcCognitiveState): Map<string, NpcExactIdentityKnowledge> {
  return new Map(state.identityKnowledge.exactIdentities.map((entry) => [entry.playerId, entry]));
}

function beliefMap(state: NpcCognitiveState): Map<string, NpcBelief> {
  return new Map(state.beliefs.map((entry) => [entry.playerId, cloneJson(entry)]));
}

function initialBeliefs(view: PlayerView, exact: readonly NpcExactIdentityKnowledge[]): NpcBelief[] {
  const exactByPlayer = new Map(exact.map((entry) => [entry.playerId, entry]));
  return view.public.seats.map((seat) => {
    const known = exactByPlayer.get(seat.playerId);
    return {
      playerId: seat.playerId,
      knownFaction: known?.factionId ?? null,
      knownRoleId: known?.roleId ?? null,
      wolfLikelihoodBps: known === undefined ? 5_000 : known.factionId === "WOLF" ? 10_000 : 0,
      trustScore: seat.playerId === view.viewer.playerId ? 1_000 : 0,
      suspicionScore: seat.playerId === view.viewer.playerId ? -1_000 : 0,
      evidenceMemoryIds: [],
    };
  });
}

function exactIdentitiesFromView(view: PlayerView): NpcExactIdentityKnowledge[] {
  if (view.identity === null) throw new NpcCognitionError("NPC_IDENTITY_REQUIRED", "NPC cognitive state requires a locked identity");
  const exact: NpcExactIdentityKnowledge[] = [{ playerId: view.viewer.playerId, roleId: view.identity.roleId, factionId: view.identity.factionId, source: "SELF" }];
  for (const entry of view.identity.initiallyKnownIdentities) exact.push({ playerId: entry.playerId, roleId: entry.roleId, factionId: entry.factionId, source: "INITIAL_KNOWLEDGE" });
  return exact.sort((a, b) => a.playerId.localeCompare(b.playerId));
}

function publicSnapshot(view: PlayerView): NpcCognitiveState["publicSnapshot"] {
  return {
    stage: view.public.stage.kind,
    round: view.public.stage.round,
    seats: view.public.seats.map((seat) => ({ playerId: seat.playerId, seatNumber: seat.seatNumber, lifeState: seat.lifeState, isSheriff: seat.isSheriff })),
    sheriffHolderPlayerId: view.public.sheriff.holderPlayerId,
    outcome: view.public.outcome?.result ?? null,
  };
}

function assertNpcView(view: PlayerView): void {
  if (view.viewer.controllerType !== "NPC") throw new NpcCognitionError("NPC_VIEW_REQUIRED", "Cognitive state can only be created for an NPC PlayerView");
  if (view.identity === null) throw new NpcCognitionError("NPC_IDENTITY_REQUIRED", "NPC cognitive state requires a locked identity");
}

function assertOrdinalStream(entries: readonly { ordinal: number }[], label: "public" | "private"): void {
  for (let index = 0; index < entries.length; index += 1) {
    if (entries[index]?.ordinal !== index + 1) throw new NpcCognitionError("INVALID_OBSERVATION_STREAM", `${label} observation ordinals must be contiguous from 1`);
  }
}

export function initializeNpcCognitiveState(view: PlayerView): NpcCognitiveState {
  assertNpcView(view);
  const exactIdentities = exactIdentitiesFromView(view);
  const base: NpcCognitiveState = {
    contractVersion: "1.0.0",
    gameId: view.public.gameId,
    npcPlayerId: view.viewer.playerId,
    revision: 0,
    persona: deriveNpcPersona(view.public.gameId, view.viewer.playerId),
    identityKnowledge: { selfRoleId: view.identity!.roleId, selfFactionId: view.identity!.factionId, exactIdentities },
    cursor: { publicOrdinal: 0, privateOrdinal: 0 },
    memory: [],
    memoryStats: { observedPublic: 0, observedPrivate: 0, pruned: 0 },
    beliefs: initialBeliefs(view, exactIdentities),
    claimLedger: [],
    workingTheory: { supportedPlayerId: null, opposedPlayerId: null, voteIntentPlayerId: null, abilityIntentTargetPlayerId: null, notes: [] },
    advancedReasoning: EMPTY_ADVANCED_REASONING,
    decisionHistory: [],
    publicSnapshot: publicSnapshot(view),
  };
  return synchronizeNpcCognitiveState(NpcCognitiveStateSchema.parse(base), view, false);
}

function applyPrivateFacts(state: NpcCognitiveState, newPrivate: readonly PrivateObservation[]): NpcCognitiveState {
  const beliefs = beliefMap(state);
  const exact = exactIdentityMap(state);
  for (const observation of newPrivate) {
    if (observation.type !== "SEER_CHECK") continue;
    const current = beliefs.get(observation.targetPlayerId);
    if (current === undefined) continue;
    current.knownFaction = observation.result;
    current.wolfLikelihoodBps = observation.result === "WOLF" ? 10_000 : 0;
    current.evidenceMemoryIds = [...new Set([...current.evidenceMemoryIds, `PRIVATE:${observation.ordinal}`])].slice(-32);
    beliefs.set(current.playerId, current);
  }
  return { ...state, beliefs: [...beliefs.values()].sort((a, b) => a.playerId.localeCompare(b.playerId)), identityKnowledge: { ...state.identityKnowledge, exactIdentities: [...exact.values()].sort((a, b) => a.playerId.localeCompare(b.playerId)) } };
}

function applyPostGameReveal(state: NpcCognitiveState, view: PlayerView): NpcCognitiveState {
  if (view.finalReveal === null) return state;
  const exact = exactIdentityMap(state);
  const beliefs = beliefMap(state);
  for (const assignment of view.finalReveal.assignments) {
    exact.set(assignment.playerId, { playerId: assignment.playerId, roleId: assignment.roleId, factionId: assignment.factionId, source: assignment.playerId === state.npcPlayerId ? "SELF" : "POST_GAME_REVEAL" });
    const belief = beliefs.get(assignment.playerId);
    if (belief !== undefined) {
      belief.knownFaction = assignment.factionId;
      belief.knownRoleId = assignment.roleId;
      belief.wolfLikelihoodBps = assignment.factionId === "WOLF" ? 10_000 : 0;
      beliefs.set(assignment.playerId, belief);
    }
  }
  return { ...state, identityKnowledge: { ...state.identityKnowledge, exactIdentities: [...exact.values()].sort((a, b) => a.playerId.localeCompare(b.playerId)) }, beliefs: [...beliefs.values()].sort((a, b) => a.playerId.localeCompare(b.playerId)) };
}

export function synchronizeNpcCognitiveState(stateInput: NpcCognitiveState, view: PlayerView, incrementRevision = true): NpcCognitiveState {
  assertNpcView(view);
  const state = NpcCognitiveStateSchema.parse(stateInput);
  if (state.gameId !== view.public.gameId || state.npcPlayerId !== view.viewer.playerId) throw new NpcCognitionError("COGNITIVE_STATE_MISMATCH", "Cognitive state does not belong to this game/player view");
  if (view.identity?.roleId !== state.identityKnowledge.selfRoleId || view.identity?.factionId !== state.identityKnowledge.selfFactionId) throw new NpcCognitionError("COGNITIVE_STATE_MISMATCH", "NPC self identity changed across PlayerView synchronization");
  assertOrdinalStream(view.public.timeline, "public");
  assertOrdinalStream(view.privateObservations, "private");
  const latestPublic = view.public.timeline.at(-1)?.ordinal ?? 0;
  const latestPrivate = view.privateObservations.at(-1)?.ordinal ?? 0;
  if (latestPublic < state.cursor.publicOrdinal || latestPrivate < state.cursor.privateOrdinal) throw new NpcCognitionError("COGNITIVE_VIEW_REGRESSION", "PlayerView observation history is older than the persisted cognitive cursor");

  const newPublic = view.public.timeline.filter((entry) => entry.ordinal > state.cursor.publicOrdinal);
  const newPrivate = view.privateObservations.filter((entry) => entry.ordinal > state.cursor.privateOrdinal);
  const merged = [...state.memory, ...newPublic.map(publicMemory), ...newPrivate.map(privateMemory)];
  const pruned = pruneMemory(merged);
  let next: NpcCognitiveState = {
    ...state,
    cursor: {
      publicOrdinal: Math.max(state.cursor.publicOrdinal, ...view.public.timeline.map((entry) => entry.ordinal), 0),
      privateOrdinal: Math.max(state.cursor.privateOrdinal, ...view.privateObservations.map((entry) => entry.ordinal), 0),
    },
    memory: pruned.memory,
    memoryStats: {
      observedPublic: state.memoryStats.observedPublic + newPublic.length,
      observedPrivate: state.memoryStats.observedPrivate + newPrivate.length,
      pruned: state.memoryStats.pruned + pruned.pruned,
    },
    publicSnapshot: publicSnapshot(view),
  };
  next = applyPrivateFacts(next, newPrivate);
  next = applyPostGameReveal(next, view);

  const changed = newPublic.length > 0 || newPrivate.length > 0 || JSON.stringify(next.publicSnapshot) !== JSON.stringify(state.publicSnapshot) || JSON.stringify(next.identityKnowledge) !== JSON.stringify(state.identityKnowledge) || JSON.stringify(next.beliefs) !== JSON.stringify(state.beliefs);
  if (changed && incrementRevision) next = { ...next, revision: state.revision + 1 };
  return NpcCognitiveStateSchema.parse(next);
}

function validPlayerIds(state: NpcCognitiveState): Set<string> { return new Set(state.publicSnapshot.seats.map((seat) => seat.playerId)); }
function assertTarget(state: NpcCognitiveState, target: string | null): void {
  if (target !== null && !validPlayerIds(state).has(target)) throw new NpcCognitionError("INVALID_COGNITIVE_TARGET", `Unknown player target ${target}`);
}

export function recordStructuredClaim(stateInput: NpcCognitiveState, claimId: string, input: StructuredClaimInput): NpcCognitiveState {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  if (state.claimLedger.some((entry) => entry.claimId === claimId)) return state;
  const parsed = StructuredClaimInputSchema.parse(input);
  assertTarget(state, parsed.sourcePlayerId); assertTarget(state, parsed.targetPlayerId);
  const claim: NpcClaim = { claimId, ...cloneJson(parsed) };
  return NpcCognitiveStateSchema.parse({ ...state, revision: state.revision + 1, claimLedger: [...state.claimLedger, claim] });
}

export function updateWorkingTheory(stateInput: NpcCognitiveState, patch: Partial<NpcWorkingTheory>): NpcCognitiveState {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  const theory = { ...state.workingTheory, ...cloneJson(patch) };
  assertTarget(state, theory.supportedPlayerId); assertTarget(state, theory.opposedPlayerId); assertTarget(state, theory.voteIntentPlayerId); assertTarget(state, theory.abilityIntentTargetPlayerId);
  const parsed = NpcCognitiveStateSchema.shape.workingTheory.parse(theory);
  if (JSON.stringify(parsed) === JSON.stringify(state.workingTheory)) return state;
  return NpcCognitiveStateSchema.parse({ ...state, revision: state.revision + 1, workingTheory: parsed });
}

export function recordNpcDecision(stateInput: NpcCognitiveState, input: DecisionInput): NpcCognitiveState {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  const parsed = DecisionInputSchema.parse(input);
  if (state.decisionHistory.some((entry) => entry.decisionId === parsed.decisionId)) return state;
  assertTarget(state, parsed.targetPlayerId);
  const nextRecord = { ...cloneJson(parsed), ordinal: state.decisionHistory.length === 0 ? 1 : Math.max(...state.decisionHistory.map((entry) => entry.ordinal)) + 1 };
  const history = [...state.decisionHistory, nextRecord].slice(-MAX_NPC_DECISIONS);
  return NpcCognitiveStateSchema.parse({ ...state, revision: state.revision + 1, decisionHistory: history });
}

/** C-03 lifecycle helper. Strategy decisions are non-authoritative, but their status can be tracked for later evaluation. */
export function updateNpcDecisionStatus(stateInput: NpcCognitiveState, decisionId: string, status: "COMMITTED" | "REJECTED"): NpcCognitiveState {
  const state = NpcCognitiveStateSchema.parse(stateInput);
  const index = state.decisionHistory.findIndex((entry) => entry.decisionId === decisionId);
  if (index < 0) return state;
  const current = state.decisionHistory[index]!;
  if (current.status === status) return state;
  if (current.status !== "PLANNED") return state;
  const decisionHistory = state.decisionHistory.map((entry, entryIndex) => entryIndex === index ? { ...entry, status } : entry);
  return NpcCognitiveStateSchema.parse({ ...state, revision: state.revision + 1, decisionHistory });
}
