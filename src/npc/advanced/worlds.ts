import { getRegisteredRole } from "../../core/rulesets/registry.js";
import type { PlayerView } from "../../projection/schemas.js";
import type { NpcClaim, NpcCognitiveState } from "../cognition/schemas.js";
import { NpcWorldHypothesisSchema, NpcWorldMarginalSchema, type NpcAdvancedEvidence, type NpcWorldAssignment, type NpcWorldHypothesis, type NpcWorldMarginal } from "./schemas.js";

const BEAM_WIDTH = 64;
const TOP_WORLDS = 8;

type BeamNode = {
  assignments: NpcWorldAssignment[];
  remaining: Map<string, number>;
  score: number;
  assumptionCost: number;
  supportingEvidenceIds: Set<string>;
  explanationCodes: Set<string>;
};

type RoleCandidateScore = {
  score: number;
  assumptionCost: number;
  supportingEvidenceIds: string[];
  explanationCodes: string[];
};

const netScore = (node: BeamNode): number => node.score - node.assumptionCost * 110;

function factionForRole(roleId: string): "WOLF" | "GOOD" {
  return getRegisteredRole(roleId).factionId;
}

function knownConstraint(state: NpcCognitiveState, playerId: string): { factionId: "WOLF" | "GOOD" | null; roleId: string | null } {
  const exact = state.identityKnowledge.exactIdentities.find((entry) => entry.playerId === playerId);
  if (exact) return { factionId: exact.factionId, roleId: exact.roleId };
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  return { factionId: belief?.knownFaction ?? null, roleId: belief?.knownRoleId ?? null };
}

function claimsFor(state: NpcCognitiveState, playerId: string): NpcClaim[] {
  return state.claimLedger.filter((claim) => claim.sourcePlayerId === playerId);
}

function candidateRoles(view: PlayerView, state: NpcCognitiveState, playerId: string, remaining: ReadonlyMap<string, number>, forcedRoleId: string | null): string[] {
  const known = knownConstraint(state, playerId);
  return view.public.ruleset.roles
    .map((entry) => entry.roleId)
    .filter((roleId) => (remaining.get(roleId) ?? 0) > 0)
    .filter((roleId) => forcedRoleId === null || roleId === forcedRoleId)
    .filter((roleId) => known.roleId === null || roleId === known.roleId)
    .filter((roleId) => known.factionId === null || factionForRole(roleId) === known.factionId)
    .sort();
}

function roleClaimAssumption(claims: readonly NpcClaim[], roleId: string, factionId: "WOLF" | "GOOD"): { score: number; cost: number; codes: string[] } {
  const roleClaims = claims.filter((claim) => claim.claimType === "ROLE_CLAIM" && claim.roleId !== null);
  if (roleClaims.length === 0) return { score: 0, cost: 0, codes: [] };
  const claimed = new Set(roleClaims.map((claim) => claim.roleId!));
  if (claimed.has(roleId)) return { score: 360, cost: 0, codes: ["ROLE_CLAIM_FITS_WORLD"] };
  // A wolf lying about a role is a smaller assumption than an unrelated good role lying without another explanation.
  return factionId === "WOLF"
    ? { score: 50, cost: 1, codes: ["WOLF_ROLE_CLAIM_DECEPTION_PLAUSIBLE"] }
    : { score: -180, cost: 2, codes: ["GOOD_ROLE_CLAIM_MISMATCH_REQUIRES_ASSUMPTION"] };
}

function checkClaimAssumption(claims: readonly NpcClaim[], roleId: string, factionId: "WOLF" | "GOOD"): { score: number; cost: number; codes: string[] } {
  const checks = claims.filter((claim) => claim.claimType === "CHECK_RESULT");
  if (checks.length === 0) return { score: 0, cost: 0, codes: [] };
  if (roleId === "SEER") return { score: 300 + Math.min(180, checks.length * 45), cost: 0, codes: ["CHECK_BEHAVIOR_FITS_SEER"] };
  if (factionId === "WOLF") return { score: 100, cost: 1, codes: ["WOLF_FAKE_SEER_WORLD"] };
  return { score: -260, cost: 3, codes: ["GOOD_NON_SEER_FAKE_CHECK_REQUIRES_ASSUMPTION"] };
}

