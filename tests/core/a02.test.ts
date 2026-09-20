import { describe, expect, it } from "vitest";
import {
  CoreError,
  GameService,
  InMemoryGameRepository,
  assertRegisteredHandler,
  exportBundle,
  getRegisteredAbility,
  importBundle,
  registrySnapshot,
  replay,
  supportedRulesetSnapshot,
  type ClockPort,
  type Command,
  type GameState,
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
    return `a02-id-${this.calls}`;
  }
}

class FixedRandom implements RandomPort {
  readonly algorithmId = "test.fixed";
  readonly privateSeed: string | null = "test-only-seed";
  calls = 0;
  readonly #values: number[];
  constructor(values: number[] = [0]) { this.#values = values; }
  randomInt(exclusiveUpperBound: number): number {
    const value = this.#values[this.calls % this.#values.length] ?? 0;
    this.calls += 1;
    return value % exclusiveUpperBound;
  }
}

function harness() {
  const repository = new InMemoryGameRepository();
  const clock = new FixedClock();
  const ids = new CountingIds();
  const random = new FixedRandom([0, 1, 2, 3]);
  const service = new GameService({ repository, clock, ids, random, engineBuildId: "test-build-a02" });
  return { repository, clock, ids, random, service };
}

const host = { kind: "HOST", hostId: "host-1" } as const;

function player(playerId: string) {
  return { kind: "PLAYER", playerId } as const;
}

function seats(): Seat[] {
  return Array.from({ length: 12 }, (_, index) => ({
    playerId: `player-${index + 1}`,
    seatNumber: index + 1,
    displayName: `Player ${index + 1}`,
    controllerType: index % 3 === 0 ? "NPC" as const : "HUMAN" as const,
  }));
}

function hostCommand(gameId: string, commandType: "CreateGame" | "ConfigureSeats" | "LockGame" | "StartGame", commandId: string): Command {
  switch (commandType) {
    case "CreateGame": return { commandId, gameId, actorPlayerId: null, commandType, payload: { rulesetSnapshot: supportedRulesetSnapshot() }, windowToken: null };
    case "ConfigureSeats": return { commandId, gameId, actorPlayerId: null, commandType, payload: { seats: seats() }, windowToken: null };
    case "LockGame": return { commandId, gameId, actorPlayerId: null, commandType, payload: {}, windowToken: null };
    case "StartGame": return { commandId, gameId, actorPlayerId: null, commandType, payload: {}, windowToken: null };
  }
}

function setupLocked(gameId = "a02-game") {
  const h = harness();
  h.service.handle(host, hostCommand(gameId, "CreateGame", `${gameId}-create`));
  h.service.handle(host, hostCommand(gameId, "ConfigureSeats", `${gameId}-seats`));
  h.service.handle(host, hostCommand(gameId, "LockGame", `${gameId}-lock`));
  return { ...h, gameId };
}

function setupStarted(gameId = "a02-game") {
  const h = setupLocked(gameId);
  h.service.handle(host, hostCommand(gameId, "StartGame", `${gameId}-start`));
  return h;
}

function stateOf(h: ReturnType<typeof setupLocked>): GameState {
  const state = replay(h.repository.loadEvents(h.gameId));
  if (state === null) throw new Error("missing state");
  return state;
}

function playerWithRole(h: ReturnType<typeof setupLocked>, roleId: string): string {
  const assignment = stateOf(h).lockedSetup?.assignments.find((entry) => entry.assignedRoleId === roleId);
  if (assignment === undefined) throw new Error(`missing ${roleId}`);
  return assignment.playerId;
}

function wolfPlayers(h: ReturnType<typeof setupLocked>): string[] {
  return stateOf(h).lockedSetup?.assignments.filter((entry) => entry.assignedFactionId === "WOLF").map((entry) => entry.playerId) ?? [];
}

function token(h: ReturnType<typeof setupLocked>): string {
  const value = stateOf(h).runtime?.nightSession.currentActionSession?.sessionId;
  if (value === undefined) throw new Error("missing token");
  return value;
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

function guard(h: ReturnType<typeof setupStarted>, targetPlayerId: string | null, commandId = `${h.gameId}-guard`): Command {
  const actorPlayerId = playerWithRole(h, "GUARD");
  return { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitGuardAction", payload: { targetPlayerId }, windowToken: token(h) };
}

function beauty(h: ReturnType<typeof setupStarted>, targetPlayerId: string | null, commandId = `${h.gameId}-beauty`): Command {
  const actorPlayerId = playerWithRole(h, "WOLF_BEAUTY");
  return targetPlayerId === null
    ? { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitBeautyAction", payload: { mode: "KEEP", targetPlayerId: null }, windowToken: token(h) }
    : { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitBeautyAction", payload: { mode: "CHARM", targetPlayerId }, windowToken: token(h) };
}

function witch(h: ReturnType<typeof setupStarted>, action: "PASS" | "HEAL" | "POISON", targetPlayerId: string | null, commandId = `${h.gameId}-witch`): Command {
  const actorPlayerId = playerWithRole(h, "WITCH");
  if (action === "PASS") return { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitWitchAction", payload: { action, targetPlayerId: null }, windowToken: token(h) };
  if (targetPlayerId === null) throw new Error("target required");
  return { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitWitchAction", payload: { action, targetPlayerId }, windowToken: token(h) };
}

function seer(h: ReturnType<typeof setupStarted>, targetPlayerId: string | null, commandId = `${h.gameId}-seer`): Command {
  const actorPlayerId = playerWithRole(h, "SEER");
  return { commandId, gameId: h.gameId, actorPlayerId, commandType: "CommitSeerAction", payload: { targetPlayerId }, windowToken: token(h) };
}

function submitWolfBallot(h: ReturnType<typeof setupStarted>, actorPlayerId: string, targetPlayerId: string | null, commandId: string): void {
  h.service.handle(player(actorPlayerId), {
    commandId,
    gameId: h.gameId,
    actorPlayerId,
    commandType: "CommitWolfBallot",
    payload: { targetPlayerId },
    windowToken: token(h),
  });
}

function advanceToWolf(h: ReturnType<typeof setupStarted>): void {
  const guardId = playerWithRole(h, "GUARD");
  h.service.handle(player(guardId), guard(h, null));
}

function advanceToBeauty(h: ReturnType<typeof setupStarted>, targets?: readonly (string | null)[]): string | null {
  advanceToWolf(h);
  const wolves = wolfPlayers(h);
  const fallback = stateOf(h).runtime?.nightSession.nightStartAlivePlayerIds.find((id) => !wolves.includes(id)) ?? null;
  for (const [index, wolfId] of wolves.entries()) submitWolfBallot(h, wolfId, targets?.[index] ?? fallback, `${h.gameId}-wolf-${index}`);
  const team = stateOf(h).runtime?.abilityStates.find((entry) => entry.kind === "WOLF_TEAM");
  return team?.kind === "WOLF_TEAM" ? team.knifeTargetPlayerId : null;
}

function advanceToWitch(h: ReturnType<typeof setupStarted>, wolfTargets?: readonly (string | null)[]): string | null {
  const knife = advanceToBeauty(h, wolfTargets);
  const beautyId = playerWithRole(h, "WOLF_BEAUTY");
  h.service.handle(player(beautyId), beauty(h, null));
  return knife;
}

function advanceToSeer(h: ReturnType<typeof setupStarted>, witchAction: "PASS" | "HEAL" | "POISON" = "PASS", witchTarget?: string): void {
  const knife = advanceToWitch(h);
  const witchId = playerWithRole(h, "WITCH");
  const target = witchAction === "PASS" ? null : (witchTarget ?? knife);
  h.service.handle(player(witchId), witch(h, witchAction, target));
}

describe("A-02 registry, runtime, night intents and resources", () => {
  it("A02-01 registry whitelists 7 roles, 11 versioned abilities and handler IDs", () => {
    const registry = registrySnapshot();
    expect(registry.roles).toHaveLength(7);
    expect(registry.abilities).toHaveLength(11);
    expect(new Set(registry.handlerIds).size).toBe(11);
    expect(getRegisteredAbility("WITCH_HEAL").effectHandlerId).toBe("witch.heal.v1");
    expect(() => assertRegisteredHandler("witch.heal.v1")).not.toThrow();
    coreError(() => assertRegisteredHandler("eval.user-code"), "UNSUPPORTED_RULESET");
    coreError(() => getRegisteredAbility("UNKNOWN"), "UNSUPPORTED_RULESET");
  });

  it("A02-02 StartGame initializes runtime and opens first guard phase/session", () => {
    const h = setupStarted();
    const state = stateOf(h);
    expect(state.status).toBe("IN_PROGRESS");
    expect(state.runtime?.round).toBe(1);
    expect(state.runtime?.players).toHaveLength(12);
    expect(state.runtime?.players.every((entry) => entry.lifeState === "ALIVE")).toBe(true);
    expect(state.runtime?.phase?.phaseType).toBe("NIGHT_GUARD");
    expect(state.runtime?.nightSession.nightStartAlivePlayerIds).toHaveLength(12);
    expect(state.runtime?.nightSession.currentActionSession?.eligibleActorsSnapshot).toEqual([playerWithRole(h, "GUARD")]);
    const witchState = state.runtime?.abilityStates.find((entry) => entry.kind === "WITCH");
    expect(witchState?.kind === "WITCH" ? [witchState.healRemaining, witchState.poisonRemaining] : null).toEqual([1, 1]);
    expect(state.lastSequence).toBe(6);
  });

  it("A02-03 StartGame is idempotent for same commandId and rejects a distinct second start", () => {
    const h = setupLocked("start-idem");
    const command = hostCommand(h.gameId, "StartGame", "start-once");
    const first = h.service.handle(host, command);
    const eventCount = h.repository.loadEvents(h.gameId).length;
    expect(h.service.handle(host, command)).toEqual(first);
    expect(h.repository.loadEvents(h.gameId)).toHaveLength(eventCount);
    coreError(() => h.service.handle(host, hostCommand(h.gameId, "StartGame", "start-twice")), "GAME_ALREADY_STARTED");
  });

  it("A02-04 player command requires matching principal and current opaque windowToken", () => {
    const h = setupStarted("auth-window");
    const command = guard(h, null);
    const before = h.repository.loadEvents(h.gameId).length;
    coreError(() => h.service.handle(player("someone-else"), command), "UNAUTHORIZED");
    coreError(() => h.service.handle(player(command.actorPlayerId!), { ...command, commandId: "bad-token", windowToken: "old-window" }), "INVALID_WINDOW_TOKEN");
    expect(h.repository.loadEvents(h.gameId)).toHaveLength(before);
  });

  it("A02-05 guard may self-protect or pass; commit closes guard and opens wolf window", () => {
    const h = setupStarted("guard-self");
    const guardId = playerWithRole(h, "GUARD");
    h.service.handle(player(guardId), guard(h, guardId));
    const state = stateOf(h);
    expect(state.runtime?.phase?.phaseType).toBe("NIGHT_WOLF");
    const guardState = state.runtime?.abilityStates.find((entry) => entry.kind === "GUARD");
    expect(guardState?.kind === "GUARD" ? [guardState.lastNightNumber, guardState.lastTargetPlayerId] : null).toEqual([1, guardId]);
    expect(state.runtime?.nightSession.intents.find((intent) => intent.intentType === "GUARD")?.targetPlayerId).toBe(guardId);
  });

  it("A02-06 wolf ballots accept any night-start player including self/team and pass, with no edit after commit", () => {
    const h = setupStarted("wolf-flex");
    advanceToWolf(h);
    const wolves = wolfPlayers(h);
    expect(wolves).toHaveLength(4);
    submitWolfBallot(h, wolves[0]!, wolves[0]!, "wolf-self");
    const oldToken = token(h);
    coreError(() => submitWolfBallot(h, wolves[0]!, null, "wolf-revote"), "ACTION_ALREADY_COMMITTED");
    submitWolfBallot(h, wolves[1]!, wolves[0]!, "wolf-team");
    submitWolfBallot(h, wolves[2]!, null, "wolf-pass");
    expect(token(h)).toBe(oldToken);
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("NIGHT_WOLF");
  });

  it("A02-07 final wolf ballot locks the unique plurality target and advances to beauty", () => {
    const h = setupStarted("wolf-plurality");
    advanceToWolf(h);
    const wolves = wolfPlayers(h);
    const target = playerWithRole(h, "SEER");
    const votes = [target, target, target, null] as const;
    for (const [index, wolfId] of wolves.entries()) submitWolfBallot(h, wolfId, votes[index] ?? null, `plural-${index}`);
    const state = stateOf(h);
    const team = state.runtime?.abilityStates.find((entry) => entry.kind === "WOLF_TEAM");
    expect(team?.kind === "WOLF_TEAM" ? [team.knifeTargetStatus, team.knifeTargetPlayerId] : null).toEqual(["LOCKED", target]);
    expect(state.runtime?.phase?.phaseType).toBe("NIGHT_BEAUTY");
  });

  it("A02-08 tied highest wolf ballots become NO_KILL (locked null target)", () => {
    const h = setupStarted("wolf-tie");
    advanceToWolf(h);
    const wolves = wolfPlayers(h);
    const a = playerWithRole(h, "SEER");
    const b = playerWithRole(h, "WITCH");
    const votes = [a, a, b, b];
    for (const [index, wolfId] of wolves.entries()) submitWolfBallot(h, wolfId, votes[index]!, `tie-${index}`);
    const team = stateOf(h).runtime?.abilityStates.find((entry) => entry.kind === "WOLF_TEAM");
    expect(team?.kind === "WOLF_TEAM" ? [team.knifeTargetStatus, team.knifeTargetPlayerId] : null).toEqual(["LOCKED", null]);
  });

  it("A02-09 beauty cannot charm self, may charm wolf teammate, and KEEP is a typed intent", () => {
    const h = setupStarted("beauty-target");
    advanceToBeauty(h);
    const beautyId = playerWithRole(h, "WOLF_BEAUTY");
    coreError(() => h.service.handle(player(beautyId), beauty(h, beautyId, "self-charm")), "INVALID_TARGET");
    const teammate = wolfPlayers(h).find((id) => id !== beautyId)!;
    h.service.handle(player(beautyId), beauty(h, teammate, "team-charm"));
    const intent = stateOf(h).runtime?.nightSession.intents.find((entry) => entry.intentType === "BEAUTY");
    expect(intent?.intentType === "BEAUTY" ? [intent.mode, intent.targetPlayerId] : null).toEqual(["CHARM", teammate]);

    const pass = setupStarted("beauty-keep");
    advanceToBeauty(pass);
    const passId = playerWithRole(pass, "WOLF_BEAUTY");
    pass.service.handle(player(passId), beauty(pass, null));
    const passIntent = stateOf(pass).runtime?.nightSession.intents.find((entry) => entry.intentType === "BEAUTY");
    expect(passIntent?.intentType === "BEAUTY" ? passIntent.mode : null).toBe("KEEP");
  });

  it("A02-10 witch HEAL must target actual knife target and atomically spends heal resource", () => {
    const h = setupStarted("witch-heal");
    const witchId = playerWithRole(h, "WITCH");
    const wolves = wolfPlayers(h);
    advanceToWitch(h, wolves.map(() => witchId));
    const wrong = playerWithRole(h, "SEER");
    const before = h.repository.loadEvents(h.gameId).length;
    coreError(() => h.service.handle(player(witchId), witch(h, "HEAL", wrong, "bad-heal")), "INVALID_TARGET");
    expect(h.repository.loadEvents(h.gameId)).toHaveLength(before);
    const receipt = h.service.handle(player(witchId), witch(h, "HEAL", witchId, "good-heal"));
    expect(receipt.lastSequence - receipt.firstSequence + 1).toBe(6);
    const witchState = stateOf(h).runtime?.abilityStates.find((entry) => entry.kind === "WITCH");
    expect(witchState?.kind === "WITCH" ? [witchState.healRemaining, witchState.poisonRemaining] : null).toEqual([0, 1]);
  });

  it("A02-11 witch POISON rejects self, spends only poison, and PASS spends nothing", () => {
    const h = setupStarted("witch-poison");
    advanceToWitch(h);
    const witchId = playerWithRole(h, "WITCH");
    coreError(() => h.service.handle(player(witchId), witch(h, "POISON", witchId, "poison-self")), "INVALID_TARGET");
    const victim = playerWithRole(h, "SEER");
    h.service.handle(player(witchId), witch(h, "POISON", victim, "poison-other"));
    const poisonState = stateOf(h).runtime?.abilityStates.find((entry) => entry.kind === "WITCH");
    expect(poisonState?.kind === "WITCH" ? [poisonState.healRemaining, poisonState.poisonRemaining] : null).toEqual([1, 0]);

    const pass = setupStarted("witch-pass");
    advanceToWitch(pass);
    const passId = playerWithRole(pass, "WITCH");
    pass.service.handle(player(passId), witch(pass, "PASS", null));
    const passState = stateOf(pass).runtime?.abilityStates.find((entry) => entry.kind === "WITCH");
    expect(passState?.kind === "WITCH" ? [passState.healRemaining, passState.poisonRemaining] : null).toEqual([1, 1]);
  });

  it("A02-12 seer may pass or target another night-start player, never self", () => {
    const h = setupStarted("seer-target");
    advanceToSeer(h);
    const seerId = playerWithRole(h, "SEER");
    coreError(() => h.service.handle(player(seerId), seer(h, seerId, "seer-self")), "INVALID_TARGET");
    const target = playerWithRole(h, "WITCH");
    h.service.handle(player(seerId), seer(h, target, "seer-check"));
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("NIGHT_READY_FOR_RESOLUTION");

    const pass = setupStarted("seer-pass");
    advanceToSeer(pass);
    const passId = playerWithRole(pass, "SEER");
    pass.service.handle(player(passId), seer(pass, null));
    expect(stateOf(pass).runtime?.phase?.phaseType).toBe("NIGHT_READY_FOR_RESOLUTION");
  });

  it("A02-13 full A-02 first night stops before effects/deaths/outcome", () => {
    const h = setupStarted("a02-stop");
    advanceToSeer(h);
    const seerId = playerWithRole(h, "SEER");
    h.service.handle(player(seerId), seer(h, null));
    const state = stateOf(h);
    expect(state.runtime?.nightSession.status).toBe("READY_FOR_RESOLUTION");
    expect(state.runtime?.nightSession.currentActionSession).toBeNull();
    expect(state.runtime?.players.every((entry) => entry.lifeState === "ALIVE")).toBe(true);
    expect(state.runtime?.statusEffects).toEqual([]);
    expect(state.runtime?.resolutionGroup).toBeNull();
    expect(state.runtime?.outcome).toBeNull();
    expect(state.status).toBe("IN_PROGRESS");
  });

  it("A02-14 same successful player command retry returns original receipt with no duplicate intent/resource", () => {
    const h = setupStarted("player-idem");
    const guardId = playerWithRole(h, "GUARD");
    const command = guard(h, null, "guard-once");
    const first = h.service.handle(player(guardId), command);
    const count = h.repository.loadEvents(h.gameId).length;
    expect(h.service.handle(player(guardId), command)).toEqual(first);
    expect(h.repository.loadEvents(h.gameId)).toHaveLength(count);
    expect(stateOf(h).runtime?.nightSession.intents.filter((intent) => intent.intentType === "GUARD")).toHaveLength(1);
  });

  it("A02-15 same commandId with changed player request or principal is COMMAND_ID_REUSED", () => {
    const h = setupStarted("player-reuse");
    const guardId = playerWithRole(h, "GUARD");
    const command = guard(h, null, "shared-player-id");
    h.service.handle(player(guardId), command);
    coreError(() => h.service.handle(player(guardId), { ...command, payload: { targetPlayerId: guardId } }), "COMMAND_ID_REUSED");
    coreError(() => h.service.handle(player("other"), command), "COMMAND_ID_REUSED");
  });

  it("A02-16 export/import round-trip preserves multi-event receipts and exact runtime", () => {
    const h = setupStarted("a02-roundtrip");
    advanceToSeer(h, "PASS");
    const text = exportBundle(h.repository, h.gameId);
    const target = new InMemoryGameRepository();
    importBundle(target, text);
    expect(replay(target.loadEvents(h.gameId))).toEqual(stateOf(h));
    expect(target.loadReceipts(h.gameId)).toEqual(h.repository.loadReceipts(h.gameId));
  });

  it("A02-17 import rejects corrupted multi-event receipt range atomically", () => {
    const source = setupStarted("receipt-corrupt");
    const bundle = JSON.parse(exportBundle(source.repository, source.gameId)) as { commandReceipts: Array<{ outcomeCode: string; lastSequence: number }> };
    const startReceipt = bundle.commandReceipts.find((receipt) => receipt.outcomeCode === "GAME_STARTED");
    if (startReceipt === undefined) throw new Error("missing start receipt");
    startReceipt.lastSequence -= 1;
    const target = new InMemoryGameRepository();
    coreError(() => importBundle(target, JSON.stringify(bundle)), "INVALID_EVENT_STREAM");
    expect(target.hasGame(source.gameId)).toBe(false);
  });

  it("A02-18 replay rejects forged action-session eligibility instead of trusting event payload", () => {
    const h = setupStarted("forged-session");
    const events = h.repository.loadEvents(h.gameId);
    const opened = events.find((event) => event.eventType === "ActionWindowOpened");
    if (opened?.eventType !== "ActionWindowOpened") throw new Error("missing window");
    opened.payload.session.eligibleActorsSnapshot = [playerWithRole(h, "SEER")];
    coreError(() => replay(events), "INVALID_EVENT_STREAM");
  });


  it("A02-19 replay rejects a forged phase skip even if later application code is bypassed", () => {
    const h = setupStarted("phase-skip");
    const guardId = playerWithRole(h, "GUARD");
    h.service.handle(player(guardId), guard(h, null));
    const events = h.repository.loadEvents(h.gameId);
    const phaseOpens = events.filter((event) => event.eventType === "PhaseOpened");
    const second = phaseOpens[1];
    if (second?.eventType !== "PhaseOpened") throw new Error("missing second phase");
    second.payload.phaseType = "NIGHT_SEER";
    coreError(() => replay(events), "INVALID_EVENT_STREAM");
  });

  it("A02-20 replay rejects closing a witch HEAL window if AbilityResourceSpent is missing", () => {
    const h = setupStarted("missing-spend");
    const witchId = playerWithRole(h, "WITCH");
    const wolves = wolfPlayers(h);
    advanceToWitch(h, wolves.map(() => witchId));
    h.service.handle(player(witchId), witch(h, "HEAL", witchId, "heal-with-spend"));
    const events = h.repository.loadEvents(h.gameId);
    const spendIndex = events.findIndex((event) => event.eventType === "AbilityResourceSpent");
    if (spendIndex < 0) throw new Error("missing resource event");
    const forged = events.filter((_, index) => index !== spendIndex).map((event, index) => ({ ...event, sequence: index + 1 }));
    coreError(() => replay(forged), "INVALID_EVENT_STREAM");
  });
});
