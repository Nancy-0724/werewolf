import * as z from "zod";
import { CoreError } from "./errors.js";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });
const DisplayName = z.string().trim().min(1);
const IsoUtcString = z.iso.datetime({ offset: true }).refine((value) => value.endsWith("Z"), { message: "UTC ISO timestamp ending in Z required" });
const NullOnly = z.null();

export const ControllerTypeSchema = z.enum(["HUMAN", "NPC"]);
export const SeatSchema = z.object({
  playerId: NonEmptyString,
  seatNumber: z.number().int().min(1).max(12),
  displayName: DisplayName,
  controllerType: ControllerTypeSchema,
}).strict();
export type Seat = z.infer<typeof SeatSchema>;

export const RoleDefinitionSchema = z.object({
  roleId: NonEmptyString,
  roleVersion: NonEmptyString,
  displayName: DisplayName,
  factionId: z.enum(["WOLF", "GOOD"]),
  victoryBucket: z.enum(["WOLF", "GOD", "VILLAGER"]),
  abilityRefs: z.array(NonEmptyString),
  initialKnowledgePolicyId: NonEmptyString,
}).strict();
export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export const AbilityDefinitionSchema = z.object({
  abilityId: NonEmptyString,
  abilityVersion: NonEmptyString,
  ownerKind: z.enum(["PLAYER", "TEAM"]),
  activationWindow: NonEmptyString,
  triggerKind: z.enum(["ACTIVE", "PASSIVE"]),
  targetPolicyId: NonEmptyString,
  resourcePolicyId: NonEmptyString,
  effectHandlerId: NonEmptyString,
  informationPolicyId: NonEmptyString,
  supportedRuleOptions: z.array(NonEmptyString),
}).strict();
export type AbilityDefinition = z.infer<typeof AbilityDefinitionSchema>;

export const RoleCountSchema = z.object({
  roleId: NonEmptyString,
  count: z.number().int().positive(),
}).strict();

export const AbilityVersionSchema = z.object({
  abilityId: NonEmptyString,
  version: NonEmptyString,
}).strict();

export const RulesetOptionsSchema = z.object({
  sheriffEnabled: z.literal(true),
  sheriffVoters: z.literal("ORIGINAL_NON_CANDIDATES"),
  sheriffWithdrawalGrantsVote: z.literal(false),
  ordinaryVoteUnits: z.literal(2),
  sheriffDayVoteUnits: z.literal(3),
  maxPkRounds: z.literal(1),
  ballotChangeAfterCommit: z.literal(false),
  witchKnifeInfoMode: z.literal("WHILE_HEAL_REMAINS"),
  witchFirstNightSelfSave: z.literal(true),
  witchCanUseBothPotions: z.literal(false),
  witchCanPoisonSelf: z.literal(false),
  guardCanSelfGuard: z.literal(true),
  guardCanRepeatSameTarget: z.literal(false),
  guardHealCollision: z.literal("KILL"),
  beautyCanCharmSelf: z.literal(false),
  beautyCanCharmWolf: z.literal(true),
  beautyCanRepeatTarget: z.literal(true),
  beautyPassKeepsPrevious: z.literal(true),
  beautyCanSelfExplode: z.literal(true),
  beautyDeathTriggersCharm: z.literal("ALL_DEATHS"),
  hunterPoisonCanShoot: z.literal(false),
  hunterCharmCanShoot: z.literal(false),
  winCondition: z.literal("ELIMINATE_SIDE"),
  winCheckpoint: z.literal("RESOLUTION_GROUP_SETTLED"),
  simultaneousWin: z.literal("DRAW"),
  ruleDetailsVersion: z.literal("WB12_APP_1"),
}).strict();

export const RulesetSnapshotSchema = z.object({
  rulesetId: NonEmptyString,
  rulesetVersion: NonEmptyString,
  engineContractVersion: NonEmptyString,
  roleDefinitions: z.array(RoleDefinitionSchema).length(7),
  roleCounts: z.array(RoleCountSchema).length(7),
  abilityVersions: z.array(AbilityVersionSchema).length(11),
  options: RulesetOptionsSchema,
}).strict();
export type RulesetSnapshot = z.infer<typeof RulesetSnapshotSchema>;

export const GameManifestSchema = z.object({
  gameId: NonEmptyString,
  dataSchemaVersion: z.literal("1.0.0"),
  engineContractVersion: z.literal("1.0.0"),
  engineBuildId: NonEmptyString,
  createdAtIso: IsoUtcString,
  lockedAtIso: IsoUtcString,
  seatsSnapshot: z.array(SeatSchema).length(12),
  rulesetSnapshot: RulesetSnapshotSchema,
}).strict();
export type GameManifest = z.infer<typeof GameManifestSchema>;

export const RoleAssignmentSchema = z.object({
  playerId: NonEmptyString,
  assignedRoleId: NonEmptyString,
  assignedFactionId: z.enum(["WOLF", "GOOD"]),
  victoryBucket: z.enum(["WOLF", "GOD", "VILLAGER"]),
  assignedAtSequence: z.number().int().positive(),
}).strict();
export type RoleAssignment = z.infer<typeof RoleAssignmentSchema>;

export const LockedSetupSchema = z.object({
  assignments: z.array(RoleAssignmentSchema).length(12),
  assignmentAudit: z.object({
    randomAlgorithmId: NonEmptyString,
    privateSeed: z.string().min(1).nullable(),
  }).strict(),
}).strict();
export type LockedSetup = z.infer<typeof LockedSetupSchema>;

