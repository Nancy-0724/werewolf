import type { NpcClaim, NpcCognitiveState } from "../cognition/schemas.js";
import { NpcAdvancedEvidenceSchema, NpcTemporalTransitionSchema, type NpcAdvancedEvidence, type NpcTemporalTransition } from "./schemas.js";

const CERTAINTY_RE = /一定|絕對|绝对|鐵狼|铁狼|鐵好|铁好|百分百|肯定|不可能是狼|必(?:是|然)/u;
const ROLE_TOKEN = "狼美人|狼美|預言家|预言家|女巫|獵人|猎人|守衛|守卫|平民|村民|狼人";
const WOLF_ROLES = new Set(["WEREWOLF", "WOLF_BEAUTY"]);

function roleFromText(text: string): string | null {
  if (/狼美人|狼美/u.test(text)) return "WOLF_BEAUTY";
  if (/預言家|预言家/u.test(text)) return "SEER";
  if (/女巫/u.test(text)) return "WITCH";
  if (/獵人|猎人/u.test(text)) return "HUNTER";
  if (/守衛|守卫/u.test(text)) return "GUARD";
  if (/平民|村民/u.test(text)) return "VILLAGER";
  if (/狼人/u.test(text)) return "WEREWOLF";
  return null;
}

function playerIdForSeat(state: NpcCognitiveState, seatText: string): string | null {
  const seat = Number.parseInt(seatText, 10);
  if (!Number.isInteger(seat)) return null;
  return state.publicSnapshot.seats.find((entry) => entry.seatNumber === seat)?.playerId ?? null;
}

function personaScale(base: number, trait: number): number {
  return Math.round(base * (0.75 + trait / 200));
}

function addEvidence(list: NpcAdvancedEvidence[], input: Omit<NpcAdvancedEvidence, "evidenceId">): void {
  list.push(NpcAdvancedEvidenceSchema.parse({ evidenceId: `A:${String(list.length + 1).padStart(3, "0")}`, ...input }));
}

function publicRoleProofs(state: NpcCognitiveState): Map<string, string> {
  const result = new Map<string, string>();
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC") continue;
    if (memory.observation.type === "HUNTER_SHOT") result.set(memory.observation.hunterPlayerId, "HUNTER");
  }
  return result;
}

function publicFactionProofs(state: NpcCognitiveState): Map<string, "WOLF" | "GOOD"> {
  const result = new Map<string, "WOLF" | "GOOD">();
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC") continue;
    if (memory.observation.type === "SELF_EXPLOSION") result.set(memory.observation.playerId, "WOLF");
    if (memory.observation.type === "HUNTER_SHOT") result.set(memory.observation.hunterPlayerId, "GOOD");
  }
  return result;
}

function speechMemories(state: NpcCognitiveState): Array<{ ordinal: number; speakerPlayerId: string; text: string }> {
  return state.memory.flatMap((memory) => memory.visibility === "PUBLIC" && memory.observation.type === "SPEECH"
    ? [{ ordinal: memory.observation.ordinal, speakerPlayerId: memory.observation.speakerPlayerId, text: memory.observation.text }]
    : []);
}

