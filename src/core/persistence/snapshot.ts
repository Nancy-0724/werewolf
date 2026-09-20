import { createHash } from "node:crypto";
import * as z from "zod";
import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { GameStateSchema, type GameState } from "../domain/schemas.js";
import type { ClockPort } from "../application/ports.js";

const NonEmptyString = z.string().min(1);
const IsoUtcString = z.iso.datetime({ offset: true }).refine((value) => value.endsWith("Z"), { message: "UTC ISO timestamp ending in Z required" });

export const SNAPSHOT_FORMAT_VERSION = "1.0.0" as const;
export const DATA_SCHEMA_VERSION = "1.0.0" as const;
export const ENGINE_CONTRACT_VERSION = "1.0.0" as const;

export const GameSnapshotSchema = z.object({
  snapshotFormatVersion: z.literal(SNAPSHOT_FORMAT_VERSION),
  gameId: NonEmptyString,
  sequence: z.number().int().positive(),
  dataSchemaVersion: z.literal(DATA_SCHEMA_VERSION),
  engineContractVersion: z.literal(ENGINE_CONTRACT_VERSION),
  engineBuildId: NonEmptyString,
  createdAtIso: IsoUtcString,
  stateHashSha256: z.string().refine((value) => /^[a-f0-9]{64}$/.test(value), { message: "SHA-256 hash must be 64 lowercase hex chars" }),
  state: GameStateSchema,
}).strict();

export type GameSnapshot = z.infer<typeof GameSnapshotSchema>;

export function stateHashSha256(state: GameState): string {
  return createHash("sha256").update(stableStringify(state)).digest("hex");
}

export function createGameSnapshot(state: GameState, engineBuildId: string, clock: ClockPort): GameSnapshot {
  const frozenState = GameStateSchema.parse(cloneJson(state));
  if (frozenState.lastSequence <= 0) throw new CoreError("INVALID_SNAPSHOT", "Cannot snapshot a game before its first event");
  return GameSnapshotSchema.parse({
    snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
    gameId: frozenState.gameId,
    sequence: frozenState.lastSequence,
    dataSchemaVersion: DATA_SCHEMA_VERSION,
    engineContractVersion: ENGINE_CONTRACT_VERSION,
    engineBuildId,
    createdAtIso: clock.nowIso(),
    stateHashSha256: stateHashSha256(frozenState),
    state: frozenState,
  });
}

export function parseAndVerifySnapshot(input: unknown): GameSnapshot {
  const parsed = GameSnapshotSchema.safeParse(input);
  if (!parsed.success) throw new CoreError("INVALID_SNAPSHOT", parsed.error.message);
  const snapshot = parsed.data;
  if (snapshot.state.gameId !== snapshot.gameId) throw new CoreError("INVALID_SNAPSHOT", "Snapshot gameId/state mismatch");
  if (snapshot.state.lastSequence !== snapshot.sequence) throw new CoreError("INVALID_SNAPSHOT", "Snapshot sequence/state mismatch");
  if (stateHashSha256(snapshot.state) !== snapshot.stateHashSha256) throw new CoreError("INVALID_SNAPSHOT", "Snapshot state hash mismatch");
  return cloneJson(snapshot);
}