export const LobbySchema = z.object({
  seats: z.array(SeatSchema),
  rulesetDraft: RulesetSnapshotSchema,
}).strict();

export const PlayerRuntimeSchema = z.object({
  playerId: NonEmptyString,
  lifeState: z.enum(["ALIVE", "DEAD"]),
  deathRecordId: NonEmptyString.nullable(),
  effectiveRoleId: NonEmptyString,
  effectiveFactionId: z.enum(["WOLF", "GOOD"]),
}).strict();
export type PlayerRuntime = z.infer<typeof PlayerRuntimeSchema>;

export const WitchAbilityStateSchema = z.object({
  kind: z.literal("WITCH"),
  ownerPlayerId: NonEmptyString,
  healRemaining: z.union([z.literal(0), z.literal(1)]),
  poisonRemaining: z.union([z.literal(0), z.literal(1)]),
  lastActionNight: z.number().int().positive().nullable(),
}).strict();
export const GuardAbilityStateSchema = z.object({
  kind: z.literal("GUARD"),
  ownerPlayerId: NonEmptyString,
  lastNightNumber: z.number().int().positive().nullable(),
  lastTargetPlayerId: NonEmptyString.nullable(),
}).strict();
export const BeautyAbilityStateSchema = z.object({
  kind: z.literal("BEAUTY"),
  ownerPlayerId: NonEmptyString,
  activeCharmStatusId: NonEmptyString.nullable(),
  lastCharmNight: z.number().int().positive().nullable(),
}).strict();
export const HunterAbilityStateSchema = z.object({
  kind: z.literal("HUNTER"),
  ownerPlayerId: NonEmptyString,
  shotRemaining: z.union([z.literal(0), z.literal(1)]),
  reactionStatus: z.enum(["NOT_AVAILABLE", "PENDING", "COMMITTED", "FORFEITED"]),
}).strict();
export const SeerAbilityStateSchema = z.object({
  kind: z.literal("SEER"),
  ownerPlayerId: NonEmptyString,
  lastActionNight: z.number().int().positive().nullable(),
}).strict();
export const WolfTeamBallotSchema = z.object({
  voterPlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString.nullable(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export const WolfTeamAbilityStateSchema = z.object({
  kind: z.literal("WOLF_TEAM"),
  ownerTeamId: z.literal("WOLF"),
  nightNumber: z.number().int().positive(),
  ballots: z.array(WolfTeamBallotSchema),
  knifeTargetStatus: z.enum(["UNRESOLVED", "LOCKED"]),
  knifeTargetPlayerId: NonEmptyString.nullable(),
}).strict();
export const AbilityStateSchema = z.discriminatedUnion("kind", [
  WitchAbilityStateSchema,
  GuardAbilityStateSchema,
  BeautyAbilityStateSchema,
  HunterAbilityStateSchema,
  SeerAbilityStateSchema,
  WolfTeamAbilityStateSchema,
]);
export type AbilityState = z.infer<typeof AbilityStateSchema>;

export const PhaseTypeSchema = z.enum([
  "NIGHT_GUARD",
  "NIGHT_WOLF",
  "NIGHT_BEAUTY",
  "NIGHT_WITCH",
  "NIGHT_SEER",
  "NIGHT_READY_FOR_RESOLUTION",
  "NIGHT_RESOLUTION",
  "DAWN_HUNTER_REACTION",
  "DAWN_READY_FOR_DAY",
  "LAST_WORDS",
  "SHERIFF_SIGNUP",
  "SHERIFF_SPEECH",
  "SHERIFF_WITHDRAWAL",
  "SHERIFF_VOTE",
  "SHERIFF_PK_SPEECH",
  "SHERIFF_PK_VOTE",
  "DAY_ORDER_SELECTION",
  "DAY_DISCUSSION",
  "DAY_VOTE",
  "DAY_PK_SPEECH",
  "DAY_PK_VOTE",
  "DAY_RESOLUTION",
  "DAY_HUNTER_REACTION",
  "SHERIFF_BADGE_ACTION",
]);
export type PhaseType = z.infer<typeof PhaseTypeSchema>;

export const PhaseStateSchema = z.object({
  phaseId: NonEmptyString,
  phaseType: PhaseTypeSchema,
  roundNumber: z.number().int().positive(),
  openedAtSequence: z.number().int().positive(),
  status: z.enum(["OPEN", "CLOSED"]),
  continuation: z.enum(["NEXT_NIGHT", "DAY_DISCUSSION", "SHERIFF_ELECTION"]).nullable(),
}).strict();
export type PhaseState = z.infer<typeof PhaseStateSchema>;

export const ActionSessionSchema = z.object({
  sessionId: NonEmptyString,
  phaseId: NonEmptyString,
  eligibleActorsSnapshot: z.array(NonEmptyString),
  legalTargetsSnapshot: z.array(NonEmptyString),
  committedActors: z.array(NonEmptyString),
  status: z.enum(["OPEN", "CLOSED"]),
}).strict();
export type ActionSession = z.infer<typeof ActionSessionSchema>;

export const GuardNightIntentSchema = z.object({
  intentType: z.literal("GUARD"),
  actorPlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString.nullable(),
  nightNumber: z.number().int().positive(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export const BeautyNightIntentSchema = z.object({
  intentType: z.literal("BEAUTY"),
  actorPlayerId: NonEmptyString,
  mode: z.enum(["CHARM", "KEEP"]),
  targetPlayerId: NonEmptyString.nullable(),
  nightNumber: z.number().int().positive(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export const WitchNightIntentSchema = z.object({
  intentType: z.literal("WITCH"),
  actorPlayerId: NonEmptyString,
  action: z.enum(["PASS", "HEAL", "POISON"]),
  targetPlayerId: NonEmptyString.nullable(),
  nightNumber: z.number().int().positive(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export const SeerNightIntentSchema = z.object({
  intentType: z.literal("SEER"),
  actorPlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString.nullable(),
  nightNumber: z.number().int().positive(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export const NightIntentSchema = z.discriminatedUnion("intentType", [GuardNightIntentSchema, BeautyNightIntentSchema, WitchNightIntentSchema, SeerNightIntentSchema]);
export type NightIntent = z.infer<typeof NightIntentSchema>;

export const NightSessionStateSchema = z.object({
  nightNumber: z.number().int().positive(),
  nightStartAlivePlayerIds: z.array(NonEmptyString),
  currentActionSession: ActionSessionSchema.nullable(),
  intents: z.array(NightIntentSchema),
  status: z.enum(["COLLECTING", "READY_FOR_RESOLUTION"]),
}).strict();
export type NightSessionState = z.infer<typeof NightSessionStateSchema>;

export const StatusEffectSchema = z.object({
  statusId: NonEmptyString,
  type: z.enum(["PROTECTED", "CHARMED"]),
  sourcePlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString,
  appliedAtSequence: z.number().int().positive(),
  scope: z.enum(["NIGHT", "PERSISTENT"]),
  expirationPolicy: z.enum(["AT_NIGHT_END", "UNTIL_REPLACED", "UNTIL_SOURCE_OR_TARGET_DEATH"]),
  active: z.boolean(),
}).strict();


export const DeathCauseSchema = z.enum([
  "WEREWOLF_ATTACK",
  "WITCH_POISON",
  "VOTE_EXECUTION",
  "HUNTER_SHOT",
  "WOLF_BEAUTY_LINK",
  "GUARD_HEAL_COLLISION",
  "SELF_EXPLOSION",
]);
export type DeathCause = z.infer<typeof DeathCauseSchema>;

export const DeathRecordSchema = z.object({
  deathId: NonEmptyString,
  playerId: NonEmptyString,
  resolutionGroupId: NonEmptyString,
  waveId: NonEmptyString,
  round: z.number().int().positive(),
  causes: z.array(DeathCauseSchema).min(1),
  sourceEffectIds: z.array(NonEmptyString),
  deathEventSequence: z.number().int().positive(),
}).strict();
export type DeathRecord = z.infer<typeof DeathRecordSchema>;

export const ResolutionGroupStateSchema = z.object({
  resolutionGroupId: NonEmptyString,
  kind: z.enum(["NIGHT", "VOTE_EXECUTION", "SELF_EXPLOSION"]),
  round: z.number().int().positive(),
  status: z.enum(["RESOLVING", "WAITING_REACTIONS", "SETTLED"]),
  deathRecords: z.array(DeathRecordSchema),
}).strict();
export type ResolutionGroupState = z.infer<typeof ResolutionGroupStateSchema>;

export const PendingReactionSchema = z.object({
  reactionId: NonEmptyString,
  kind: z.literal("HUNTER_SHOT"),
  actorPlayerId: NonEmptyString,
  triggerDeathId: NonEmptyString,
  legalTargetsSnapshot: z.array(NonEmptyString),
  sessionId: NonEmptyString,
  status: z.enum(["OPEN", "COMMITTED", "FORFEITED"]),
}).strict();
export type PendingReaction = z.infer<typeof PendingReactionSchema>;

export const SheriffSignupSessionSchema = z.object({
  sessionId: NonEmptyString,
  eligiblePlayersSnapshot: z.array(NonEmptyString),
  committedPlayerIds: z.array(NonEmptyString),
  joinedPlayerIds: z.array(NonEmptyString),
  status: z.enum(["OPEN", "CLOSED"]),
}).strict();
export type SheriffSignupSession = z.infer<typeof SheriffSignupSessionSchema>;

export const SheriffWithdrawalSessionSchema = z.object({
  sessionId: NonEmptyString,
  candidatePlayersSnapshot: z.array(NonEmptyString),
  committedPlayerIds: z.array(NonEmptyString),
  withdrawnPlayerIds: z.array(NonEmptyString),
  status: z.enum(["OPEN", "CLOSED"]),
}).strict();
export type SheriffWithdrawalSession = z.infer<typeof SheriffWithdrawalSessionSchema>;

export const SheriffStateSchema = z.object({
  enabled: z.boolean(),
  holderPlayerId: NonEmptyString.nullable(),
  badgeStatus: z.enum(["UNASSIGNED", "ACTIVE", "NO_BADGE", "DESTROYED"]),
  electionAttempted: z.boolean(),
  electedAtSequence: z.number().int().positive().nullable(),
  candidatePlayerIds: z.array(NonEmptyString),
  withdrawnPlayerIds: z.array(NonEmptyString),
  originalVoterPlayerIds: z.array(NonEmptyString),
  signupSession: SheriffSignupSessionSchema.nullable(),
  withdrawalSession: SheriffWithdrawalSessionSchema.nullable(),
}).strict();

export const SpeechSourceSchema = z.enum(["HUMAN_TEXT", "HUMAN_TRANSCRIPT", "NPC_TEXT"]);
export type SpeechSource = z.infer<typeof SpeechSourceSchema>;
export const SpeechKindSchema = z.enum(["LAST_WORDS", "SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"]);
export type SpeechKind = z.infer<typeof SpeechKindSchema>;
export const SpeechSessionSchema = z.object({
  sessionId: NonEmptyString,
  phaseId: NonEmptyString,
  kind: SpeechKindSchema,
  speakerOrderSnapshot: z.array(NonEmptyString),
  completedSpeakers: z.array(NonEmptyString),
  status: z.enum(["OPEN", "CLOSED"]),
}).strict();
export type SpeechSession = z.infer<typeof SpeechSessionSchema>;

export const BallotSchema = z.object({
  voterPlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString.nullable(),
  committedAtSequence: z.number().int().positive(),
}).strict();
export type Ballot = z.infer<typeof BallotSchema>;
export const VoteKindSchema = z.enum(["SHERIFF", "SHERIFF_PK", "DAY", "DAY_PK"]);
export type VoteKind = z.infer<typeof VoteKindSchema>;
export const VoteResultSchema = z.object({
  tallyUnitsByTarget: z.record(NonEmptyString, z.number().int().nonnegative()),
  abstainedPlayerIds: z.array(NonEmptyString),
  tiedPlayerIds: z.array(NonEmptyString),
  winningTargetId: NonEmptyString.nullable(),
  resolutionKind: z.enum(["WINNER", "TIE", "NO_RESULT"]),
}).strict();
export type VoteResult = z.infer<typeof VoteResultSchema>;
export const VoteSessionSchema = z.object({
  sessionId: NonEmptyString,
  phaseId: NonEmptyString,
  kind: VoteKindSchema,
  roundIndex: z.number().int().min(1).max(2),
  eligibleVotersSnapshot: z.array(NonEmptyString),
  eligibleTargetsSnapshot: z.array(NonEmptyString),
  weightUnitsByVoter: z.record(NonEmptyString, z.number().int().positive()),
  ballots: z.array(BallotSchema),
  status: z.enum(["OPEN", "CLOSED"]),
  result: VoteResultSchema.nullable(),
}).strict();
export type VoteSession = z.infer<typeof VoteSessionSchema>;

export const GameOutcomeSchema = z.object({
  result: z.enum(["GOOD", "WOLF", "DRAW"]),
  determinedAtSequence: z.number().int().positive(),
}).strict();

export const RuntimeStateSchema = z.object({
  phase: PhaseStateSchema.nullable(),
  round: z.number().int().positive(),
  players: z.array(PlayerRuntimeSchema).length(12),
  abilityStates: z.array(AbilityStateSchema),
  statusEffects: z.array(StatusEffectSchema),
  nightSession: NightSessionStateSchema,
  speechSession: SpeechSessionSchema.nullable(),
  voteSession: VoteSessionSchema.nullable(),
  sheriff: SheriffStateSchema,
  resolutionGroup: ResolutionGroupStateSchema.nullable(),
  pendingReactions: z.array(PendingReactionSchema),
  outcome: GameOutcomeSchema.nullable(),
  startedAtIso: IsoUtcString,
  endedAtIso: IsoUtcString.nullable(),
}).strict();
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const GameStateSchema = z.object({
  gameId: NonEmptyString,
  status: z.enum(["LOBBY", "LOCKED", "IN_PROGRESS", "ENDED", "ABORTED"]),
  createdAtIso: IsoUtcString,
  lastSequence: z.number().int().positive(),
  lobby: LobbySchema.nullable(),
  manifest: GameManifestSchema.nullable(),
  lockedSetup: LockedSetupSchema.nullable(),
  runtime: RuntimeStateSchema.nullable(),
  abortReason: z.literal("HOST_REQUEST").nullable(),
}).strict().superRefine((state, ctx) => {
  if (state.status === "LOBBY" && (state.lobby === null || state.manifest !== null || state.lockedSetup !== null || state.runtime !== null || state.abortReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid LOBBY state invariant" });
  }
  if (state.status === "LOCKED" && (state.lobby !== null || state.manifest === null || state.lockedSetup === null || state.runtime !== null || state.abortReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid LOCKED state invariant" });
  }
  if (state.status === "IN_PROGRESS" && (state.lobby !== null || state.manifest === null || state.lockedSetup === null || state.runtime === null || state.abortReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid IN_PROGRESS state invariant" });
  }
  if (state.status === "ENDED" && (state.runtime === null || state.runtime.outcome === null || state.runtime.endedAtIso === null || state.abortReason !== null)) {
    ctx.addIssue({ code: "custom", message: "Invalid ENDED state invariant" });
  }
  if (state.status === "ABORTED" && state.abortReason !== "HOST_REQUEST") {
    ctx.addIssue({ code: "custom", message: "Invalid ABORTED state invariant" });
  }
});
export type GameState = z.infer<typeof GameStateSchema>;

const HostCommandBase = {
  commandId: NonEmptyString,
  gameId: NonEmptyString,
  actorPlayerId: NullOnly,
  windowToken: NullOnly,
};
const PlayerCommandBase = {
  commandId: NonEmptyString,
  gameId: NonEmptyString,
  actorPlayerId: NonEmptyString,
  windowToken: NonEmptyString,
};

export const CreateGameCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("CreateGame"), payload: z.object({ rulesetSnapshot: RulesetSnapshotSchema }).strict() }).strict();
export const ConfigureSeatsCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("ConfigureSeats"), payload: z.object({ seats: z.array(SeatSchema) }).strict() }).strict();
export const LockGameCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("LockGame"), payload: z.object({}).strict() }).strict();
export const AbortGameCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("AbortGame"), payload: z.object({ reason: z.literal("HOST_REQUEST") }).strict() }).strict();
export const StartGameCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("StartGame"), payload: z.object({}).strict() }).strict();
export const CommitGuardActionCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitGuardAction"), payload: z.object({ targetPlayerId: NonEmptyString.nullable() }).strict() }).strict();
export const CommitWolfBallotCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitWolfBallot"), payload: z.object({ targetPlayerId: NonEmptyString.nullable() }).strict() }).strict();
export const CommitBeautyActionCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("CommitBeautyAction"),
  payload: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("CHARM"), targetPlayerId: NonEmptyString }).strict(),
    z.object({ mode: z.literal("KEEP"), targetPlayerId: NullOnly }).strict(),
  ]),
}).strict();
export const CommitWitchActionCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("CommitWitchAction"),
  payload: z.discriminatedUnion("action", [
    z.object({ action: z.literal("PASS"), targetPlayerId: NullOnly }).strict(),
    z.object({ action: z.literal("HEAL"), targetPlayerId: NonEmptyString }).strict(),
    z.object({ action: z.literal("POISON"), targetPlayerId: NonEmptyString }).strict(),
  ]),
}).strict();
export const CommitSeerActionCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitSeerAction"), payload: z.object({ targetPlayerId: NonEmptyString.nullable() }).strict() }).strict();
export const ResolveNightCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("ResolveNight"), payload: z.object({}).strict() }).strict();
export const CommitHunterReactionCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("CommitHunterReaction"),
  payload: z.discriminatedUnion("action", [
    z.object({ action: z.literal("PASS"), targetPlayerId: NullOnly }).strict(),
    z.object({ action: z.literal("SHOOT"), targetPlayerId: NonEmptyString }).strict(),
  ]),
}).strict();

