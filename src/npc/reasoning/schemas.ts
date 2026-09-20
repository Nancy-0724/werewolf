import * as z from "zod";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });
const SignedScore = z.number().int().min(-1_000).max(1_000);
const BasisPoints = z.number().int().min(0).max(10_000);

export const NpcReasoningEvidenceSchema = z.object({
  evidenceId: NonEmptyString,
  code: z.enum([
    "PUBLIC_SELF_EXPLOSION",
    "PUBLIC_HUNTER_SHOT",
    "ROLE_CLAIM_CONTRADICTION",
    "ROLE_COUNTERCLAIM",
    "CHECK_CONTRADICTION",
    "CHECK_CONFIRMED",
    "CHECK_INTERNAL_CONFLICT",
    "ALIGNMENT_READ_CONFIRMED",
    "ALIGNMENT_READ_CONTRADICTED",
    "VOTE_AGAINST_KNOWN_WOLF",
    "VOTE_AGAINST_KNOWN_GOOD",
    "KNOWN_WOLF_BALLOT_PRESSURE",
    "VOTE_INTENT_KEPT",
    "VOTE_INTENT_BROKEN"
  ]),
  subjectPlayerId: NonEmptyString,
  sourcePlayerId: NonEmptyString.nullable(),
  memoryIds: z.array(NonEmptyString).max(8),
  wolfLikelihoodDeltaBps: z.number().int().min(-10_000).max(10_000),
  trustDelta: SignedScore,
  suspicionDelta: SignedScore,
}).strict();
export type NpcReasoningEvidence = z.infer<typeof NpcReasoningEvidenceSchema>;

export const NpcReasoningRankEntrySchema = z.object({
  playerId: NonEmptyString,
  wolfLikelihoodBps: BasisPoints,
  trustScore: SignedScore,
  suspicionScore: SignedScore,
}).strict();

export const NpcHeuristicReasoningReportSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  gameId: NonEmptyString,
  npcPlayerId: NonEmptyString,
  sourceRevision: z.number().int().nonnegative(),
  extractedClaimIds: z.array(NonEmptyString),
  evidence: z.array(NpcReasoningEvidenceSchema),
  topSuspects: z.array(NpcReasoningRankEntrySchema).max(5),
  topTrusted: z.array(NpcReasoningRankEntrySchema).max(5),
  recommendedVoteTargetPlayerId: NonEmptyString.nullable(),
}).strict();
export type NpcHeuristicReasoningReport = z.infer<typeof NpcHeuristicReasoningReportSchema>;

export const NpcHeuristicReasoningResultSchema = z.object({
  stateChanged: z.boolean(),
  stateRevision: z.number().int().nonnegative(),
  report: NpcHeuristicReasoningReportSchema,
}).strict();
