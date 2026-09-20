import * as z from "zod";
import { PublicStageKindSchema } from "../../projection/schemas.js";

const NonEmptyString = z.string().min(1).refine((value) => value.trim().length > 0, { message: "Non-blank string required" });
const NullableTarget = NonEmptyString.nullable();

/** C-03 strategy intent deliberately excludes windowToken. A fresh PlayerView supplies capability data at commit time. */
export const NpcStrategyChoiceSchema = z.discriminatedUnion("commandType", [
  z.object({ commandType: z.literal("CommitGuardAction"), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitWolfBallot"), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitBeautyAction"), mode: z.enum(["CHARM", "KEEP"]), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitWitchAction"), action: z.enum(["PASS", "HEAL", "POISON"]), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitSeerAction"), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitHunterReaction"), action: z.enum(["PASS", "SHOOT"]), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("CommitSpeech"), mode: z.enum(["SPEAK", "PASS"]), text: z.string().max(1000).nullable() }).strict(),
  z.object({ commandType: z.literal("CommitSheriffSignup"), choice: z.enum(["JOIN", "PASS"]) }).strict(),
  z.object({ commandType: z.literal("CommitSheriffWithdrawal"), choice: z.enum(["STAY", "WITHDRAW"]) }).strict(),
  z.object({ commandType: z.literal("CommitBallot"), targetPlayerId: NullableTarget }).strict(),
  z.object({ commandType: z.literal("ChooseDaySpeechOrder"), firstSpeakerPlayerId: NonEmptyString, direction: z.enum(["ASC", "DESC"]) }).strict(),
  z.object({ commandType: z.literal("CommitSelfExplosion") }).strict(),
  z.object({ commandType: z.literal("CommitSheriffBadgeAction"), action: z.enum(["TRANSFER", "DESTROY"]), targetPlayerId: NullableTarget }).strict(),
]);
export type NpcStrategyChoice = z.infer<typeof NpcStrategyChoiceSchema>;

export const NpcStrategyDecisionSchema = z.object({
  contractVersion: z.literal("1.0.0"),
  decisionId: NonEmptyString,
  gameId: NonEmptyString,
  npcPlayerId: NonEmptyString,
  sourceRevision: z.number().int().nonnegative(),
  roleId: NonEmptyString,
  stage: PublicStageKindSchema,
  round: z.number().int().positive().nullable(),
  choice: NpcStrategyChoiceSchema,
  targetPlayerId: NullableTarget,
  rationaleCodes: z.array(NonEmptyString).max(16),
  utilityScore: z.number().int().min(-100_000).max(100_000),
}).strict();
export type NpcStrategyDecision = z.infer<typeof NpcStrategyDecisionSchema>;

export const NpcStrategyResultSchema = z.object({
  decision: NpcStrategyDecisionSchema.nullable(),
  consideredCommandTypes: z.array(NonEmptyString),
}).strict();
export type NpcStrategyResult = z.infer<typeof NpcStrategyResultSchema>;