function evidenceFit(evidence: readonly NpcAdvancedEvidence[], playerId: string, roleId: string, factionId: "WOLF" | "GOOD"): RoleCandidateScore {
  let score = 0;
  let assumptionCost = 0;
  const supportingEvidenceIds: string[] = [];
  const explanationCodes: string[] = [];
  for (const item of evidence) {
    if (item.subjectPlayerId !== playerId) continue;
    if (item.wolfLeanBps !== 0) {
      const aligned = factionId === "WOLF" ? item.wolfLeanBps : -item.wolfLeanBps;
      const contribution = Math.round((aligned * item.confidenceBps) / 100_000);
      score += contribution;
      if (contribution > 0) supportingEvidenceIds.push(item.evidenceId);
    }
    if (item.favoredRoleIds.length > 0) {
      if (item.favoredRoleIds.includes(roleId)) {
        score += Math.round(item.confidenceBps / 20);
        supportingEvidenceIds.push(item.evidenceId);
        explanationCodes.push(`ROLE_SIGNAL:${item.code}`);
      } else if (item.assumptionCostIfIgnored > 0) assumptionCost += item.assumptionCostIfIgnored;
    }
    if (item.disfavoredRoleIds.includes(roleId)) score -= Math.round(item.confidenceBps / 20);
  }
  return { score, assumptionCost, supportingEvidenceIds, explanationCodes };
}

function localCandidateScore(state: NpcCognitiveState, evidence: readonly NpcAdvancedEvidence[], playerId: string, roleId: string): RoleCandidateScore {
  const factionId = factionForRole(roleId);
  const belief = state.beliefs.find((entry) => entry.playerId === playerId);
  const wolfBps = belief?.wolfLikelihoodBps ?? 5_000;
  const factionFit = factionId === "WOLF" ? wolfBps : 10_000 - wolfBps;
  let score = Math.round(factionFit / 18);
  let assumptionCost = 0;
  const supportingEvidenceIds: string[] = [];
  const explanationCodes = [`FACTION_FIT:${factionId}`];

  const known = knownConstraint(state, playerId);
  if (known.roleId === roleId) { score += 4_000; explanationCodes.push("EXACT_ROLE_CONSTRAINT"); }
  else if (known.factionId === factionId) { score += 1_600; explanationCodes.push("EXACT_FACTION_CONSTRAINT"); }

  const claims = claimsFor(state, playerId);
  const roleFit = roleClaimAssumption(claims, roleId, factionId);
  score += roleFit.score; assumptionCost += roleFit.cost; explanationCodes.push(...roleFit.codes);
  const checkFit = checkClaimAssumption(claims, roleId, factionId);
  score += checkFit.score; assumptionCost += checkFit.cost; explanationCodes.push(...checkFit.codes);
  const soft = evidenceFit(evidence, playerId, roleId, factionId);
  score += soft.score; assumptionCost += soft.assumptionCost; supportingEvidenceIds.push(...soft.supportingEvidenceIds); explanationCodes.push(...soft.explanationCodes);

  return { score, assumptionCost, supportingEvidenceIds: [...new Set(supportingEvidenceIds)], explanationCodes: [...new Set(explanationCodes)] };
}

function seatConstraintRank(state: NpcCognitiveState, playerId: string): number {
  const known = knownConstraint(state, playerId);
  if (known.roleId !== null) return 0;
  if (known.factionId !== null) return 1;
  if (state.claimLedger.some((claim) => claim.sourcePlayerId === playerId && claim.claimType === "ROLE_CLAIM")) return 2;
  return 3;
}