function identityAndInformationEvidence(state: NpcCognitiveState, evidence: NpcAdvancedEvidence[]): void {
  const claimsBySource = new Map<string, NpcClaim[]>();
  for (const claim of state.claimLedger) claimsBySource.set(claim.sourcePlayerId, [...(claimsBySource.get(claim.sourcePlayerId) ?? []), claim]);

  for (const [sourcePlayerId, claims] of claimsBySource) {
    const seerClaims = claims.filter((claim) => claim.claimType === "ROLE_CLAIM" && claim.roleId === "SEER");
    const checks = claims.filter((claim) => claim.claimType === "CHECK_RESULT" && claim.targetPlayerId !== null && claim.alignment !== null);
    for (const seerClaim of seerClaims) {
      const supported = checks.some((check) => check.sourcePublicOrdinal !== null && seerClaim.sourcePublicOrdinal !== null && check.sourcePublicOrdinal >= seerClaim.sourcePublicOrdinal - 1);
      addEvidence(evidence, {
        layer: "IDENTITY",
        code: supported ? "SEER_CLAIM_WITH_CHECK_SUPPORT" : "SEER_CLAIM_WITHOUT_CHECK_SUPPORT",
        subjectPlayerId: sourcePlayerId,
        relatedPlayerIds: checks.flatMap((check) => check.targetPlayerId ? [check.targetPlayerId] : []).slice(0, 6),
        sourceOrdinals: [seerClaim.sourcePublicOrdinal, ...checks.map((check) => check.sourcePublicOrdinal)].filter((value): value is number => value !== null).slice(0, 12),
        wolfLeanBps: supported ? -180 : 260,
        confidenceBps: supported ? 3_800 : 2_800,
        favoredRoleIds: supported ? ["SEER"] : [],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: supported ? 1 : 0,
        rationaleCode: supported ? "SEER_BEHAVIOR_HAS_CHECK_OUTPUT" : "SEER_CLAIM_HAS_NO_CHECK_OUTPUT_YET",
      });
    }
  }

  const roleGroups = new Map<string, NpcClaim[]>();
  for (const claim of state.claimLedger) {
    if (claim.claimType !== "ROLE_CLAIM" || claim.roleId === null || claim.sourcePublicOrdinal === null) continue;
    roleGroups.set(claim.roleId, [...(roleGroups.get(claim.roleId) ?? []), claim]);
  }
  for (const [roleId, claims] of roleGroups) {
    const sorted = [...claims].sort((a, b) => (a.sourcePublicOrdinal ?? 0) - (b.sourcePublicOrdinal ?? 0));
    if (sorted.length < 2) continue;
    const first = sorted[0]!;
    for (const later of sorted.slice(1)) {
      if (later.sourcePlayerId === first.sourcePlayerId) continue;
      addEvidence(evidence, {
        layer: "TEMPORAL",
        code: "LATE_ROLE_COUNTERCLAIM",
        subjectPlayerId: later.sourcePlayerId,
        relatedPlayerIds: [first.sourcePlayerId],
        sourceOrdinals: [first.sourcePublicOrdinal!, later.sourcePublicOrdinal!],
        wolfLeanBps: roleId === "SEER" ? 320 : 180,
        confidenceBps: 2_500,
        favoredRoleIds: [],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: 0,
        rationaleCode: `LATER_${roleId}_CLAIM_REQUIRES_TIMING_EXPLANATION`,
      });
    }
  }

  const roleProofs = publicRoleProofs(state);
  const factionProofs = publicFactionProofs(state);
  for (const speech of speechMemories(state)) {
    const certainty = CERTAINTY_RE.test(speech.text);
    if (certainty) {
      const hiddenRolePatterns = [
        new RegExp(`(\\d{1,2})\\s*號[^，。,.!！?？]{0,14}?(?:一定|絕對|绝对|肯定|鐵|铁)[^，。,.!！?？]{0,6}?(${ROLE_TOKEN})`, "u"),
        new RegExp(`(?:一定|絕對|绝对|肯定|鐵|铁)[^，。,.!！?？]{0,6}?(?:認為|认为|是)?\\s*(\\d{1,2})\\s*號[^，。,.!！?？]{0,8}?(${ROLE_TOKEN})`, "u"),
      ];
      for (const pattern of hiddenRolePatterns) {
        const match = speech.text.match(pattern);
        if (!match?.[1] || !match[2]) continue;
        const targetPlayerId = playerIdForSeat(state, match[1]);
        const roleId = roleFromText(match[2]);
        if (!targetPlayerId || !roleId || roleProofs.get(targetPlayerId) === roleId) continue;
        addEvidence(evidence, {
          layer: "INFORMATION",
          code: "HIDDEN_ROLE_OVERREACH",
          subjectPlayerId: speech.speakerPlayerId,
          relatedPlayerIds: [targetPlayerId],
          sourceOrdinals: [speech.ordinal],
          wolfLeanBps: WOLF_ROLES.has(roleId) ? 220 : 360,
          confidenceBps: 3_400,
          favoredRoleIds: [],
          disfavoredRoleIds: [],
          assumptionCostIfIgnored: 0,
          rationaleCode: "HIGH_CERTAINTY_HIDDEN_ROLE_READ_WITHOUT_PUBLIC_ROLE_PROOF",
        });
        break;
      }
    }

    const knifeMatch = speech.text.match(/(?:昨晚|今晚)[^，。,.!！?？]{0,12}?(?:刀口|刀的是|被刀|狼刀)[^0-9]{0,8}(\d{1,2})\s*號/u);
    if (knifeMatch?.[1]) {
      const targetPlayerId = playerIdForSeat(state, knifeMatch[1]);
      if (targetPlayerId) addEvidence(evidence, {
        layer: "INFORMATION",
        code: "KNIFE_INFO_CLAIM",
        subjectPlayerId: speech.speakerPlayerId,
        relatedPlayerIds: [targetPlayerId],
        sourceOrdinals: [speech.ordinal],
        wolfLeanBps: 0,
        confidenceBps: 3_000,
        favoredRoleIds: ["WITCH", "WEREWOLF", "WOLF_BEAUTY"],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: 1,
        rationaleCode: "SPEAKER_CLAIMS_KNOWLEDGE_OF_NIGHT_KNIFE_TARGET",
      });
    }
  }

  for (const claim of state.claimLedger) {
    if (claim.claimType !== "ALIGNMENT_READ" || claim.targetPlayerId === null || claim.alignment === null || claim.sourcePublicOrdinal === null) continue;
    if (!CERTAINTY_RE.test(claim.statement)) continue;
    const publiclyProven = factionProofs.get(claim.targetPlayerId) === claim.alignment;
    const speakerHasCheck = state.claimLedger.some((other) => other.sourcePlayerId === claim.sourcePlayerId && other.claimType === "CHECK_RESULT" && other.targetPlayerId === claim.targetPlayerId && other.alignment === claim.alignment && other.sourcePublicOrdinal !== null && other.sourcePublicOrdinal <= claim.sourcePublicOrdinal!);
    if (publiclyProven || speakerHasCheck) continue;
    addEvidence(evidence, {
      layer: "INFORMATION",
      code: "EXCESS_CERTAINTY",
      subjectPlayerId: claim.sourcePlayerId,
      relatedPlayerIds: [claim.targetPlayerId],
      sourceOrdinals: [claim.sourcePublicOrdinal],
      wolfLeanBps: 260,
      confidenceBps: 2_800,
      favoredRoleIds: [],
      disfavoredRoleIds: [],
      assumptionCostIfIgnored: 0,
      rationaleCode: "CERTAINTY_EXCEEDS_VISIBLE_SUPPORT",
    });
  }
}

