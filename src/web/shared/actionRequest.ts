import * as z from "zod";

const NullableTarget = z.string().min(1).nullable();

export const WebActionRequestSchema = z.discriminatedUnion("commandType", [
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
  z.object({ commandType: z.literal("ChooseDaySpeechOrder"), firstSpeakerPlayerId: z.string().min(1), direction: z.enum(["ASC", "DESC"]) }).strict(),
  z.object({ commandType: z.literal("CommitSelfExplosion") }).strict(),
  z.object({ commandType: z.literal("CommitSheriffBadgeAction"), action: z.enum(["TRANSFER", "DESTROY"]), targetPlayerId: NullableTarget }).strict(),
]);

export type WebActionRequest = z.infer<typeof WebActionRequestSchema>;
