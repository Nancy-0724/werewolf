import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { RulesetSnapshotSchema, SeatSchema, type RulesetSnapshot, type Seat } from "../domain/schemas.js";

const WB12_RULESET: RulesetSnapshot = {
  rulesetId: "wolf-beauty-12.app",
  rulesetVersion: "1.0.0",
  engineContractVersion: "1.0.0",
  roleDefinitions: [
    { roleId: "WEREWOLF", roleVersion: "1.0.0", displayName: "普通狼人", factionId: "WOLF", victoryBucket: "WOLF", abilityRefs: ["WOLF_CHAT", "WOLF_KILL", "SELF_EXPLODE"], initialKnowledgePolicyId: "WOLF_TEAM_WITH_SPECIAL_ROLE" },
    { roleId: "WOLF_BEAUTY", roleVersion: "1.0.0", displayName: "狼美人", factionId: "WOLF", victoryBucket: "WOLF", abilityRefs: ["WOLF_CHAT", "WOLF_KILL", "SELF_EXPLODE", "CHARM", "CHARM_DEATH_LINK"], initialKnowledgePolicyId: "WOLF_TEAM_WITH_SPECIAL_ROLE" },
    { roleId: "SEER", roleVersion: "1.0.0", displayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", abilityRefs: ["SEER_CHECK"], initialKnowledgePolicyId: "SELF_ROLE_ONLY" },
    { roleId: "WITCH", roleVersion: "1.0.0", displayName: "女巫", factionId: "GOOD", victoryBucket: "GOD", abilityRefs: ["WITCH_KNIFE_INFO", "WITCH_HEAL", "WITCH_POISON"], initialKnowledgePolicyId: "SELF_ROLE_ONLY" },
    { roleId: "HUNTER", roleVersion: "1.0.0", displayName: "獵人", factionId: "GOOD", victoryBucket: "GOD", abilityRefs: ["HUNTER_SHOT"], initialKnowledgePolicyId: "SELF_ROLE_ONLY" },
    { roleId: "GUARD", roleVersion: "1.0.0", displayName: "守衛", factionId: "GOOD", victoryBucket: "GOD", abilityRefs: ["GUARD_PROTECT"], initialKnowledgePolicyId: "SELF_ROLE_ONLY" },
    { roleId: "VILLAGER", roleVersion: "1.0.0", displayName: "平民", factionId: "GOOD", victoryBucket: "VILLAGER", abilityRefs: [], initialKnowledgePolicyId: "SELF_ROLE_ONLY" }
  ],
  roleCounts: [
    { roleId: "WEREWOLF", count: 3 },
    { roleId: "WOLF_BEAUTY", count: 1 },
    { roleId: "SEER", count: 1 },
    { roleId: "WITCH", count: 1 },
    { roleId: "HUNTER", count: 1 },
    { roleId: "GUARD", count: 1 },
    { roleId: "VILLAGER", count: 4 }
  ],
  abilityVersions: [
    "WOLF_CHAT", "WOLF_KILL", "SELF_EXPLODE", "CHARM", "CHARM_DEATH_LINK", "SEER_CHECK", "WITCH_KNIFE_INFO", "WITCH_HEAL", "WITCH_POISON", "HUNTER_SHOT", "GUARD_PROTECT"
  ].map((abilityId) => ({ abilityId, version: "1.0.0" })),
  options: {
    sheriffEnabled: true,
    sheriffVoters: "ORIGINAL_NON_CANDIDATES",
    sheriffWithdrawalGrantsVote: false,
    ordinaryVoteUnits: 2,
    sheriffDayVoteUnits: 3,
    maxPkRounds: 1,
    ballotChangeAfterCommit: false,
    witchKnifeInfoMode: "WHILE_HEAL_REMAINS",
    witchFirstNightSelfSave: true,
    witchCanUseBothPotions: false,
    witchCanPoisonSelf: false,
    guardCanSelfGuard: true,
    guardCanRepeatSameTarget: false,
    guardHealCollision: "KILL",
    beautyCanCharmSelf: false,
    beautyCanCharmWolf: true,
    beautyCanRepeatTarget: true,
    beautyPassKeepsPrevious: true,
    beautyCanSelfExplode: true,
    beautyDeathTriggersCharm: "ALL_DEATHS",
    hunterPoisonCanShoot: false,
    hunterCharmCanShoot: false,
    winCondition: "ELIMINATE_SIDE",
    winCheckpoint: "RESOLUTION_GROUP_SETTLED",
    simultaneousWin: "DRAW",
    ruleDetailsVersion: "WB12_APP_1"
  }
};

function normalizedCatalog(snapshot: RulesetSnapshot): RulesetSnapshot {
  const copy = cloneJson(snapshot);
  copy.roleDefinitions.sort((a, b) => a.roleId.localeCompare(b.roleId));
  for (const role of copy.roleDefinitions) role.abilityRefs.sort();
  copy.roleCounts.sort((a, b) => a.roleId.localeCompare(b.roleId));
  copy.abilityVersions.sort((a, b) => a.abilityId.localeCompare(b.abilityId));
  return copy;
}

export function supportedRulesetSnapshot(): RulesetSnapshot {
  return cloneJson(WB12_RULESET);
}

export function assertSupportedRuleset(input: unknown): RulesetSnapshot {
  const parsed = RulesetSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("UNSUPPORTED_RULESET", parsed.error.message);
  if (stableStringify(normalizedCatalog(parsed.data)) !== stableStringify(normalizedCatalog(WB12_RULESET))) {
    throw new CoreError("UNSUPPORTED_RULESET", "A-02 supports only wolf-beauty-12.app v1.0.0 exact snapshot");
  }
  return cloneJson(WB12_RULESET);
}

export function validateSeats(input: unknown): Seat[] {
  if (!Array.isArray(input) || input.length !== 12) throw new CoreError("INVALID_SEATS", "Exactly 12 seats are required");
  const seats: Seat[] = [];
  for (const item of input) {
    const result = SeatSchema.safeParse(item);
    if (!result.success) throw new CoreError("INVALID_SEATS", result.error.message);
    seats.push(result.data);
  }
  const playerIds = new Set(seats.map((seat) => seat.playerId));
  const seatNumbers = new Set(seats.map((seat) => seat.seatNumber));
  if (playerIds.size !== 12 || seatNumbers.size !== 12) throw new CoreError("INVALID_SEATS", "playerId and seatNumber must be unique");
  for (let n = 1; n <= 12; n += 1) if (!seatNumbers.has(n)) throw new CoreError("INVALID_SEATS", "seatNumber must cover 1..12");
  return cloneJson(seats.sort((a, b) => a.seatNumber - b.seatNumber));
}