function createInitialRemaining(view: PlayerView): Map<string, number> {
  return new Map(view.public.ruleset.roles.map((entry) => [entry.roleId, entry.count]));
}

function assignmentSignature(node: BeamNode): string {
  return [...node.assignments].sort((a, b) => a.playerId.localeCompare(b.playerId)).map((entry) => `${entry.playerId}=${entry.roleId}`).join("|");
}

function normalizeWorlds(nodes: readonly BeamNode[], anchorNodes: readonly BeamNode[]): NpcWorldHypothesis[] {
  if (nodes.length === 0 && anchorNodes.length === 0) return [];
  const allBySignature = new Map<string, BeamNode>();
  for (const node of [...nodes, ...anchorNodes]) {
    const key = assignmentSignature(node);
    const current = allBySignature.get(key);
    if (!current || netScore(node) > netScore(current)) allBySignature.set(key, node);
  }
  const sorted = [...allBySignature.values()].sort((a, b) => netScore(b) - netScore(a) || a.assumptionCost - b.assumptionCost || assignmentSignature(a).localeCompare(assignmentSignature(b)));
  const selected: BeamNode[] = [];
  const selectedKeys = new Set<string>();
  const push = (node: BeamNode | undefined): void => {
    if (!node || selected.length >= TOP_WORLDS) return;
    const key = assignmentSignature(node);
    if (selectedKeys.has(key)) return;
    selected.push(node); selectedKeys.add(key);
  };
  push(sorted[0]);
  for (const anchor of [...anchorNodes].sort((a, b) => netScore(b) - netScore(a))) push(anchor);
  for (const node of sorted) push(node);
  selected.sort((a, b) => netScore(b) - netScore(a) || a.assumptionCost - b.assumptionCost || assignmentSignature(a).localeCompare(assignmentSignature(b)));

  const best = Math.max(...selected.map(netScore));
  const rawWeights = selected.map((node) => Math.max(100, 10_000 - Math.max(0, best - netScore(node)) * 5));
  const total = rawWeights.reduce((sum, value) => sum + value, 0);
  let allocated = 0;
  return selected.map((node, index) => {
    const relativeWeightBps = index === selected.length - 1 ? 10_000 - allocated : Math.round((rawWeights[index]! * 10_000) / total);
    allocated += relativeWeightBps;
    return NpcWorldHypothesisSchema.parse({
      worldId: `WORLD:${String(index + 1).padStart(2, "0")}`,
      rank: index + 1,
      score: netScore(node),
      relativeWeightBps,
      assumptionCost: node.assumptionCost,
      assignments: [...node.assignments].sort((a, b) => a.playerId.localeCompare(b.playerId)),
      supportingEvidenceIds: [...node.supportingEvidenceIds].sort().slice(0, 64),
      explanationCodes: [...node.explanationCodes].sort().slice(0, 32),
    });
  });
}

