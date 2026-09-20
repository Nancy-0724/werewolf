import { CoreError } from "../domain/errors.js";
import { cloneJson } from "../domain/json.js";
import { AbilityDefinitionSchema, type AbilityDefinition, type RoleDefinition, type RulesetSnapshot } from "../domain/schemas.js";
import { supportedRulesetSnapshot } from "./wb12.js";

const ABILITIES: readonly AbilityDefinition[] = [
  {
    abilityId: "WOLF_CHAT",
    abilityVersion: "1.0.0",
    ownerKind: "TEAM",
    activationWindow: "NIGHT_WOLF_CHAT",
    triggerKind: "ACTIVE",
    targetPolicyId: "WOLF_TEAM_MEMBERS",
    resourcePolicyId: "UNLIMITED_PER_WINDOW",
    effectHandlerId: "wolf.chat.v1",
    informationPolicyId: "ALIVE_WOLF_TEAM_PRIVATE",
    supportedRuleOptions: [],
  },
  {
    abilityId: "WOLF_KILL",
    abilityVersion: "1.0.0",
    ownerKind: "TEAM",
    activationWindow: "NIGHT_WOLF",
    triggerKind: "ACTIVE",
    targetPolicyId: "ANY_NIGHT_START_ALIVE_OR_PASS",
    resourcePolicyId: "ONE_BALLOT_PER_ELIGIBLE_WOLF_PER_NIGHT",
    effectHandlerId: "wolf.kill.vote.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["ballotChangeAfterCommit"],
  },
  {
    abilityId: "SELF_EXPLODE",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "DAY_SELF_EXPLOSION_WINDOWS",
    triggerKind: "ACTIVE",
    targetPolicyId: "SELF_ONLY",
    resourcePolicyId: "ONCE_WHILE_ALIVE",
    effectHandlerId: "wolf.selfExplode.v1",
    informationPolicyId: "PUBLIC_ON_COMMIT",
    supportedRuleOptions: ["beautyCanSelfExplode"],
  },
  {
    abilityId: "CHARM",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_BEAUTY",
    triggerKind: "ACTIVE",
    targetPolicyId: "OTHER_NIGHT_START_ALIVE_OR_KEEP",
    resourcePolicyId: "ONCE_PER_NIGHT",
    effectHandlerId: "beauty.charm.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["beautyCanCharmSelf", "beautyCanCharmWolf", "beautyCanRepeatTarget", "beautyPassKeepsPrevious"],
  },
  {
    abilityId: "CHARM_DEATH_LINK",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "DEATH_RESOLUTION",
    triggerKind: "PASSIVE",
    targetPolicyId: "ACTIVE_CHARM_TARGET",
    resourcePolicyId: "PASSIVE",
    effectHandlerId: "beauty.deathLink.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["beautyDeathTriggersCharm"],
  },
  {
    abilityId: "SEER_CHECK",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_SEER",
    triggerKind: "ACTIVE",
    targetPolicyId: "OTHER_NIGHT_START_ALIVE_OR_PASS",
    resourcePolicyId: "ONCE_PER_NIGHT",
    effectHandlerId: "seer.check.v1",
    informationPolicyId: "PRIVATE_OWNER",
    supportedRuleOptions: [],
  },
  {
    abilityId: "WITCH_KNIFE_INFO",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_WITCH_INFO",
    triggerKind: "PASSIVE",
    targetPolicyId: "LOCKED_WOLF_TARGET",
    resourcePolicyId: "HEAL_REMAINING_GATES_INFO",
    effectHandlerId: "witch.knifeInfo.v1",
    informationPolicyId: "PRIVATE_OWNER",
    supportedRuleOptions: ["witchKnifeInfoMode"],
  },
  {
    abilityId: "WITCH_HEAL",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_WITCH",
    triggerKind: "ACTIVE",
    targetPolicyId: "LOCKED_WOLF_TARGET",
    resourcePolicyId: "ONE_PER_GAME_SHARED_NIGHT_ACTION",
    effectHandlerId: "witch.heal.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["witchFirstNightSelfSave", "witchCanUseBothPotions"],
  },
  {
    abilityId: "WITCH_POISON",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_WITCH",
    triggerKind: "ACTIVE",
    targetPolicyId: "OTHER_NIGHT_START_ALIVE",
    resourcePolicyId: "ONE_PER_GAME_SHARED_NIGHT_ACTION",
    effectHandlerId: "witch.poison.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["witchCanUseBothPotions", "witchCanPoisonSelf"],
  },
  {
    abilityId: "HUNTER_SHOT",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "DEATH_REACTION",
    triggerKind: "ACTIVE",
    targetPolicyId: "OTHER_CURRENTLY_ALIVE_OR_PASS",
    resourcePolicyId: "ONE_PER_GAME_IF_ELIGIBLE",
    effectHandlerId: "hunter.shot.v1",
    informationPolicyId: "PUBLIC_ON_SHOT",
    supportedRuleOptions: ["hunterPoisonCanShoot", "hunterCharmCanShoot"],
  },
  {
    abilityId: "GUARD_PROTECT",
    abilityVersion: "1.0.0",
    ownerKind: "PLAYER",
    activationWindow: "NIGHT_GUARD",
    triggerKind: "ACTIVE",
    targetPolicyId: "NIGHT_START_ALIVE_OR_PASS",
    resourcePolicyId: "ONCE_PER_NIGHT_WITH_CONSECUTIVE_TARGET_RULE",
    effectHandlerId: "guard.protect.v1",
    informationPolicyId: "SYSTEM_TRUTH",
    supportedRuleOptions: ["guardCanSelfGuard", "guardCanRepeatSameTarget", "guardHealCollision"],
  },
].map((definition) => AbilityDefinitionSchema.parse(definition));

