import * as z from "zod";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });

export const PublicStageKindSchema = z.enum(["LOBBY", "LOCKED", "NIGHT", "DAWN", "SHERIFF", "DAY", "ENDED", "ABORTED"]);
export type PublicStageKind = z.infer<typeof PublicStageKindSchema>;

export const PublicSeatViewSchema = z.object({
  playerId: NonEmptyString,
  seatNumber: z.number().int().min(1).max(12),
  displayName: NonEmptyString,
  controllerType: z.enum(["HUMAN", "NPC"]),
  lifeState: z.enum(["ALIVE", "DEAD"]),
  isSheriff: z.boolean(),
}).strict();
export type PublicSeatView = z.infer<typeof PublicSeatViewSchema>;

export const PublicRoleCatalogEntrySchema = z.object({ roleId: NonEmptyString, displayName: NonEmptyString, count: z.number().int().positive() }).strict();
export const PublicRulesetViewSchema = z.object({ rulesetId: NonEmptyString, rulesetVersion: NonEmptyString, roles: z.array(PublicRoleCatalogEntrySchema), sheriffEnabled: z.boolean() }).strict();
export type PublicRulesetView = z.infer<typeof PublicRulesetViewSchema>;

export const PublicObservationSchema = z.discriminatedUnion("type", [
  z.object({ ordinal: z.number().int().positive(), type: z.literal("GAME_STARTED"), round: z.literal(1) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("NIGHT_STARTED"), round: z.number().int().positive() }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("DAWN"), round: z.number().int().positive(), deadPlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SPEECH"), speakerPlayerId: NonEmptyString, speechKind: z.enum(["LAST_WORDS", "SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"]), text: NonEmptyString, source: z.enum(["HUMAN_TEXT", "HUMAN_TRANSCRIPT", "NPC_TEXT"]) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_CANDIDATES"), candidatePlayerIds: z.array(NonEmptyString), voterPlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_WITHDRAWAL_RESULT"), remainingCandidatePlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("VOTE_RESULT"), voteKind: z.enum(["SHERIFF", "SHERIFF_PK", "DAY", "DAY_PK"]), roundIndex: z.number().int().min(1).max(2), ballots: z.array(z.object({ voterPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable() }).strict()), tallyUnitsByTarget: z.record(NonEmptyString, z.number().int().nonnegative()), abstainedPlayerIds: z.array(NonEmptyString), tiedPlayerIds: z.array(NonEmptyString), winningTargetId: NonEmptyString.nullable(), resolutionKind: z.enum(["WINNER", "TIE", "NO_RESULT"]) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_ELECTED"), playerId: NonEmptyString }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_NO_BADGE"), reason: z.enum(["NO_CANDIDATE", "NO_VOTER", "TIE", "ALL_ABSTAIN", "SELF_EXPLOSION"]) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_TRANSFERRED"), fromPlayerId: NonEmptyString, toPlayerId: NonEmptyString }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SHERIFF_BADGE_DESTROYED"), holderPlayerId: NonEmptyString }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SELF_EXPLOSION"), playerId: NonEmptyString }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("HUNTER_SHOT"), hunterPlayerId: NonEmptyString, targetPlayerId: NonEmptyString }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("DEATHS_REVEALED"), playerIds: z.array(NonEmptyString).min(1) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("GAME_ENDED"), result: z.enum(["GOOD", "WOLF", "DRAW"]) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("GAME_ABORTED") }).strict(),
]);
export type PublicObservation = z.infer<typeof PublicObservationSchema>;

export const PublicTurnViewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({ kind: z.literal("SPEECH"), speechKind: z.enum(["LAST_WORDS", "SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"]), currentSpeakerPlayerId: NonEmptyString.nullable(), speakerOrderPlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ kind: z.literal("VOTE"), voteKind: z.enum(["SHERIFF", "SHERIFF_PK", "DAY", "DAY_PK"]), roundIndex: z.number().int().min(1).max(2), eligibleVoterPlayerIds: z.array(NonEmptyString), eligibleTargetPlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ kind: z.literal("SHERIFF_SIGNUP") }).strict(),
  z.object({ kind: z.literal("SHERIFF_WITHDRAWAL"), candidatePlayerIds: z.array(NonEmptyString) }).strict(),
  z.object({ kind: z.literal("DAY_ORDER_SELECTION"), sheriffPlayerId: NonEmptyString }).strict(),
  z.object({ kind: z.literal("SHERIFF_BADGE_ACTION"), holderPlayerId: NonEmptyString }).strict(),
]);
export type PublicTurnView = z.infer<typeof PublicTurnViewSchema>;