function worldMarginals(worlds: readonly NpcWorldHypothesis[], state: NpcCognitiveState): NpcWorldMarginal[] {
  if (worlds.length === 0) return [];
  return state.publicSnapshot.seats.map((seat) => {
    let wolfWeight = 0;
    const roleWeights = new Map<string, number>();
    let total = 0;
    for (const world of worlds) {
      const assignment = world.assignments.find((entry) => entry.playerId === seat.playerId);
      if (!assignment) continue;
      total += world.relativeWeightBps;
      if (assignment.factionId === "WOLF") wolfWeight += world.relativeWeightBps;
      roleWeights.set(assignment.roleId, (roleWeights.get(assignment.roleId) ?? 0) + world.relativeWeightBps);
    }
    const roles = [...roleWeights.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const bestRole = roles[0] ?? ["VILLAGER", 0] as const;
    return NpcWorldMarginalSchema.parse({
      playerId: seat.playerId,
      wolfLikelihoodBps: total === 0 ? 5_000 : Math.round((wolfWeight * 10_000) / total),
      mostLikelyRoleId: bestRole[0],
      roleConfidenceBps: total === 0 ? 0 : Math.round((bestRole[1] * 10_000) / total),
    });
  }).sort((a, b) => a.playerId.localeCompare(b.playerId));
}

/** Beam-searches only worlds consistent with the NPC's legal facts and the public role catalog. */
function runBeam(view: PlayerView, state: NpcCognitiveState, evidence: readonly NpcAdvancedEvidence[], forcedRoles: ReadonlyMap<string, string> = new Map()): BeamNode[] {
  const orderedSeats = [...state.publicSnapshot.seats].sort((a, b) => seatConstraintRank(state, a.playerId) - seatConstraintRank(state, b.playerId) || a.seatNumber - b.seatNumber);
  let beam: BeamNode[] = [{ assignments: [], remaining: createInitialRemaining(view), score: 0, assumptionCost: 0, supportingEvidenceIds: new Set(), explanationCodes: new Set() }];
  for (const seat of orderedSeats) {
    const next: BeamNode[] = [];
    for (const node of beam) {
      const candidates = candidateRoles(view, state, seat.playerId, node.remaining, forcedRoles.get(seat.playerId) ?? null);
      for (const roleId of candidates) {
        const local = localCandidateScore(state, evidence, seat.playerId, roleId);
        const remaining = new Map(node.remaining);
        remaining.set(roleId, (remaining.get(roleId) ?? 0) - 1);
        const assignment: NpcWorldAssignment = { playerId: seat.playerId, roleId, factionId: factionForRole(roleId) };
        next.push({
          assignments: [...node.assignments, assignment],
          remaining,
          score: node.score + local.score,
          assumptionCost: node.assumptionCost + local.assumptionCost,
          supportingEvidenceIds: new Set([...node.supportingEvidenceIds, ...local.supportingEvidenceIds]),
          explanationCodes: new Set([...node.explanationCodes, ...local.explanationCodes]),
        });
      }
    }
    beam = next.sort((a, b) => netScore(b) - netScore(a) || a.assumptionCost - b.assumptionCost || assignmentSignature(a).localeCompare(assignmentSignature(b))).slice(0, BEAM_WIDTH);
    if (beam.length === 0) break;
  }
  return beam.filter((node) => [...node.remaining.values()].every((count) => count === 0));
}

function contestedRoleAnchors(state: NpcCognitiveState): Array<{ playerId: string; roleId: string }> {
  const groups = new Map<string, Set<string>>();
  for (const claim of state.claimLedger) {
    if (claim.claimType !== "ROLE_CLAIM" || claim.roleId === null) continue;
    groups.set(claim.roleId, new Set([...(groups.get(claim.roleId) ?? new Set<string>()), claim.sourcePlayerId]));
  }
  return [...groups.entries()].filter(([, players]) => players.size > 1).flatMap(([roleId, players]) => [...players].sort().map((playerId) => ({ playerId, roleId })));
}

export function buildWorldHypotheses(view: PlayerView, state: NpcCognitiveState, evidence: readonly NpcAdvancedEvidence[]): { worlds: NpcWorldHypothesis[]; marginals: NpcWorldMarginal[] } {
  const complete = runBeam(view, state, evidence);
  const anchorNodes: BeamNode[] = [];
  for (const anchor of contestedRoleAnchors(state)) {
    const known = knownConstraint(state, anchor.playerId);
    if (known.roleId !== null && known.roleId !== anchor.roleId) continue;
    if (known.factionId !== null && known.factionId !== factionForRole(anchor.roleId)) continue;
    const anchored = runBeam(view, state, evidence, new Map([[anchor.playerId, anchor.roleId]]));
    if (anchored[0]) anchorNodes.push(anchored[0]);
  }
  const worlds = normalizeWorlds(complete, anchorNodes);
  return { worlds, marginals: worldMarginals(worlds, state) };
}
