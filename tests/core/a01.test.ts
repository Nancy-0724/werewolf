import { describe, expect, it } from "vitest";
import {
  CoreError,
  GameService,
  InMemoryGameRepository,
  assertJsonSerializable,
  exportBundle,
  importBundle,
  replay,
  supportedRulesetSnapshot,
  type ClockPort,
  type Command,
  type IdPort,
  type RandomPort,
  type Seat,
} from "../../src/index.js";

class FixedClock implements ClockPort {
  calls = 0;
  nowIso(): string {
    this.calls += 1;
    return "2026-09-19T08:00:00.000Z";
  }
}

class CountingIds implements IdPort {
  calls = 0;
  nextId(): string {
    this.calls += 1;
    return `id-${this.calls}`;
  }
}

class FixedRandom implements RandomPort {
  public readonly algorithmId = "test.fixed";
  public readonly privateSeed: string | null = "test-only-seed";
  calls = 0;
  readonly #values: number[];
  public constructor(values: number[] = [0]) { this.#values = values; }
  randomInt(exclusiveUpperBound: number): number {
    const value = this.#values[this.calls % this.#values.length] ?? 0;
    this.calls += 1;
    return value % exclusiveUpperBound;
  }
}

class InvalidRandom implements RandomPort {
  readonly algorithmId = "test.invalid";
  readonly privateSeed = null;
  calls = 0;
  randomInt(exclusiveUpperBound: number): number {
    this.calls += 1;
    return exclusiveUpperBound;
  }
}

function harness(random: RandomPort = new FixedRandom()) {
  const repository = new InMemoryGameRepository();
  const clock = new FixedClock();
  const ids = new CountingIds();
  const service = new GameService({ repository, random, clock, ids, engineBuildId: "test-build" });
  return { repository, clock, ids, random, service };
}

const host = { kind: "HOST", hostId: "host-1" } as const;
const otherHost = { kind: "HOST", hostId: "host-2" } as const;
const playerPrincipal = { kind: "PLAYER", playerId: "p-1" } as const;

function seats(mixed = false): Seat[] {
  return Array.from({ length: 12 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    seatNumber: index + 1,
    displayName: `Player ${index + 1}`,
    controllerType: mixed && index % 2 === 1 ? "NPC" as const : "HUMAN" as const,
  }));
}

function createCommand(gameId: string, commandId = `${gameId}-create`): Command {
  return { commandId, gameId, actorPlayerId: null, commandType: "CreateGame", payload: { rulesetSnapshot: supportedRulesetSnapshot() }, windowToken: null };
}
function seatsCommand(gameId: string, value = seats(), commandId = `${gameId}-seats`): Command {
  return { commandId, gameId, actorPlayerId: null, commandType: "ConfigureSeats", payload: { seats: value }, windowToken: null };
}
function lockCommand(gameId: string, commandId = `${gameId}-lock`): Command {
  return { commandId, gameId, actorPlayerId: null, commandType: "LockGame", payload: {}, windowToken: null };
}
function abortCommand(gameId: string, commandId = `${gameId}-abort`): Command {
  return { commandId, gameId, actorPlayerId: null, commandType: "AbortGame", payload: { reason: "HOST_REQUEST" }, windowToken: null };
}

function setupLocked(h = harness(), gameId = "game-1", seatValue = seats()) {
  h.service.handle(host, createCommand(gameId));
  h.service.handle(host, seatsCommand(gameId, seatValue));
  const lock = lockCommand(gameId);
  h.service.handle(host, lock);
  return { ...h, gameId, lock };
}