export const BeginDayCommandSchema = z.object({ ...HostCommandBase, commandType: z.literal("BeginDay"), payload: z.object({}).strict() }).strict();
export const CommitSpeechCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("CommitSpeech"),
  payload: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("SPEAK"), text: NonEmptyString, source: SpeechSourceSchema }).strict(),
    z.object({ mode: z.literal("PASS"), text: NullOnly, source: NullOnly }).strict(),
  ]),
}).strict();
export const CommitSheriffSignupCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitSheriffSignup"), payload: z.object({ join: z.boolean() }).strict() }).strict();
export const CommitSheriffWithdrawalCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitSheriffWithdrawal"), payload: z.object({ withdraw: z.boolean() }).strict() }).strict();
export const CommitBallotCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitBallot"), payload: z.object({ targetPlayerId: NonEmptyString.nullable() }).strict() }).strict();
export const ChooseDaySpeechOrderCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("ChooseDaySpeechOrder"),
  payload: z.object({ firstSpeakerPlayerId: NonEmptyString, direction: z.enum(["ASC", "DESC"]) }).strict(),
}).strict();
export const CommitSelfExplosionCommandSchema = z.object({ ...PlayerCommandBase, commandType: z.literal("CommitSelfExplosion"), payload: z.object({}).strict() }).strict();
export const CommitSheriffBadgeActionCommandSchema = z.object({
  ...PlayerCommandBase,
  commandType: z.literal("CommitSheriffBadgeAction"),
  payload: z.discriminatedUnion("action", [
    z.object({ action: z.literal("TRANSFER"), targetPlayerId: NonEmptyString }).strict(),
    z.object({ action: z.literal("DESTROY"), targetPlayerId: NullOnly }).strict(),
  ]),
}).strict();