export const PublicGameViewSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  gameId: NonEmptyString,
  status: z.enum(["LOBBY", "LOCKED", "IN_PROGRESS", "ENDED", "ABORTED"]),
  stage: z.object({ kind: PublicStageKindSchema, round: z.number().int().positive().nullable() }).strict(),
  ruleset: PublicRulesetViewSchema,
  seats: z.array(PublicSeatViewSchema),
  sheriff: z.object({ badgeStatus: z.enum(["UNASSIGNED", "ACTIVE", "NO_BADGE", "DESTROYED"]), holderPlayerId: NonEmptyString.nullable(), electionAttempted: z.boolean(), visibleCandidatePlayerIds: z.array(NonEmptyString) }).strict(),
  currentTurn: PublicTurnViewSchema,
  timeline: z.array(PublicObservationSchema),
  outcome: z.object({ result: z.enum(["GOOD", "WOLF", "DRAW"]) }).strict().nullable(),
}).strict();
export type PublicGameView = z.infer<typeof PublicGameViewSchema>;

export const KnownIdentitySchema = z.object({ playerId: NonEmptyString, roleId: NonEmptyString, roleDisplayName: NonEmptyString, factionId: z.enum(["WOLF", "GOOD"]) }).strict();
export type KnownIdentity = z.infer<typeof KnownIdentitySchema>;
export const ViewerIdentitySchema = z.object({ playerId: NonEmptyString, roleId: NonEmptyString, roleDisplayName: NonEmptyString, factionId: z.enum(["WOLF", "GOOD"]), victoryBucket: z.enum(["WOLF", "GOD", "VILLAGER"]), initiallyKnownIdentities: z.array(KnownIdentitySchema) }).strict();
export type ViewerIdentity = z.infer<typeof ViewerIdentitySchema>;

export const PrivateObservationSchema = z.discriminatedUnion("type", [
  z.object({ ordinal: z.number().int().positive(), type: z.literal("SEER_CHECK"), nightNumber: z.number().int().positive(), targetPlayerId: NonEmptyString, result: z.enum(["WOLF", "GOOD"]) }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("WITCH_KNIFE_INFO"), nightNumber: z.number().int().positive(), status: z.enum(["TARGET", "NO_ATTACK", "UNAVAILABLE"]), targetPlayerId: NonEmptyString.nullable() }).strict(),
  z.object({ ordinal: z.number().int().positive(), type: z.literal("WOLF_TARGET"), nightNumber: z.number().int().positive(), status: z.enum(["TARGET", "NO_KILL"]), targetPlayerId: NonEmptyString.nullable() }).strict(),
]);
export type PrivateObservation = z.infer<typeof PrivateObservationSchema>;

export const ViewerAbilityStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("NONE") }).strict(),
  z.object({ kind: z.literal("WITCH"), healRemaining: z.union([z.literal(0), z.literal(1)]), poisonRemaining: z.union([z.literal(0), z.literal(1)]) }).strict(),
  z.object({ kind: z.literal("GUARD"), lastNightNumber: z.number().int().positive().nullable(), lastTargetPlayerId: NonEmptyString.nullable() }).strict(),
  z.object({ kind: z.literal("BEAUTY"), lastCharmNight: z.number().int().positive().nullable(), activeCharmTargetPlayerId: NonEmptyString.nullable() }).strict(),
  z.object({ kind: z.literal("HUNTER"), shotRemaining: z.union([z.literal(0), z.literal(1)]), reactionStatus: z.enum(["NOT_AVAILABLE", "PENDING", "COMMITTED", "FORFEITED"]) }).strict(),
  z.object({ kind: z.literal("SEER"), lastActionNight: z.number().int().positive().nullable() }).strict(),
  z.object({ kind: z.literal("WOLF"), currentNightBallotCommitted: z.boolean() }).strict(),
]);
export type ViewerAbilityState = z.infer<typeof ViewerAbilityStateSchema>;