function triggerOrdinalsBetween(state: NpcCognitiveState, fromOrdinal: number, toOrdinal: number, targetPlayerId: string): { strong: number[]; weak: number[] } {
  const strong: number[] = [];
  const weak: number[] = [];
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC") continue;
    const observation = memory.observation;
    if (observation.ordinal <= fromOrdinal || observation.ordinal >= toOrdinal) continue;
    if (observation.type === "SELF_EXPLOSION" && observation.playerId === targetPlayerId) strong.push(observation.ordinal);
    else if (observation.type === "HUNTER_SHOT" && (observation.hunterPlayerId === targetPlayerId || observation.targetPlayerId === targetPlayerId)) strong.push(observation.ordinal);
    else if (observation.type === "VOTE_RESULT" || observation.type === "DAWN" || observation.type === "DEATHS_REVEALED" || observation.type === "SHERIFF_ELECTED") weak.push(observation.ordinal);
  }
  for (const claim of state.claimLedger) {
    if (claim.sourcePublicOrdinal === null || claim.sourcePublicOrdinal <= fromOrdinal || claim.sourcePublicOrdinal >= toOrdinal) continue;
    if (claim.claimType === "CHECK_RESULT" && claim.targetPlayerId === targetPlayerId) strong.push(claim.sourcePublicOrdinal);
    else if (claim.claimType === "ALIGNMENT_READ" && claim.targetPlayerId === targetPlayerId) weak.push(claim.sourcePublicOrdinal);
  }
  return { strong: [...new Set(strong)].sort((a, b) => a - b), weak: [...new Set(weak)].sort((a, b) => a - b) };
}

