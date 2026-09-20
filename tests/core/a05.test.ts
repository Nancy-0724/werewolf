import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CoreError,
  DurableGameService,
  GameService,
  InMemoryDurableGameStore,
  PlanningGameRepository,
  assessContinuationCompatibility,
  createGameSnapshot,
  createPgDatabasePortFromPool,
  replay,
  supportedRulesetSnapshot,
  type ClockPort,
  type Command,
  type GameSnapshot,
  type GameState,
  type IdPort,
  type RandomPort,
  type Seat,
} from "../../src/index.js";

class FixedClock implements ClockPort { nowIso(): string { return "2026-09-19T11:00:00.000Z"; } }
class CountingIds implements IdPort {
  #calls = 0;
  readonly #prefix: string;
  constructor(prefix: string) { this.#prefix = prefix; }
  nextId(): string { this.#calls += 1; return `${this.#prefix}-${this.#calls}`; }
}
class FixedRandom implements RandomPort {
  readonly algorithmId = "test.fixed";
  readonly privateSeed: string | null = "test-only-seed";
  #calls = 0;
  randomInt(exclusiveUpperBound: number): number { const values = [0, 1, 2, 3]; const value = values[this.#calls % values.length] ?? 0; this.#calls += 1; return value % exclusiveUpperBound; }
}

const host = { kind: "HOST", hostId: "host-1" } as const;
const player = (playerId: string) => ({ kind: "PLAYER", playerId }) as const;
const seats = (): Seat[] => Array.from({ length: 12 }, (_, index) => ({ playerId: `player-${index + 1}`, seatNumber: index + 1, displayName: `Player ${index + 1}`, controllerType: "HUMAN" as const }));

function makeService(store: InMemoryDurableGameStore, prefix: string, snapshotEveryEvents = 50, onSnapshotError?: (error: unknown) => void): DurableGameService {
  return new DurableGameService({ store, clock: new FixedClock(), ids: new CountingIds(prefix), random: new FixedRandom(), engineBuildId: `build-${prefix}`, snapshotEveryEvents, onSnapshotError });
}

function createCommand(gameId: string, commandId = `${gameId}-create`): Command { return { commandId, gameId, actorPlayerId: null, commandType: "CreateGame", payload: { rulesetSnapshot: supportedRulesetSnapshot() }, windowToken: null }; }
function seatsCommand(gameId: string, commandId = `${gameId}-seats`, displaySuffix = ""): Command { return { commandId, gameId, actorPlayerId: null, commandType: "ConfigureSeats", payload: { seats: seats().map((seat) => ({ ...seat, displayName: `${seat.displayName}${displaySuffix}` })) }, windowToken: null }; }
function lockCommand(gameId: string, commandId = `${gameId}-lock`): Command { return { commandId, gameId, actorPlayerId: null, commandType: "LockGame", payload: {}, windowToken: null }; }
function startCommand(gameId: string, commandId = `${gameId}-start`): Command { return { commandId, gameId, actorPlayerId: null, commandType: "StartGame", payload: {}, windowToken: null }; }

async function bootstrap(gameId: string, store = new InMemoryDurableGameStore(), snapshotEveryEvents = 50) {
  const service = makeService(store, `${gameId}-ids-a`, snapshotEveryEvents);
  await service.handle(host, createCommand(gameId));
  await service.handle(host, seatsCommand(gameId));
  await service.handle(host, lockCommand(gameId));
  await service.handle(host, startCommand(gameId));
  return { gameId, store, service };
}

async function stateOf(h: { gameId: string; service: DurableGameService }): Promise<GameState> {
  const recovered = await h.service.recover(h.gameId);
  if (recovered.state === null) throw new Error("missing state");
  return recovered.state;
}
function role(state: GameState, roleId: string): string { const value = state.lockedSetup?.assignments.find((entry) => entry.assignedRoleId === roleId)?.playerId; if (value === undefined) throw new Error(`missing ${roleId}`); return value; }
function wolves(state: GameState): string[] { return state.lockedSetup?.assignments.filter((entry) => entry.assignedFactionId === "WOLF").map((entry) => entry.playerId) ?? []; }

async function createHunterReaction(h: { gameId: string; service: DurableGameService }): Promise<{ hunterId: string; reactionToken: string }> {
  let state = await stateOf(h);
  const hunterId = role(state, "HUNTER");
  const guardId = role(state, "GUARD");
  let token = state.runtime?.nightSession.currentActionSession?.sessionId; if (token === undefined) throw new Error("guard token");
  await h.service.handle(player(guardId), { commandId: `${h.gameId}-guard`, gameId: h.gameId, actorPlayerId: guardId, commandType: "CommitGuardAction", payload: { targetPlayerId: null }, windowToken: token });

  state = await stateOf(h); token = state.runtime?.nightSession.currentActionSession?.sessionId; if (token === undefined) throw new Error("wolf token");
  for (const [index, wolfId] of wolves(state).entries()) await h.service.handle(player(wolfId), { commandId: `${h.gameId}-wolf-${index}`, gameId: h.gameId, actorPlayerId: wolfId, commandType: "CommitWolfBallot", payload: { targetPlayerId: hunterId }, windowToken: token });

  state = await stateOf(h); const beautyId = role(state, "WOLF_BEAUTY"); token = state.runtime?.nightSession.currentActionSession?.sessionId; if (token === undefined) throw new Error("beauty token");
  await h.service.handle(player(beautyId), { commandId: `${h.gameId}-beauty`, gameId: h.gameId, actorPlayerId: beautyId, commandType: "CommitBeautyAction", payload: { mode: "KEEP", targetPlayerId: null }, windowToken: token });

  state = await stateOf(h); const witchId = role(state, "WITCH"); token = state.runtime?.nightSession.currentActionSession?.sessionId; if (token === undefined) throw new Error("witch token");
  await h.service.handle(player(witchId), { commandId: `${h.gameId}-witch`, gameId: h.gameId, actorPlayerId: witchId, commandType: "CommitWitchAction", payload: { action: "PASS", targetPlayerId: null }, windowToken: token });

  state = await stateOf(h); const seerId = role(state, "SEER"); token = state.runtime?.nightSession.currentActionSession?.sessionId; if (token === undefined) throw new Error("seer token");
  await h.service.handle(player(seerId), { commandId: `${h.gameId}-seer`, gameId: h.gameId, actorPlayerId: seerId, commandType: "CommitSeerAction", payload: { targetPlayerId: null }, windowToken: token });
  await h.service.handle(host, { commandId: `${h.gameId}-resolve`, gameId: h.gameId, actorPlayerId: null, commandType: "ResolveNight", payload: {}, windowToken: null });

  state = await stateOf(h); const reaction = state.runtime?.pendingReactions.find((entry) => entry.status === "OPEN"); if (reaction === undefined) throw new Error("missing reaction");
  return { hunterId, reactionToken: reaction.sessionId };
}

describe("A-05 durable persistence, recovery, snapshots and compatibility", () => {
  it("A05-01 durable truth survives a service/process replacement", async () => {
    const h = await bootstrap("a05-restart"); const before = await stateOf(h);
    const restarted = makeService(h.store, "a05-restart-ids-b"); const after = await restarted.recover(h.gameId);
    expect(after.state).toEqual(before); expect(after.state?.status).toBe("IN_PROGRESS");
  });

  it("A05-02 command idempotency survives restart without adding events", async () => {
    const store = new InMemoryDurableGameStore(); const first = makeService(store, "idem-a", 0); const gameId = "a05-idem"; const command = createCommand(gameId, "stable-create");
    const receipt = await first.handle(host, command); const count = (await store.loadEvents(gameId)).length;
    const restarted = makeService(store, "idem-b", 0); expect(await restarted.handle(host, command)).toEqual(receipt); expect(await store.loadEvents(gameId)).toHaveLength(count);
  });

  it("A05-03 same commandId with different payload remains rejected after restart", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "reuse-a", 0); const gameId = "a05-reuse";
    await service.handle(host, createCommand(gameId, "same-id")); const restarted = makeService(store, "reuse-b", 0);
    await expect(restarted.handle(host, seatsCommand(gameId, "same-id"))).rejects.toMatchObject({ code: "COMMAND_ID_REUSED" });
  });

  it("A05-04 explicit checkpoint is persisted at the latest command boundary", async () => {
    const h = await bootstrap("a05-checkpoint", new InMemoryDurableGameStore(), 0); await h.service.checkpoint(h.gameId);
    const raw = await h.store.loadLatestSnapshot(h.gameId); expect(raw).not.toBeNull(); const recovered = await h.service.recover(h.gameId); expect(recovered.source).toBe("SNAPSHOT");
  });

  it("A05-05 snapshots from inside a multi-event command are rejected", async () => {
    const h = await bootstrap("a05-boundary", new InMemoryDurableGameStore(), 0); const events = await h.store.loadEvents(h.gameId); const receipts = await h.store.loadReceipts(h.gameId); const startReceipt = receipts.find((r) => r.commandId === `${h.gameId}-start`); if (startReceipt === undefined) throw new Error("start receipt");
    const mid = replay(events.filter((raw) => (raw as { sequence: number }).sequence <= startReceipt.firstSequence)); if (mid === null) throw new Error("mid state");
    const snapshot = createGameSnapshot(mid, "test-mid", new FixedClock()); await expect(h.store.saveSnapshot(snapshot)).rejects.toMatchObject({ code: "INVALID_SNAPSHOT" });
  });

  it("A05-06 valid snapshot plus tail reproduces full replay state", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "tail-a", 0); const gameId = "a05-tail";
    await service.handle(host, createCommand(gameId)); await service.handle(host, seatsCommand(gameId)); await service.handle(host, lockCommand(gameId)); await service.checkpoint(gameId); await service.handle(host, startCommand(gameId));
    const recovered = await service.recover(gameId); const full = replay(await store.loadEvents(gameId)); expect(recovered.source).toBe("SNAPSHOT"); expect(recovered.state).toEqual(full);
  });

  it("A05-07 corrupted snapshot is discarded and full event replay recovers the game", async () => {
    const h = await bootstrap("a05-corrupt", new InMemoryDurableGameStore(), 0); await h.service.checkpoint(h.gameId); const truth = replay(await h.store.loadEvents(h.gameId));
    h.store.corruptLatestSnapshot(h.gameId, (raw) => ({ ...(raw as Record<string, unknown>), stateHashSha256: "0".repeat(64) }));
    const recovered = await h.service.recover(h.gameId); expect(recovered.source).toBe("FULL_REPLAY"); expect(recovered.discardedSnapshotReason).not.toBeNull(); expect(recovered.state).toEqual(truth);
  });

  it("A05-08 missing snapshot falls back to complete replay", async () => {
    const h = await bootstrap("a05-no-snapshot", new InMemoryDurableGameStore(), 0); h.store.clearSnapshots(h.gameId); const recovered = await h.service.recover(h.gameId); expect(recovered.source).toBe("FULL_REPLAY");
  });

  it("A05-09 snapshot engine build may differ when schema/contract/handlers remain compatible", async () => {
    const h = await bootstrap("a05-build-compat", new InMemoryDurableGameStore(), 0); await h.service.checkpoint(h.gameId);
    const restarted = new DurableGameService({ store: h.store, clock: new FixedClock(), ids: new CountingIds("new-build"), random: new FixedRandom(), engineBuildId: "brand-new-build", snapshotEveryEvents: 0 });
    const recovered = await restarted.recover(h.gameId); expect(recovered.source).toBe("SNAPSHOT"); expect(recovered.state?.gameId).toBe(h.gameId);
  });

  it("A05-10 unsupported historical event version becomes HISTORY_ONLY instead of being continued", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "old-event", 0); const gameId = "a05-history-only"; await service.handle(host, createCommand(gameId));
    store.mutateEvent(gameId, 1, (event) => ({ ...(event as Record<string, unknown>), eventVersion: "9.0.0" }));
    const compatibility = await assessContinuationCompatibility(store, gameId); expect(compatibility.mode).toBe("HISTORY_ONLY"); expect((await store.loadEvents(gameId)).length).toBe(1);
  });

  it("A05-11 pending hunter reaction survives restart and is not duplicated", async () => {
    const h = await bootstrap("a05-hunter", new InMemoryDurableGameStore(), 0); const pending = await createHunterReaction(h); await h.service.checkpoint(h.gameId);
    const restarted = makeService(h.store, "hunter-restart", 0); let state = (await restarted.recover(h.gameId)).state; expect(state?.runtime?.phase?.phaseType).toBe("DAWN_HUNTER_REACTION"); expect(state?.runtime?.pendingReactions.filter((r) => r.status === "OPEN")).toHaveLength(1);
    await restarted.handle(player(pending.hunterId), { commandId: "hunter-after-restart", gameId: h.gameId, actorPlayerId: pending.hunterId, commandType: "CommitHunterReaction", payload: { action: "PASS", targetPlayerId: null }, windowToken: pending.reactionToken });
    state = (await restarted.recover(h.gameId)).state; expect(state?.runtime?.pendingReactions.some((r) => r.status === "OPEN")).toBe(false); expect(state?.runtime?.phase?.phaseType).toBe("DAWN_READY_FOR_DAY");
  });

  it("A05-12 two different commands planned from one revision allow at most one atomic append", async () => {
    const store = new InMemoryDurableGameStore(); const durable = makeService(store, "race-seed", 0); const gameId = "a05-race"; await durable.handle(host, createCommand(gameId)); const recovered = await durable.recover(gameId); if (recovered.state === null) throw new Error("state");
    const plan = (command: Command, prefix: string) => { const repo = new PlanningGameRepository(recovered.state); const service = new GameService({ repository: repo, clock: new FixedClock(), ids: new CountingIds(prefix), random: new FixedRandom(), engineBuildId: "race" }); service.handle(host, command); const result = repo.takePlannedAppend(); if (result === null) throw new Error("plan"); return result; };
    const a = plan(seatsCommand(gameId, "race-a", " A"), "race-a-id"); const b = plan(seatsCommand(gameId, "race-b", " B"), "race-b-id");
    const settled = await Promise.allSettled([store.atomicAppend(gameId, a.expectedSequence, a.events, a.receipt), store.atomicAppend(gameId, b.expectedSequence, b.events, b.receipt)]);
    expect(settled.filter((x) => x.status === "fulfilled")).toHaveLength(1); expect(settled.filter((x) => x.status === "rejected")).toHaveLength(1);
  });

  it("A05-13 snapshot cache write failure does not roll back committed truth", async () => {
    class FailingSnapshotStore extends InMemoryDurableGameStore { override async saveSnapshot(_snapshot: GameSnapshot): Promise<void> { throw new CoreError("PERSISTENCE_ERROR", "snapshot unavailable"); } }
    const store = new FailingSnapshotStore(); const errors: unknown[] = []; const service = makeService(store, "snapshot-fail", 1, (error) => errors.push(error)); const gameId = "a05-cache-fail";
    await service.handle(host, createCommand(gameId)); expect(await store.loadEvents(gameId)).toHaveLength(1); expect(errors).toHaveLength(1); expect((await service.recover(gameId)).state?.status).toBe("LOBBY");
  });

  it("A05-14 automatic snapshot interval creates a recoverable cache", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "auto-snapshot", 1); const gameId = "a05-auto"; await service.handle(host, createCommand(gameId));
    expect(await store.loadLatestSnapshot(gameId)).not.toBeNull(); expect((await service.recover(gameId)).source).toBe("SNAPSHOT");
  });

  it("A05-15 snapshots contain state only and events/receipts remain separate repository truth", async () => {
    const h = await bootstrap("a05-snapshot-shape", new InMemoryDurableGameStore(), 0); await h.service.checkpoint(h.gameId); const raw = await h.store.loadLatestSnapshot(h.gameId) as Record<string, unknown>;
    expect(raw).toHaveProperty("state"); expect(raw).not.toHaveProperty("events"); expect(raw).not.toHaveProperty("commandReceipts");
  });

  it("A05-16 PostgreSQL migration defines separate transactional truth/cache tables", () => {
    const sql = readFileSync(new URL("../../db/migrations/0001_a05_event_store.sql", import.meta.url), "utf8");
    expect(sql).toContain("werewolf_games"); expect(sql).toContain("werewolf_events"); expect(sql).toContain("werewolf_command_receipts"); expect(sql).toContain("werewolf_snapshots"); expect(sql).toContain("primary key (game_id, sequence)"); expect(sql).toContain("command_id text primary key");
  });
  it("A05-17 pg-pool adapter wraps one interactive transaction with BEGIN/COMMIT", async () => {
    const log: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> { log.push(sql); return { rows: [], rowCount: 0 }; },
      release(): void { log.push("release"); },
    };
    const pool = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> { log.push(`pool:${sql}`); return { rows: [], rowCount: 0 }; },
      async connect() { return client; },
    };
    const db = createPgDatabasePortFromPool(pool);
    const value = await db.transaction(async (session) => { await session.query("select 1"); return 7; });
    expect(value).toBe(7); expect(log).toEqual(["begin", "select 1", "commit", "release"]);
  });

  it("A05-18 pg-pool adapter rolls back and releases on transaction failure", async () => {
    const log: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> { log.push(sql); return { rows: [], rowCount: 0 }; },
      release(): void { log.push("release"); },
    };
    const pool = { async query(): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> { return { rows: [], rowCount: 0 }; }, async connect() { return client; } };
    const db = createPgDatabasePortFromPool(pool);
    await expect(db.transaction(async () => { throw new Error("boom"); })).rejects.toMatchObject({ message: "boom" });
    expect(log).toEqual(["begin", "rollback", "release"]);
  });

  it("A05-19 incompatible role/ability registry versions become HISTORY_ONLY", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "old-registry", 0); const gameId = "a05-old-registry"; await service.handle(host, createCommand(gameId));
    store.mutateEvent(gameId, 1, (raw) => {
      const event = structuredClone(raw) as Record<string, unknown>;
      const payload = event.payload as Record<string, unknown>;
      const ruleset = payload.rulesetDraft as Record<string, unknown>;
      const definitions = structuredClone(ruleset.roleDefinitions) as Array<Record<string, unknown>>;
      definitions[0] = { ...definitions[0], roleVersion: "9.0.0" };
      ruleset.roleDefinitions = definitions;
      return event;
    });
    expect((await assessContinuationCompatibility(store, gameId)).mode).toBe("HISTORY_ONLY");
  });

  it("A05-20 corrupted sequence remains an invalid stream, not a compatibility downgrade", async () => {
    const store = new InMemoryDurableGameStore(); const service = makeService(store, "bad-sequence", 0); const gameId = "a05-bad-sequence"; await service.handle(host, createCommand(gameId));
    store.mutateEvent(gameId, 1, (event) => ({ ...(event as Record<string, unknown>), sequence: 2 }));
    await expect(assessContinuationCompatibility(store, gameId)).rejects.toMatchObject({ code: "INVALID_EVENT_STREAM" });
  });

});
