import * as z from "zod";
import { PrivateObservationSchema, PublicObservationSchema, PublicStageKindSchema } from "../../projection/schemas.js";
import { EMPTY_ADVANCED_REASONING, NpcAdvancedReasoningSnapshotSchema } from "../advanced/schemas.js";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });
const BasisPoints = z.number().int().min(0).max(10_000);
const SignedScore = z.number().int().min(-1_000).max(1_000);
const TraitScore = z.number().int().min(0).max(100);

export const NpcPersonaArchetypeSchema = z.enum(["ANALYST", "CAUTIOUS", "ASSERTIVE", "SOCIAL", "SKEPTIC", "OPPORTUNIST"]);
export type NpcPersonaArchetype = z.infer<typeof NpcPersonaArchetypeSchema>;

export const NpcPersonaSchema = z.object({
  archetype: NpcPersonaArchetypeSchema,
  aggression: TraitScore,
  assertiveness: TraitScore,
  riskTolerance: TraitScore,
  skepticism: TraitScore,
  leadership: TraitScore,
  verbosity: TraitScore,
  consistencyBias: TraitScore,
  deceptionComfort: TraitScore,
}).strict();
export type NpcPersona = z.infer<typeof NpcPersonaSchema>;

export const NpcExactIdentityKnowledgeSchema = z.object({
  playerId: NonEmptyString,
  roleId: NonEmptyString,
  factionId: z.enum(["WOLF", "GOOD"]),
  source: z.enum(["SELF", "INITIAL_KNOWLEDGE", "POST_GAME_REVEAL"]),
}).strict();
export type NpcExactIdentityKnowledge = z.infer<typeof NpcExactIdentityKnowledgeSchema>;

export const NpcBeliefSchema = z.object({
  playerId: NonEmptyString,
  knownFaction: z.enum(["WOLF", "GOOD"]).nullable(),
  knownRoleId: NonEmptyString.nullable(),
  wolfLikelihoodBps: BasisPoints,
  trustScore: SignedScore,
  suspicionScore: SignedScore,
  evidenceMemoryIds: z.array(NonEmptyString).max(32),
}).strict();
export type NpcBelief = z.infer<typeof NpcBeliefSchema>;

const MemoryBaseSchema = z.object({
  memoryId: NonEmptyString,
  importance: z.enum(["ROUTINE", "IMPORTANT", "CRITICAL"]),
}).strict();

export const NpcMemoryEntrySchema = z.discriminatedUnion("visibility", [
  MemoryBaseSchema.extend({ visibility: z.literal("PUBLIC"), observation: PublicObservationSchema }).strict(),
  MemoryBaseSchema.extend({ visibility: z.literal("PRIVATE"), observation: PrivateObservationSchema }).strict(),
]);
export type NpcMemoryEntry = z.infer<typeof NpcMemoryEntrySchema>;

export const NpcClaimSchema = z.object({
  claimId: NonEmptyString,
  sourcePlayerId: NonEmptyString,
  sourcePublicOrdinal: z.number().int().positive().nullable(),
  claimType: z.enum(["ROLE_CLAIM", "CHECK_RESULT", "ALIGNMENT_READ", "VOTE_INTENT", "SHERIFF_STANCE", "OTHER"]),
  roleId: NonEmptyString.nullable(),
  targetPlayerId: NonEmptyString.nullable(),
  alignment: z.enum(["WOLF", "GOOD"]).nullable(),
  statement: NonEmptyString,
}).strict();
export type NpcClaim = z.infer<typeof NpcClaimSchema>;

export const NpcWorkingTheorySchema = z.object({
  supportedPlayerId: NonEmptyString.nullable(),
  opposedPlayerId: NonEmptyString.nullable(),
  voteIntentPlayerId: NonEmptyString.nullable(),
  abilityIntentTargetPlayerId: NonEmptyString.nullable(),
  notes: z.array(NonEmptyString).max(16),
}).strict();
export type NpcWorkingTheory = z.infer<typeof NpcWorkingTheorySchema>;

export const NpcDecisionRecordSchema = z.object({
  decisionId: NonEmptyString,
  ordinal: z.number().int().positive(),
  round: z.number().int().positive().nullable(),
  stage: PublicStageKindSchema,
  decisionKind: z.enum(["SPEECH", "VOTE", "ABILITY", "SHERIFF", "BADGE", "SELF_EXPLOSION", "OTHER"]),
  actionCode: NonEmptyString,
  targetPlayerId: NonEmptyString.nullable(),
  rationaleCodes: z.array(NonEmptyString).max(16),
  status: z.enum(["PLANNED", "COMMITTED", "REJECTED"]),
}).strict();
export type NpcDecisionRecord = z.infer<typeof NpcDecisionRecordSchema>;

export const NpcPublicSeatSnapshotSchema = z.object({
  playerId: NonEmptyString,
  seatNumber: z.number().int().min(1).max(12),
  lifeState: z.enum(["ALIVE", "DEAD"]),
  isSheriff: z.boolean(),
}).strict();

export const NpcCognitiveStateSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  gameId: NonEmptyString,
  npcPlayerId: NonEmptyString,
  revision: z.number().int().nonnegative(),
  persona: NpcPersonaSchema,
  identityKnowledge: z.object({
    selfRoleId: NonEmptyString,
    selfFactionId: z.enum(["WOLF", "GOOD"]),
    exactIdentities: z.array(NpcExactIdentityKnowledgeSchema),
  }).strict(),
  cursor: z.object({
    publicOrdinal: z.number().int().nonnegative(),
    privateOrdinal: z.number().int().nonnegative(),
  }).strict(),
  memory: z.array(NpcMemoryEntrySchema),
  memoryStats: z.object({
    observedPublic: z.number().int().nonnegative(),
    observedPrivate: z.number().int().nonnegative(),
    pruned: z.number().int().nonnegative(),
  }).strict(),
  beliefs: z.array(NpcBeliefSchema),
  claimLedger: z.array(NpcClaimSchema),
  workingTheory: NpcWorkingTheorySchema,
  advancedReasoning: NpcAdvancedReasoningSnapshotSchema.default(EMPTY_ADVANCED_REASONING),
  decisionHistory: z.array(NpcDecisionRecordSchema).max(256),
  publicSnapshot: z.object({
    stage: PublicStageKindSchema,
    round: z.number().int().positive().nullable(),
    seats: z.array(NpcPublicSeatSnapshotSchema),
    sheriffHolderPlayerId: NonEmptyString.nullable(),
    outcome: z.enum(["GOOD", "WOLF", "DRAW"]).nullable(),
  }).strict(),
}).strict();
export type NpcCognitiveState = z.infer<typeof NpcCognitiveStateSchema>;

export function parseNpcCognitiveState(input: unknown): NpcCognitiveState {
  if (typeof input === "object" && input !== null && !("advancedReasoning" in input)) {
    return NpcCognitiveStateSchema.parse({ ...(input as Record<string, unknown>), advancedReasoning: EMPTY_ADVANCED_REASONING });
  }
  return NpcCognitiveStateSchema.parse(input);
}

export const StructuredClaimInputSchema = NpcClaimSchema.omit({ claimId: true });
export type StructuredClaimInput = z.infer<typeof StructuredClaimInputSchema>;

export const DecisionInputSchema = NpcDecisionRecordSchema.omit({ ordinal: true });
export type DecisionInput = z.infer<typeof DecisionInputSchema>;