export const CommandSchema = z.discriminatedUnion("commandType", [
  CreateGameCommandSchema,
  ConfigureSeatsCommandSchema,
  LockGameCommandSchema,
  AbortGameCommandSchema,
  StartGameCommandSchema,
  CommitGuardActionCommandSchema,
  CommitWolfBallotCommandSchema,
  CommitBeautyActionCommandSchema,
  CommitWitchActionCommandSchema,
  CommitSeerActionCommandSchema,
  ResolveNightCommandSchema,
  CommitHunterReactionCommandSchema,
  BeginDayCommandSchema,
  CommitSpeechCommandSchema,
  CommitSheriffSignupCommandSchema,
  CommitSheriffWithdrawalCommandSchema,
  CommitBallotCommandSchema,
  ChooseDaySpeechOrderCommandSchema,
  CommitSelfExplosionCommandSchema,
  CommitSheriffBadgeActionCommandSchema,
]);
export type Command = z.infer<typeof CommandSchema>;

export const TrustedPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("HOST"), hostId: NonEmptyString }).strict(),
  z.object({ kind: z.literal("PLAYER"), playerId: NonEmptyString }).strict(),
]);
export type TrustedPrincipal = z.infer<typeof TrustedPrincipalSchema>;

export const AudienceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("SYSTEM_TRUTH") }).strict(),
  z.object({ kind: z.literal("PUBLIC") }).strict(),
  z.object({ kind: z.literal("PRIVATE_RECIPIENTS"), playerIds: z.array(NonEmptyString).min(1) }).strict(),
]);
export type Audience = z.infer<typeof AudienceSchema>;