const ABILITY_BY_ID = new Map(ABILITIES.map((definition) => [definition.abilityId, definition]));
const HANDLER_IDS = new Set(ABILITIES.map((definition) => definition.effectHandlerId));

export interface RulesRegistrySnapshot {
  roles: RoleDefinition[];
  abilities: AbilityDefinition[];
  handlerIds: string[];
}

export function registrySnapshot(): RulesRegistrySnapshot {
  return {
    roles: cloneJson(supportedRulesetSnapshot().roleDefinitions),
    abilities: cloneJson([...ABILITIES]),
    handlerIds: [...HANDLER_IDS].sort(),
  };
}

export function getRegisteredRole(roleId: string): RoleDefinition {
  const role = supportedRulesetSnapshot().roleDefinitions.find((entry) => entry.roleId === roleId);
  if (role === undefined) throw new CoreError("UNSUPPORTED_RULESET", `Unknown registered roleId: ${roleId}`);
  return cloneJson(role);
}

export function getRegisteredAbility(abilityId: string): AbilityDefinition {
  const ability = ABILITY_BY_ID.get(abilityId);
  if (ability === undefined) throw new CoreError("UNSUPPORTED_RULESET", `Unknown registered abilityId: ${abilityId}`);
  return cloneJson(ability);
}

export function assertRegisteredHandler(handlerId: string): void {
  if (!HANDLER_IDS.has(handlerId)) throw new CoreError("UNSUPPORTED_RULESET", `Unknown handlerId: ${handlerId}`);
}

export function assertRulesetRegistryCompatible(ruleset: RulesetSnapshot): void {
  const registered = supportedRulesetSnapshot();
  const roleById = new Map(registered.roleDefinitions.map((role) => [role.roleId, role]));
  const versionByAbility = new Map(ruleset.abilityVersions.map((entry) => [entry.abilityId, entry.version]));

  for (const role of ruleset.roleDefinitions) {
    const known = roleById.get(role.roleId);
    if (known === undefined || known.roleVersion !== role.roleVersion) {
      throw new CoreError("UNSUPPORTED_RULESET", `Unregistered role/version: ${role.roleId}@${role.roleVersion}`);
    }
    for (const abilityId of role.abilityRefs) {
      const ability = ABILITY_BY_ID.get(abilityId);
      if (ability === undefined) throw new CoreError("UNSUPPORTED_RULESET", `Role ${role.roleId} references unknown ability ${abilityId}`);
      if (versionByAbility.get(abilityId) !== ability.abilityVersion) {
        throw new CoreError("UNSUPPORTED_RULESET", `Ability version mismatch for ${abilityId}`);
      }
      assertRegisteredHandler(ability.effectHandlerId);
      for (const optionName of ability.supportedRuleOptions) {
        if (!(optionName in ruleset.options)) throw new CoreError("UNSUPPORTED_RULESET", `Ability ${abilityId} requires unsupported option ${optionName}`);
      }
    }
  }

  for (const version of ruleset.abilityVersions) {
    const ability = ABILITY_BY_ID.get(version.abilityId);
    if (ability === undefined || ability.abilityVersion !== version.version) {
      throw new CoreError("UNSUPPORTED_RULESET", `Unregistered ability/version: ${version.abilityId}@${version.version}`);
    }
  }
}
