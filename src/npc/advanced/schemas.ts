import * as z from "zod";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });
const BasisPoints = z.number().int().min(0).max(10_000);
const SignedBps = z.number().int().min(-10_000).max(10_000);

export const NpcAdvancedEvidenceLayerSchema = z.enum(["IDENTITY", "INFORMATION", "TEMPORAL", "UTILITY", "WORLD"]);
export type NpcAdvancedEvidenceLayer = z.infer<typeof NpcAdvancedEvidenceLayerSchema>;

export const NpcAdvancedEvidenceCodeSchema = z.enum([
  "SEER_CLAIM_WITH_CHECK_SUPPORT",
  "SEER_CLAIM_WITHOUT_CHECK_SUPPORT",
  "LATE_ROLE_COUNTERCLAIM",
  "EXCESS_CERTAINTY",
  "HIDDEN_ROLE_OVERREACH",
  "KNIFE_INFO_CLAIM",
  "UNEXPLAINED_STANCE_SHIFT",
  "EXPLAINED_STANCE_SHIFT",
  "DEATH_REMOVES_ACCUSER",
  "BUSSING_PLAUSIBLE",
  "WORLD_FACTION_FIT",
  "WORLD_ROLE_FIT",
]);
export type NpcAdvancedEvidenceCode = z.infer<typeof NpcAdvancedEvidenceCodeSchema>;

export const NpcAdvancedEvidenceSchema = z.object({
  evidenceId: NonEmptyString,
  layer: NpcAdvancedEvidenceLayerSchema,
  code: NpcAdvancedEvidenceCodeSchema,
  subjectPlayerId: NonEmptyString,
  relatedPlayerIds: z.array(NonEmptyString).max(6),
  sourceOrdinals: z.array(z.number().int().positive()).max(12),
  wolfLeanBps: SignedBps,
  confidenceBps: BasisPoints,
  favoredRoleIds: z.array(NonEmptyString).max(4),
  disfavoredRoleIds: z.array(NonEmptyString).max(4),
  assumptionCostIfIgnored: z.number().int().min(0).max(5),
  rationaleCode: NonEmptyString,
}).strict();
export type NpcAdvancedEvidence = z.infer<typeof NpcAdvancedEvidenceSchema>;

export const NpcTemporalTransitionSchema = z.object({
  transitionId: NonEmptyString,
  sourcePlayerId: NonEmptyString,
  targetPlayerId: NonEmptyString,
  fromAlignment: z.enum(["WOLF", "GOOD"]),
  toAlignment: z.enum(["WOLF", "GOOD"]),
  fromOrdinal: z.number().int().positive(),
  toOrdinal: z.number().int().positive(),
  triggerOrdinals: z.array(z.number().int().positive()).max(16),
  assessment: z.enum(["EXPLAINED", "PARTIALLY_EXPLAINED", "UNEXPLAINED"]),
}).strict();
export type NpcTemporalTransition = z.infer<typeof NpcTemporalTransitionSchema>;

export const NpcWorldAssignmentSchema = z.object({
  playerId: NonEmptyString,
  roleId: NonEmptyString,
  factionId: z.enum(["WOLF", "GOOD"]),
}).strict();
export type NpcWorldAssignment = z.infer<typeof NpcWorldAssignmentSchema>;

export const NpcWorldHypothesisSchema = z.object({
  worldId: NonEmptyString,
  rank: z.number().int().positive(),
  score: z.number().int().min(-1_000_000).max(1_000_000),
  relativeWeightBps: BasisPoints,
  assumptionCost: z.number().int().min(0).max(1_000),
  assignments: z.array(NpcWorldAssignmentSchema).min(1).max(12),
  supportingEvidenceIds: z.array(NonEmptyString).max(64),
  explanationCodes: z.array(NonEmptyString).max(32),
}).strict();
export type NpcWorldHypothesis = z.infer<typeof NpcWorldHypothesisSchema>;

export const NpcWorldMarginalSchema = z.object({
  playerId: NonEmptyString,
  wolfLikelihoodBps: BasisPoints,
  mostLikelyRoleId: NonEmptyString,
  roleConfidenceBps: BasisPoints,
}).strict();
export type NpcWorldMarginal = z.infer<typeof NpcWorldMarginalSchema>;

export const NpcAdvancedReasoningSnapshotSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  basis: z.object({
    publicOrdinal: z.number().int().nonnegative(),
    privateOrdinal: z.number().int().nonnegative(),
    claimCount: z.number().int().nonnegative(),
  }).strict(),
  evidence: z.array(NpcAdvancedEvidenceSchema).max(128),
  temporalTransitions: z.array(NpcTemporalTransitionSchema).max(64),
  topWorlds: z.array(NpcWorldHypothesisSchema).max(8),
  marginals: z.array(NpcWorldMarginalSchema).max(12),
}).strict();
export type NpcAdvancedReasoningSnapshot = z.infer<typeof NpcAdvancedReasoningSnapshotSchema>;

export const EMPTY_ADVANCED_REASONING: NpcAdvancedReasoningSnapshot = {
  contractVersion: "1.0.0",
  basis: { publicOrdinal: 0, privateOrdinal: 0, claimCount: 0 },
  evidence: [],
  temporalTransitions: [],
  topWorlds: [],
  marginals: [],
};

export const NpcAdvancedReasoningReportSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  gameId: NonEmptyString,
  npcPlayerId: NonEmptyString,
  inputRevision: z.number().int().nonnegative(),
  stateChanged: z.boolean(),
  snapshot: NpcAdvancedReasoningSnapshotSchema,
}).strict();
export type NpcAdvancedReasoningReport = z.infer<typeof NpcAdvancedReasoningReportSchema>;