const EventCommon = {
  eventId: NonEmptyString,
  gameId: NonEmptyString,
  sequence: z.number().int().positive(),
  eventVersion: z.literal("1.0.0"),
  transactionId: NonEmptyString,
  causationCommandId: NonEmptyString,
  causedByEventIds: z.array(NonEmptyString),
  phaseId: NonEmptyString.nullable(),
  recordedAtIso: IsoUtcString,
  audience: AudienceSchema,
};

export const GameCreatedEventSchema = z.object({ ...EventCommon, eventType: z.literal("GameCreated"), payload: z.object({ createdAtIso: IsoUtcString, rulesetDraft: RulesetSnapshotSchema }).strict() }).strict();
export const SeatsConfiguredEventSchema = z.object({ ...EventCommon, eventType: z.literal("SeatsConfigured"), payload: z.object({ seats: z.array(SeatSchema).length(12) }).strict() }).strict();
export const SetupLockedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SetupLocked"), payload: z.object({ manifest: GameManifestSchema, lockedSetup: LockedSetupSchema }).strict() }).strict();
export const GameAbortedEventSchema = z.object({ ...EventCommon, eventType: z.literal("GameAborted"), payload: z.object({ reason: z.literal("HOST_REQUEST") }).strict() }).strict();
export const GameStartedEventSchema = z.object({ ...EventCommon, eventType: z.literal("GameStarted"), payload: z.object({ startedAtIso: IsoUtcString }).strict() }).strict();
export const PhaseOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("PhaseOpened"), payload: z.object({ phaseId: NonEmptyString, phaseType: PhaseTypeSchema, roundNumber: z.number().int().positive(), continuation: z.enum(["NEXT_NIGHT", "DAY_DISCUSSION", "SHERIFF_ELECTION"]).nullable() }).strict() }).strict();
export const PhaseClosedEventSchema = z.object({ ...EventCommon, eventType: z.literal("PhaseClosed"), payload: z.object({ phaseId: NonEmptyString }).strict() }).strict();
export const ActionWindowOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ActionWindowOpened"), payload: z.object({ session: ActionSessionSchema }).strict() }).strict();
export const ActionWindowClosedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ActionWindowClosed"), payload: z.object({ sessionId: NonEmptyString }).strict() }).strict();
export const NightActionCommittedEventSchema = z.object({
  ...EventCommon,
  eventType: z.literal("NightActionCommitted"),
  payload: z.discriminatedUnion("intentType", [
    z.object({ intentType: z.literal("GUARD"), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict(),
    z.object({ intentType: z.literal("BEAUTY"), actorPlayerId: NonEmptyString, mode: z.enum(["CHARM", "KEEP"]), targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict(),
    z.object({ intentType: z.literal("WITCH"), actorPlayerId: NonEmptyString, action: z.enum(["PASS", "HEAL", "POISON"]), targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict(),
    z.object({ intentType: z.literal("SEER"), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict(),
  ]),
}).strict();
export const AbilityResourceSpentEventSchema = z.object({ ...EventCommon, eventType: z.literal("AbilityResourceSpent"), payload: z.object({ actorPlayerId: NonEmptyString, abilityId: z.enum(["WITCH_HEAL", "WITCH_POISON"]), resource: z.enum(["HEAL", "POISON"]), remaining: z.literal(0), nightNumber: z.number().int().positive() }).strict() }).strict();
export const WolfBallotCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("WolfBallotCommitted"), payload: z.object({ actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict() }).strict();
export const WolfTargetCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("WolfTargetCommitted"), payload: z.object({ targetPlayerId: NonEmptyString.nullable(), nightNumber: z.number().int().positive() }).strict() }).strict();
export const StatusAppliedEventSchema = z.object({ ...EventCommon, eventType: z.literal("StatusApplied"), payload: z.object({ status: StatusEffectSchema }).strict() }).strict();
export const StatusExpiredEventSchema = z.object({ ...EventCommon, eventType: z.literal("StatusExpired"), payload: z.object({ statusId: NonEmptyString, reason: z.enum(["REPLACED", "NIGHT_ENDED", "SOURCE_DIED", "TARGET_DIED"]) }).strict() }).strict();
export const SeerCheckResolvedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SeerCheckResolved"), payload: z.object({ actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString, result: z.enum(["WOLF", "GOOD"]), nightNumber: z.number().int().positive() }).strict() }).strict();
export const PrivateObservationPublishedEventSchema = z.object({ ...EventCommon, eventType: z.literal("PrivateObservationPublished"), payload: z.object({ recipientPlayerIds: z.array(NonEmptyString).min(1), observationType: z.literal("SEER_CHECK"), data: z.object({ targetPlayerId: NonEmptyString, result: z.enum(["WOLF", "GOOD"]) }).strict() }).strict() }).strict();
export const EffectResolvedEventSchema = z.object({ ...EventCommon, eventType: z.literal("EffectResolved"), payload: z.object({ effectId: NonEmptyString, effectType: z.enum(["GUARD_PROTECT", "WOLF_ATTACK", "WITCH_HEAL", "WITCH_POISON", "GUARD_HEAL_COLLISION", "WOLF_BEAUTY_LINK", "HUNTER_SHOT", "VOTE_EXECUTION", "SELF_EXPLOSION"]), sourcePlayerId: NonEmptyString.nullable(), targetPlayerId: NonEmptyString.nullable(), resolutionGroupId: NonEmptyString, outcome: z.enum(["APPLIED", "PREVENTED", "NO_EFFECT"]) }).strict() }).strict();
export const DeathWaveResolvedEventSchema = z.object({ ...EventCommon, eventType: z.literal("DeathWaveResolved"), payload: z.object({ resolutionGroupId: NonEmptyString, waveId: NonEmptyString, round: z.number().int().positive(), deaths: z.array(z.object({ playerId: NonEmptyString, causes: z.array(DeathCauseSchema).min(1), sourceEffectIds: z.array(NonEmptyString) }).strict()).min(1) }).strict() }).strict();
export const DawnAnnouncementPublishedEventSchema = z.object({ ...EventCommon, eventType: z.literal("DawnAnnouncementPublished"), payload: z.object({ round: z.number().int().positive(), deadPlayerIds: z.array(NonEmptyString) }).strict() }).strict();
export const ReactionWindowOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ReactionWindowOpened"), payload: z.object({ reaction: PendingReactionSchema }).strict() }).strict();
export const ReactionCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ReactionCommitted"), payload: z.object({ reactionId: NonEmptyString, actorPlayerId: NonEmptyString, action: z.enum(["PASS", "SHOOT"]), targetPlayerId: NonEmptyString.nullable() }).strict() }).strict();
export const ReactionClosedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ReactionClosed"), payload: z.object({ reactionId: NonEmptyString }).strict() }).strict();
export const ResolutionGroupSettledEventSchema = z.object({ ...EventCommon, eventType: z.literal("ResolutionGroupSettled"), payload: z.object({ resolutionGroupId: NonEmptyString }).strict() }).strict();
export const GameEndedEventSchema = z.object({ ...EventCommon, eventType: z.literal("GameEnded"), payload: z.object({ result: z.enum(["GOOD", "WOLF", "DRAW"]), reason: z.literal("ELIMINATE_SIDE"), endedAtIso: IsoUtcString }).strict() }).strict();
export const NightStartedEventSchema = z.object({ ...EventCommon, eventType: z.literal("NightStarted"), payload: z.object({ nightNumber: z.number().int().min(2), alivePlayerIds: z.array(NonEmptyString).min(1) }).strict() }).strict();
export const SpeechSessionOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SpeechSessionOpened"), payload: z.object({ session: SpeechSessionSchema }).strict() }).strict();
export const SpeechPublishedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SpeechPublished"), payload: z.object({ speakerPlayerId: NonEmptyString, sessionId: NonEmptyString, text: NonEmptyString, source: SpeechSourceSchema, publishedAtSequence: z.number().int().positive() }).strict() }).strict();
export const SpeechFinishedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SpeechFinished"), payload: z.object({ speakerPlayerId: NonEmptyString, sessionId: NonEmptyString }).strict() }).strict();
export const SheriffSignupSessionOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffSignupSessionOpened"), payload: z.object({ session: SheriffSignupSessionSchema }).strict() }).strict();
export const SheriffSignupCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffSignupCommitted"), payload: z.object({ actorPlayerId: NonEmptyString, join: z.boolean(), sessionId: NonEmptyString }).strict() }).strict();
export const SheriffSignupSessionClosedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffSignupSessionClosed"), payload: z.object({ sessionId: NonEmptyString, candidatePlayerIds: z.array(NonEmptyString), originalVoterPlayerIds: z.array(NonEmptyString) }).strict() }).strict();
export const SheriffWithdrawalSessionOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffWithdrawalSessionOpened"), payload: z.object({ session: SheriffWithdrawalSessionSchema }).strict() }).strict();
export const SheriffWithdrawalCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffWithdrawalCommitted"), payload: z.object({ actorPlayerId: NonEmptyString, withdraw: z.boolean(), sessionId: NonEmptyString }).strict() }).strict();
export const SheriffWithdrawalSessionClosedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffWithdrawalSessionClosed"), payload: z.object({ sessionId: NonEmptyString, remainingCandidatePlayerIds: z.array(NonEmptyString) }).strict() }).strict();
export const VoteSessionOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("VoteSessionOpened"), payload: z.object({ session: VoteSessionSchema }).strict() }).strict();
export const BallotCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("BallotCommitted"), payload: z.object({ voterPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable(), sessionId: NonEmptyString }).strict() }).strict();
export const VoteSessionResolvedEventSchema = z.object({ ...EventCommon, eventType: z.literal("VoteSessionResolved"), payload: z.object({ sessionId: NonEmptyString, result: VoteResultSchema, ballots: z.array(BallotSchema) }).strict() }).strict();
export const SheriffElectedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffElected"), payload: z.object({ playerId: NonEmptyString }).strict() }).strict();
export const SheriffElectionClosedNoBadgeEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffElectionClosedNoBadge"), payload: z.object({ reason: z.enum(["NO_CANDIDATE", "NO_VOTER", "TIE", "ALL_ABSTAIN", "SELF_EXPLOSION"]) }).strict() }).strict();
export const SheriffTransferredEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffTransferred"), payload: z.object({ fromPlayerId: NonEmptyString, toPlayerId: NonEmptyString }).strict() }).strict();
export const SheriffBadgeDestroyedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SheriffBadgeDestroyed"), payload: z.object({ holderPlayerId: NonEmptyString }).strict() }).strict();
export const ResolutionGroupOpenedEventSchema = z.object({ ...EventCommon, eventType: z.literal("ResolutionGroupOpened"), payload: z.object({ resolutionGroupId: NonEmptyString, kind: z.enum(["VOTE_EXECUTION", "SELF_EXPLOSION"]), round: z.number().int().positive() }).strict() }).strict();
export const SelfExplosionCommittedEventSchema = z.object({ ...EventCommon, eventType: z.literal("SelfExplosionCommitted"), payload: z.object({ actorPlayerId: NonEmptyString }).strict() }).strict();

export const EventSchema = z.discriminatedUnion("eventType", [
  GameCreatedEventSchema,
  SeatsConfiguredEventSchema,
  SetupLockedEventSchema,
  GameAbortedEventSchema,
  GameStartedEventSchema,
  PhaseOpenedEventSchema,
  PhaseClosedEventSchema,
  ActionWindowOpenedEventSchema,
  ActionWindowClosedEventSchema,
  NightActionCommittedEventSchema,
  AbilityResourceSpentEventSchema,
  WolfBallotCommittedEventSchema,
  WolfTargetCommittedEventSchema,
  StatusAppliedEventSchema,
  StatusExpiredEventSchema,
  SeerCheckResolvedEventSchema,
  PrivateObservationPublishedEventSchema,
  EffectResolvedEventSchema,
  DeathWaveResolvedEventSchema,
  DawnAnnouncementPublishedEventSchema,
  ReactionWindowOpenedEventSchema,
  ReactionCommittedEventSchema,
  ReactionClosedEventSchema,
  ResolutionGroupSettledEventSchema,
  GameEndedEventSchema,
  NightStartedEventSchema,
  SpeechSessionOpenedEventSchema,
  SpeechPublishedEventSchema,
  SpeechFinishedEventSchema,
  SheriffSignupSessionOpenedEventSchema,
  SheriffSignupCommittedEventSchema,
  SheriffSignupSessionClosedEventSchema,
  SheriffWithdrawalSessionOpenedEventSchema,
  SheriffWithdrawalCommittedEventSchema,
  SheriffWithdrawalSessionClosedEventSchema,
  VoteSessionOpenedEventSchema,
  BallotCommittedEventSchema,
  VoteSessionResolvedEventSchema,
  SheriffElectedEventSchema,
  SheriffElectionClosedNoBadgeEventSchema,
  SheriffTransferredEventSchema,
  SheriffBadgeDestroyedEventSchema,
  ResolutionGroupOpenedEventSchema,
  SelfExplosionCommittedEventSchema,
]);
export type DomainEvent = z.infer<typeof EventSchema>;

export const OutcomeCodeSchema = z.enum([
  "GAME_CREATED",
  "SEATS_CONFIGURED",
  "SETUP_LOCKED",
  "GAME_ABORTED",
  "GAME_STARTED",
  "GUARD_ACTION_COMMITTED",
  "WOLF_BALLOT_COMMITTED",
  "BEAUTY_ACTION_COMMITTED",
  "WITCH_ACTION_COMMITTED",
  "SEER_ACTION_COMMITTED",
  "NIGHT_RESOLVED",
  "HUNTER_REACTION_COMMITTED",
  "DAY_BEGUN",
  "SPEECH_COMMITTED",
  "SHERIFF_SIGNUP_COMMITTED",
  "SHERIFF_WITHDRAWAL_COMMITTED",
  "BALLOT_COMMITTED",
  "DAY_SPEECH_ORDER_CHOSEN",
  "SELF_EXPLOSION_COMMITTED",
  "SHERIFF_BADGE_ACTION_COMMITTED",
]);
export const CommandReceiptSchema = z.object({
  commandId: NonEmptyString,
  gameId: NonEmptyString,
  principalKey: NonEmptyString,
  canonicalRequest: CommandSchema,
  firstSequence: z.number().int().positive(),
  lastSequence: z.number().int().positive(),
  outcomeCode: OutcomeCodeSchema,
}).strict();
export type CommandReceipt = z.infer<typeof CommandReceiptSchema>;

export const ExportBundleSchema = z.object({
  formatVersion: z.literal("1.0.0"),
  gameId: NonEmptyString,
  events: z.array(EventSchema),
  commandReceipts: z.array(CommandReceiptSchema),
}).strict();
export type ExportBundle = z.infer<typeof ExportBundleSchema>;

export function parseCommand(input: unknown): Command {
  const result = CommandSchema.safeParse(input);
  if (!result.success) throw new CoreError("INVALID_INPUT", result.error.message);
  return result.data;
}

export function parseTrustedPrincipal(input: unknown): TrustedPrincipal {
  const result = TrustedPrincipalSchema.safeParse(input);
  if (!result.success) throw new CoreError("UNAUTHORIZED", result.error.message);
  return result.data;
}

export function parseEvent(input: unknown): DomainEvent {
  if (input !== null && typeof input === "object" && "eventVersion" in input && (input as { eventVersion?: unknown }).eventVersion !== "1.0.0") {
    throw new CoreError("UNSUPPORTED_EVENT_VERSION", "Only eventVersion 1.0.0 is supported");
  }
  const result = EventSchema.safeParse(input);
  if (!result.success) throw new CoreError("INVALID_EVENT_STREAM", result.error.message);
  return result.data;
}