function temporalEvidence(state: NpcCognitiveState, evidence: NpcAdvancedEvidence[], transitions: NpcTemporalTransition[]): void {
  const reads = state.claimLedger.filter((claim) => claim.claimType === "ALIGNMENT_READ" && claim.targetPlayerId !== null && claim.alignment !== null && claim.sourcePublicOrdinal !== null);
  const groups = new Map<string, NpcClaim[]>();
  for (const claim of reads) groups.set(`${claim.sourcePlayerId}|${claim.targetPlayerId}`, [...(groups.get(`${claim.sourcePlayerId}|${claim.targetPlayerId}`) ?? []), claim]);
  for (const claims of groups.values()) {
    const sorted = [...claims].sort((a, b) => a.sourcePublicOrdinal! - b.sourcePublicOrdinal!);
    for (let index = 1; index < sorted.length; index += 1) {
      const before = sorted[index - 1]!;
      const after = sorted[index]!;
      if (before.alignment === after.alignment) continue;
      const triggers = triggerOrdinalsBetween(state, before.sourcePublicOrdinal!, after.sourcePublicOrdinal!, before.targetPlayerId!);
      const assessment = triggers.strong.length > 0 ? "EXPLAINED" : triggers.weak.length > 0 ? "PARTIALLY_EXPLAINED" : "UNEXPLAINED";
      transitions.push(NpcTemporalTransitionSchema.parse({
        transitionId: `T:${String(transitions.length + 1).padStart(3, "0")}`,
        sourcePlayerId: before.sourcePlayerId,
        targetPlayerId: before.targetPlayerId,
        fromAlignment: before.alignment,
        toAlignment: after.alignment,
        fromOrdinal: before.sourcePublicOrdinal,
        toOrdinal: after.sourcePublicOrdinal,
        triggerOrdinals: [...triggers.strong, ...triggers.weak].sort((a, b) => a - b),
        assessment,
      }));
      const scaled = personaScale(assessment === "UNEXPLAINED" ? 520 : assessment === "PARTIALLY_EXPLAINED" ? 120 : -100, state.persona.consistencyBias);
      addEvidence(evidence, {
        layer: "TEMPORAL",
        code: assessment === "UNEXPLAINED" ? "UNEXPLAINED_STANCE_SHIFT" : "EXPLAINED_STANCE_SHIFT",
        subjectPlayerId: before.sourcePlayerId,
        relatedPlayerIds: [before.targetPlayerId!],
        sourceOrdinals: [before.sourcePublicOrdinal!, ...triggers.strong, ...triggers.weak, after.sourcePublicOrdinal!].slice(0, 12),
        wolfLeanBps: scaled,
        confidenceBps: assessment === "UNEXPLAINED" ? 4_200 : assessment === "PARTIALLY_EXPLAINED" ? 2_200 : 3_200,
        favoredRoleIds: [],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: assessment === "UNEXPLAINED" ? 1 : 0,
        rationaleCode: assessment === "UNEXPLAINED" ? "STANCE_REVERSED_WITHOUT_INTERVENING_SUPPORT" : "STANCE_REVERSED_AFTER_NEW_INFORMATION",
      });
    }
  }
}