const PromptBase = { windowToken: NonEmptyString };
export const PlayerActionPromptSchema = z.discriminatedUnion("commandType", [
  z.object({ ...PromptBase, commandType: z.literal("CommitGuardAction"), legalTargetPlayerIds: z.array(NonEmptyString), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitWolfBallot"), legalTargetPlayerIds: z.array(NonEmptyString), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitBeautyAction"), legalTargetPlayerIds: z.array(NonEmptyString), modes: z.array(z.enum(["CHARM", "KEEP"])) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitWitchAction"), knifeInfo: z.object({ status: z.enum(["TARGET", "NO_ATTACK", "UNAVAILABLE"]), targetPlayerId: NonEmptyString.nullable() }).strict(), healRemaining: z.union([z.literal(0), z.literal(1)]), poisonRemaining: z.union([z.literal(0), z.literal(1)]), healTargetPlayerId: NonEmptyString.nullable(), poisonTargetPlayerIds: z.array(NonEmptyString), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSeerAction"), legalTargetPlayerIds: z.array(NonEmptyString), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitHunterReaction"), legalTargetPlayerIds: z.array(NonEmptyString), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSpeech"), speechKind: z.enum(["LAST_WORDS", "SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"]), allowPass: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSheriffSignup"), choices: z.tuple([z.literal("JOIN"), z.literal("PASS")]) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSheriffWithdrawal"), choices: z.tuple([z.literal("STAY"), z.literal("WITHDRAW")]) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitBallot"), voteKind: z.enum(["SHERIFF", "SHERIFF_PK", "DAY", "DAY_PK"]), legalTargetPlayerIds: z.array(NonEmptyString), allowAbstain: z.literal(true) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("ChooseDaySpeechOrder"), legalFirstSpeakerPlayerIds: z.array(NonEmptyString), directions: z.tuple([z.literal("ASC"), z.literal("DESC")]) }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSelfExplosion") }).strict(),
  z.object({ ...PromptBase, commandType: z.literal("CommitSheriffBadgeAction"), transferTargetPlayerIds: z.array(NonEmptyString), allowDestroy: z.literal(true) }).strict(),
]);
export type PlayerActionPrompt = z.infer<typeof PlayerActionPromptSchema>;

export const InteractionStatusSchema = z.enum(["WAITING", "ACTION_REQUIRED", "ACTION_SUBMITTED", "DEAD", "GAME_OVER"]);

export const PostGameRevealSchema = z.object({
  assignments: z.array(z.object({ playerId: NonEmptyString, roleId: NonEmptyString, roleDisplayName: NonEmptyString, factionId: z.enum(["WOLF", "GOOD"]), victoryBucket: z.enum(["WOLF", "GOD", "VILLAGER"]) }).strict()),
  nightActions: z.array(z.discriminatedUnion("type", [
    z.object({ type: z.literal("GUARD"), nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable() }).strict(),
    z.object({ type: z.literal("BEAUTY"), nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, mode: z.enum(["CHARM", "KEEP"]), targetPlayerId: NonEmptyString.nullable() }).strict(),
    z.object({ type: z.literal("WITCH"), nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, action: z.enum(["PASS", "HEAL", "POISON"]), targetPlayerId: NonEmptyString.nullable() }).strict(),
    z.object({ type: z.literal("SEER"), nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable() }).strict(),
    z.object({ type: z.literal("WOLF_BALLOT"), nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString.nullable() }).strict(),
    z.object({ type: z.literal("WOLF_TARGET"), nightNumber: z.number().int().positive(), targetPlayerId: NonEmptyString.nullable() }).strict(),
  ])),
  seerChecks: z.array(z.object({ nightNumber: z.number().int().positive(), actorPlayerId: NonEmptyString, targetPlayerId: NonEmptyString, result: z.enum(["WOLF", "GOOD"]) }).strict()),
  deaths: z.array(z.object({ round: z.number().int().positive(), playerId: NonEmptyString, causes: z.array(z.enum(["WEREWOLF_ATTACK", "WITCH_POISON", "VOTE_EXECUTION", "HUNTER_SHOT", "WOLF_BEAUTY_LINK", "GUARD_HEAL_COLLISION", "SELF_EXPLOSION"])) }).strict()),
}).strict();
export type PostGameReveal = z.infer<typeof PostGameRevealSchema>;

export const PlayerViewSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  public: PublicGameViewSchema,
  viewer: z.object({ playerId: NonEmptyString, seatNumber: z.number().int().min(1).max(12), displayName: NonEmptyString, controllerType: z.enum(["HUMAN", "NPC"]), publicLifeState: z.enum(["ALIVE", "DEAD"]) }).strict(),
  identity: ViewerIdentitySchema.nullable(),
  abilityState: ViewerAbilityStateSchema,
  privateObservations: z.array(PrivateObservationSchema),
  availableActions: z.array(PlayerActionPromptSchema),
  interactionStatus: InteractionStatusSchema,
  finalReveal: PostGameRevealSchema.nullable(),
}).strict();
export type PlayerView = z.infer<typeof PlayerViewSchema>;