function coreError(fn: () => unknown, code: CoreError["code"]): void {
  try {
    fn();
    throw new Error(`Expected CoreError ${code}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoreError);
    expect((error as CoreError).code).toBe(code);
  }
}

function anyCoreError(fn: () => unknown, allowed: readonly CoreError["code"][]): void {
  try {
    fn();
    throw new Error(`Expected one of: ${allowed.join(", ")}`);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(CoreError);
    expect(allowed).toContain((error as CoreError).code);
  }
}

describe("A-01 trusted game core", () => {
  it("T01 legal create -> configure -> lock stops at LOCKED with runtime null", () => {
    const h = setupLocked();
    const state = replay(h.repository.loadEvents(h.gameId));
    expect(state?.status).toBe("LOCKED");
    expect(state?.runtime).toBeNull();
    expect(state?.lastSequence).toBe(3);
  });

  it("T02 has exactly 12 roles and WOLF/GOD/VILLAGER 4/4/4 with exact role counts", () => {
    const { repository, gameId } = setupLocked();
    const assignments = replay(repository.loadEvents(gameId))?.lockedSetup?.assignments ?? [];
    expect(assignments).toHaveLength(12);
    const roles = Object.fromEntries([...new Set(assignments.map((a) => a.assignedRoleId))].map((id) => [id, assignments.filter((a) => a.assignedRoleId === id).length]));
    expect(roles).toEqual({ WEREWOLF: 3, WOLF_BEAUTY: 1, SEER: 1, WITCH: 1, HUNTER: 1, GUARD: 1, VILLAGER: 4 });
    const buckets = Object.fromEntries(["WOLF", "GOD", "VILLAGER"].map((bucket) => [bucket, assignments.filter((a) => a.victoryBucket === bucket).length]));
    expect(buckets).toEqual({ WOLF: 4, GOD: 4, VILLAGER: 4 });
  });

  it("T03 preserves mixed HUMAN/NPC seats without changing role multiset", () => {
    const mixedSeats = seats(true);
    const { repository, gameId } = setupLocked(harness(), "mixed", mixedSeats);
    const state = replay(repository.loadEvents(gameId));
    expect(state?.manifest?.seatsSnapshot.map((s) => s.controllerType)).toEqual(mixedSeats.map((s) => s.controllerType));
    expect(state?.lockedSetup?.assignments).toHaveLength(12);
  });

  it("T04 rejects under/over count, duplicate IDs/seats, blank name and invalid controller", () => {
    const variants: unknown[] = [];
    variants.push(seats().slice(0, 11));
    variants.push([...seats(), { playerId: "extra", seatNumber: 12, displayName: "x", controllerType: "HUMAN" }]);
    const dupPlayer = seats(); dupPlayer[1] = { ...dupPlayer[1]!, playerId: dupPlayer[0]!.playerId }; variants.push(dupPlayer);
    const dupSeat = seats(); dupSeat[1] = { ...dupSeat[1]!, seatNumber: dupSeat[0]!.seatNumber }; variants.push(dupSeat);
    const blank = seats(); blank[0] = { ...blank[0]!, displayName: "   " }; variants.push(blank);
    const invalidController = seats() as unknown as Array<Record<string, unknown>>; invalidController[0] = { ...invalidController[0]!, controllerType: "BOT" }; variants.push(invalidController);
    for (const [index, value] of variants.entries()) {
      const h = harness(); h.service.handle(host, createCommand(`bad-seat-${index}`));
      anyCoreError(() => h.service.handle(host, { commandId: `bad-${index}`, gameId: `bad-seat-${index}`, actorPlayerId: null, commandType: "ConfigureSeats", payload: { seats: value }, windowToken: null }), ["INVALID_INPUT", "INVALID_SEATS"]);
      expect(h.repository.loadEvents(`bad-seat-${index}`)).toHaveLength(1);
    }
  });

  it("T05 cannot lock before seats and PLAYER principal cannot execute HOST command", () => {
    const h = harness();
    coreError(() => h.service.handle(playerPrincipal, createCommand("player-host")), "UNAUTHORIZED");
    h.service.handle(host, createCommand("no-seats"));
    coreError(() => h.service.handle(host, lockCommand("no-seats")), "INVALID_SEATS");
  });

  it("T06 rejects unknown/forged ruleset role/version/faction/ability/options", () => {
    const mutations: Array<(r: ReturnType<typeof supportedRulesetSnapshot>) => void> = [
      (r) => { r.rulesetId = "unknown"; },
      (r) => { r.roleDefinitions[0]!.roleId = "FAKE"; },
      (r) => { r.roleDefinitions[0]!.roleVersion = "9.9.9"; },
      (r) => { r.roleDefinitions[0]!.factionId = "GOOD"; },
      (r) => { r.roleDefinitions[0]!.abilityRefs = ["SEER_CHECK"]; },
      (r) => { (r.options as { ordinaryVoteUnits: number }).ordinaryVoteUnits = 99; },
    ];
    for (const [index, mutate] of mutations.entries()) {
      const h = harness(); const rule = supportedRulesetSnapshot(); mutate(rule);
      anyCoreError(() => h.service.handle(host, { ...createCommand(`rule-${index}`), payload: { rulesetSnapshot: rule } }), ["INVALID_INPUT", "UNSUPPORTED_RULESET"]);
      expect(h.repository.hasGame(`rule-${index}`)).toBe(false);
    }
  });

  it("T07 after lock ConfigureSeats and second different LockGame fail and assignments stay fixed", () => {
    const h = setupLocked();
    const before = replay(h.repository.loadEvents(h.gameId))?.lockedSetup?.assignments;
    coreError(() => h.service.handle(host, seatsCommand(h.gameId, seats(), "after-lock-seats")), "GAME_ALREADY_LOCKED");
    coreError(() => h.service.handle(host, lockCommand(h.gameId, "different-lock")), "GAME_ALREADY_LOCKED");
    expect(replay(h.repository.loadEvents(h.gameId))?.lockedSetup?.assignments).toEqual(before);
  });

  it("T08 mutating original seat/ruleset inputs does not mutate stored state", () => {
    const h = harness();
    const rule = supportedRulesetSnapshot();
    const seatInput = seats();
    h.service.handle(host, { ...createCommand("mutation-input"), payload: { rulesetSnapshot: rule } });
    h.service.handle(host, seatsCommand("mutation-input", seatInput));
    rule.roleDefinitions[0]!.displayName = "HACK";
    seatInput[0]!.displayName = "HACK";
    const state = replay(h.repository.loadEvents("mutation-input"));
    expect(state?.lobby?.rulesetDraft.roleDefinitions[0]?.displayName).toBe("普通狼人");
    expect(state?.lobby?.seats[0]?.displayName).toBe("Player 1");
  });

  it("T09 mutating read state/events/export parsed object does not mutate repository", () => {
    const h = setupLocked();
    const state = replay(h.repository.loadEvents(h.gameId));
    state!.lockedSetup!.assignments[0]!.assignedRoleId = "HACK";
    const readEvents = h.repository.loadEvents(h.gameId);
    if (readEvents[2]?.eventType === "SetupLocked") readEvents[2].payload.lockedSetup.assignments[0]!.assignedRoleId = "HACK";
    const exported = JSON.parse(exportBundle(h.repository, h.gameId)) as { events: Array<{ eventId: string }> };
    exported.events[0]!.eventId = "HACK";
    const fresh = replay(h.repository.loadEvents(h.gameId));
    expect(fresh?.lockedSetup?.assignments[0]?.assignedRoleId).not.toBe("HACK");
    expect(h.repository.loadEvents(h.gameId)[0]?.eventId).not.toBe("HACK");
  });

  it("T10 idempotent CreateGame/LockGame add one event and never rerun RNG", () => {
    const random = new FixedRandom([0, 1, 0]); const h = harness(random);
    const create = createCommand("idem");
    expect(h.service.handle(host, create)).toEqual(h.service.handle(host, create));
    h.service.handle(host, seatsCommand("idem"));
    const lock = lockCommand("idem"); const first = h.service.handle(host, lock); const calls = random.calls;
    expect(h.service.handle(host, lock)).toEqual(first);
    expect(random.calls).toBe(calls);
    expect(h.repository.loadEvents("idem")).toHaveLength(3);
  });

  it("T11 same commandId with different payload or HOST principal is COMMAND_ID_REUSED", () => {
    const h = harness(); h.service.handle(host, createCommand("reuse"));
    const command = seatsCommand("reuse", seats(), "shared-id"); h.service.handle(host, command);
    const changed = seats(); changed[0] = { ...changed[0]!, displayName: "Changed" };
    coreError(() => h.service.handle(host, seatsCommand("reuse", changed, "shared-id")), "COMMAND_ID_REUSED");
    coreError(() => h.service.handle(otherHost, command), "COMMAND_ID_REUSED");
    coreError(() => h.service.handle(host, createCommand("other-game", "shared-id")), "COMMAND_ID_REUSED");
  });

  it("T12 event sequence/eventId are unique and game streams are isolated", () => {
    const h = harness(); setupLocked(h, "g1"); setupLocked(h, "g2");
    for (const id of ["g1", "g2"]) {
      const events = h.repository.loadEvents(id);
      expect(events.map((e) => e.sequence)).toEqual([1, 2, 3]);
      expect(new Set(events.map((e) => e.eventId)).size).toBe(3);
      expect(events.every((e) => e.gameId === id)).toBe(true);
    }
  });

  it("T13 replay rejects contradictory/gapped/duplicate/unknown type/version events", () => {
    const h = setupLocked(); const base = h.repository.loadEvents(h.gameId);
    const gap = structuredClone(base); gap[1]!.sequence = 9; coreError(() => replay(gap), "INVALID_EVENT_STREAM");
    const duplicate = [...structuredClone(base), structuredClone(base[2]!)]; coreError(() => replay(duplicate), "INVALID_EVENT_STREAM");
    const unknown = structuredClone(base) as unknown as Array<Record<string, unknown>>; unknown[1]!.eventType = "Unknown"; coreError(() => replay(unknown), "INVALID_EVENT_STREAM");
    const version = structuredClone(base) as unknown as Array<Record<string, unknown>>; version[1]!.eventVersion = "2.0.0"; coreError(() => replay(version), "UNSUPPORTED_EVENT_VERSION");
    const contradiction = structuredClone(base); if (contradiction[2]?.eventType === "SetupLocked") contradiction[2].payload.lockedSetup.assignments[0]!.assignedFactionId = "GOOD"; coreError(() => replay(contradiction), "INVALID_EVENT_STREAM");
  });

  it("T14 reducer/replay do not mutate input and replay is deterministic", () => {
    const h = setupLocked(); const events = h.repository.loadEvents(h.gameId); const before = JSON.stringify(events);
    const a = replay(events); const b = replay(events);
    expect(JSON.stringify(events)).toBe(before);
    expect(a).toEqual(b);
  });

  it("T15 replay does not call RNG, Clock or ID ports", () => {
    const random = new FixedRandom(); const h = setupLocked(harness(random));
    const counts = [random.calls, h.clock.calls, h.ids.calls];
    replay(h.repository.loadEvents(h.gameId)); replay(h.repository.loadEvents(h.gameId));
    expect([random.calls, h.clock.calls, h.ids.calls]).toEqual(counts);
  });

  it("T16 fixed RNG is reproducible; invalid RNG rejects with no partial write", () => {
    const a = setupLocked(harness(new FixedRandom([0, 1, 2])) , "ra");
    const b = setupLocked(harness(new FixedRandom([0, 1, 2])) , "rb");
    const rolesA = replay(a.repository.loadEvents("ra"))!.lockedSetup!.assignments.map((x) => x.assignedRoleId);
    const rolesB = replay(b.repository.loadEvents("rb"))!.lockedSetup!.assignments.map((x) => x.assignedRoleId);
    expect(rolesA).toEqual(rolesB);
    const bad = harness(new InvalidRandom()); bad.service.handle(host, createCommand("bad-rng")); bad.service.handle(host, seatsCommand("bad-rng"));
    coreError(() => bad.service.handle(host, lockCommand("bad-rng")), "INVALID_RANDOM_SOURCE");
    expect(bad.repository.loadEvents("bad-rng")).toHaveLength(2);
  });

  it("T17 atomic append writes nothing when event or receipt is invalid", () => {
    const h = setupLocked(); const before = h.repository.debugSnapshot(h.gameId);
    const goodAbort = {
      eventId: "manual-event", gameId: h.gameId, sequence: 4, eventType: "GameAborted", eventVersion: "1.0.0", transactionId: "manual-tx",
      causationCommandId: "manual-abort", causedByEventIds: [], phaseId: null, recordedAtIso: "2026-09-19T08:00:00.000Z", audience: { kind: "SYSTEM_TRUTH" }, payload: { reason: "HOST_REQUEST" }
    };
    const invalidSecond = { ...goodAbort, eventId: "manual-event-2", sequence: 5, eventVersion: "9.0.0" };
    coreError(() => h.repository.append(h.gameId, 3, [goodAbort, invalidSecond], {}), "UNSUPPORTED_EVENT_VERSION");
    expect(h.repository.debugSnapshot(h.gameId)).toEqual(before);
    coreError(() => h.repository.append(h.gameId, 3, [goodAbort], { nope: true }), "INVALID_EVENT_STREAM");
    expect(h.repository.debugSnapshot(h.gameId)).toEqual(before);
  });

  it("T18 competing append with same expectedSequence allows at most one write", () => {
    const h = harness(); h.service.handle(host, createCommand("race"));
    const baseEvent = h.repository.loadEvents("race")[0]!;
    const make = (suffix: string, seatValue: Seat[]) => ({
      event: { ...baseEvent, eventId: `event-${suffix}`, sequence: 2, eventType: "SeatsConfigured" as const, transactionId: `tx-${suffix}`, causationCommandId: `cmd-${suffix}`, payload: { seats: seatValue } },
      receipt: { commandId: `cmd-${suffix}`, gameId: "race", principalKey: "HOST:host-1", canonicalRequest: seatsCommand("race", seatValue, `cmd-${suffix}`), firstSequence: 2, lastSequence: 2, outcomeCode: "SEATS_CONFIGURED" as const }
    });
    const first = make("a", seats()); const secondSeats = seats(); secondSeats[0] = { ...secondSeats[0]!, displayName: "Other" }; const second = make("b", secondSeats);
    h.repository.append("race", 1, [first.event], first.receipt);
    coreError(() => h.repository.append("race", 1, [second.event], second.receipt), "CONCURRENCY_CONFLICT");
    expect(h.repository.loadEvents("race")).toHaveLength(2);
  });

  it("T19 JSON round-trip into a fresh store recreates exactly the same state", () => {
    const h = setupLocked(); const text = exportBundle(h.repository, h.gameId); const target = new InMemoryGameRepository(); importBundle(target, text);
    expect(replay(target.loadEvents(h.gameId))).toEqual(replay(h.repository.loadEvents(h.gameId)));
  });

  it("T20 imported old LockGame retry returns receipt without RNG or new event", () => {
    const source = setupLocked(); const text = exportBundle(source.repository, source.gameId); const random = new FixedRandom(); const target = harness(random); importBundle(target.repository, text);
    const beforeCalls = random.calls; const beforeCount = target.repository.loadEvents(source.gameId).length;
    const receipt = target.service.handle(host, source.lock);
    expect(receipt.outcomeCode).toBe("SETUP_LOCKED");
    expect(random.calls).toBe(beforeCalls);
    expect(target.repository.loadEvents(source.gameId)).toHaveLength(beforeCount);
  });

  it("T21 corrupted log/cross-game/missing/duplicate receipt imports reject without polluting store", () => {
    const source = setupLocked(); const clean = JSON.parse(exportBundle(source.repository, source.gameId)) as { gameId: string; events: Array<Record<string, unknown>>; commandReceipts: Array<Record<string, unknown>> };
    const corruptions: Array<(b: typeof clean) => void> = [
      (b) => { b.events[1]!.sequence = 99; },
      (b) => { b.commandReceipts[0]!.gameId = "other-game"; },
      (b) => { b.commandReceipts.pop(); },
      (b) => { b.commandReceipts.push(structuredClone(b.commandReceipts[0]!)); },
    ];
    for (const [index, corrupt] of corruptions.entries()) {
      const target = harness(); target.service.handle(host, createCommand(`existing-${index}`)); const existing = target.repository.debugSnapshot(`existing-${index}`);
      const bad = structuredClone(clean); corrupt(bad);
      coreError(() => importBundle(target.repository, JSON.stringify(bad)), "INVALID_EVENT_STREAM");
      expect(target.repository.debugSnapshot(`existing-${index}`)).toEqual(existing);
      expect(target.repository.hasGame(source.gameId)).toBe(false);
    }
  });

  it("T22 AbortGame preserves locked identity; new commands reject; same abort command retries", () => {
    const h = setupLocked(); const before = replay(h.repository.loadEvents(h.gameId))!.lockedSetup!.assignments;
    const abort = abortCommand(h.gameId); const receipt = h.service.handle(host, abort); expect(h.service.handle(host, abort)).toEqual(receipt);
    const state = replay(h.repository.loadEvents(h.gameId)); expect(state?.status).toBe("ABORTED"); expect(state?.lockedSetup?.assignments).toEqual(before);
    coreError(() => h.service.handle(host, lockCommand(h.gameId, "new-after-abort")), "GAME_ABORTED");
  });

  it("T23 forged SetRole/PatchState and extra SYSTEM fields are rejected", () => {
    const h = harness();
    for (const commandType of ["SetRole", "PatchState"]) {
      coreError(() => h.service.handle(host, { commandId: commandType, gameId: "x", actorPlayerId: null, commandType, payload: {}, windowToken: null }), "INVALID_INPUT");
    }
    coreError(() => h.service.handle(host, { ...createCommand("extra"), source: "SYSTEM" }), "INVALID_INPUT");
  });

  it("T24 core state/events/receipts/export are pure JSON values", () => {
    const h = setupLocked(); const state = replay(h.repository.loadEvents(h.gameId));
    expect(() => assertJsonSerializable(state)).not.toThrow();
    expect(() => assertJsonSerializable(h.repository.loadEvents(h.gameId))).not.toThrow();
    expect(() => assertJsonSerializable(h.repository.loadReceipts(h.gameId))).not.toThrow();
    expect(() => assertJsonSerializable(JSON.parse(exportBundle(h.repository, h.gameId)))).not.toThrow();
  });
});