function deathOrdinals(state: NpcCognitiveState): Map<string, number> {
  const result = new Map<string, number>();
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC") continue;
    const observation = memory.observation;
    const ids = observation.type === "DAWN" ? observation.deadPlayerIds : observation.type === "DEATHS_REVEALED" ? observation.playerIds : [];
    for (const playerId of ids) if (!result.has(playerId)) result.set(playerId, observation.ordinal);
  }
  return result;
}

function utilityEvidence(state: NpcCognitiveState, evidence: NpcAdvancedEvidence[]): void {
  const deaths = deathOrdinals(state);
  for (const [deadPlayerId, deathOrdinal] of deaths) {
    for (const claim of state.claimLedger) {
      if (claim.sourcePlayerId !== deadPlayerId || claim.claimType !== "ALIGNMENT_READ" || claim.alignment !== "WOLF" || claim.targetPlayerId === null || claim.sourcePublicOrdinal === null || claim.sourcePublicOrdinal >= deathOrdinal) continue;
      addEvidence(evidence, {
        layer: "UTILITY",
        code: "DEATH_REMOVES_ACCUSER",
        subjectPlayerId: claim.targetPlayerId,
        relatedPlayerIds: [deadPlayerId],
        sourceOrdinals: [claim.sourcePublicOrdinal, deathOrdinal],
        wolfLeanBps: 120,
        confidenceBps: 1_800,
        favoredRoleIds: [],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: 0,
        rationaleCode: "DEAD_CRITIC_REMOVAL_BENEFITS_TARGET_BUT_FRAMING_REMAINS_PLAUSIBLE",
      });
    }
  }

  const knownWolves = new Set(state.beliefs.filter((belief) => belief.knownFaction === "WOLF").map((belief) => belief.playerId));
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC" || memory.observation.type !== "VOTE_RESULT") continue;
    const vote = memory.observation;
    if (vote.voteKind !== "DAY" && vote.voteKind !== "DAY_PK") continue;
    for (const ballot of vote.ballots) {
      if (ballot.targetPlayerId === null || !knownWolves.has(ballot.targetPlayerId)) continue;
      const pressureSources = new Set(state.claimLedger.filter((claim) => claim.sourcePublicOrdinal !== null && claim.sourcePublicOrdinal < vote.ordinal && claim.sourcePlayerId !== ballot.voterPlayerId && claim.targetPlayerId === ballot.targetPlayerId && claim.alignment === "WOLF" && (claim.claimType === "ALIGNMENT_READ" || claim.claimType === "CHECK_RESULT")).map((claim) => claim.sourcePlayerId));
      if (pressureSources.size < 2) continue;
      addEvidence(evidence, {
        layer: "UTILITY",
        code: "BUSSING_PLAUSIBLE",
        subjectPlayerId: ballot.voterPlayerId,
        relatedPlayerIds: [ballot.targetPlayerId],
        sourceOrdinals: [vote.ordinal],
        wolfLeanBps: 180,
        confidenceBps: 2_400,
        favoredRoleIds: [],
        disfavoredRoleIds: [],
        assumptionCostIfIgnored: 0,
        rationaleCode: "VOTING_AN_ALREADY_COLLAPSING_WOLF_CAN_BUY_GOOD_CREDIT",
      });
    }
  }
}

/** Builds soft evidence only. Nothing returned here is allowed to become SYSTEM_TRUTH. */
export function buildAdvancedSignals(state: NpcCognitiveState): { evidence: NpcAdvancedEvidence[]; temporalTransitions: NpcTemporalTransition[] } {
  const evidence: NpcAdvancedEvidence[] = [];
  const temporalTransitions: NpcTemporalTransition[] = [];
  identityAndInformationEvidence(state, evidence);
  temporalEvidence(state, evidence, temporalTransitions);
  utilityEvidence(state, evidence);
  return { evidence: evidence.slice(0, 128), temporalTransitions: temporalTransitions.slice(0, 64) };
}
