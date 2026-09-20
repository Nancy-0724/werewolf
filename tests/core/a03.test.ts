import { describe, expect, it } from "vitest";
import {
  GameService,
  InMemoryGameRepository,
  replay,
  supportedRulesetSnapshot,
  type ClockPort,
  type Command,
  type GameState,
  type IdPort,
  type RandomPort,
  type Seat,
} from "../../src/index.js";

class FixedClock implements ClockPort { nowIso(): string { return "2026-09-19T10:00:00.000Z"; } }
class CountingIds implements IdPort { calls = 0; nextId(): string { this.calls += 1; return `a03-id-${this.calls}`; } }
class FixedRandom implements RandomPort {
  readonly algorithmId = "test.fixed";
  readonly privateSeed: string | null = "test-only-seed";
  calls = 0;
  randomInt(exclusiveUpperBound: number): number { const values = [0, 1, 2, 3]; const value = values[this.calls % values.length] ?? 0; this.calls += 1; return value % exclusiveUpperBound; }
}
const host = { kind: "HOST", hostId: "host-1" } as const;
const player = (playerId: string) => ({ kind: "PLAYER", playerId }) as const;
const seats = (): Seat[] => Array.from({ length: 12 }, (_, index) => ({ playerId: `player-${index + 1}`, seatNumber: index + 1, displayName: `Player ${index + 1}`, controllerType: "HUMAN" as const }));

function harness(gameId: string) {
  const repository = new InMemoryGameRepository();
  const service = new GameService({ repository, clock: new FixedClock(), ids: new CountingIds(), random: new FixedRandom(), engineBuildId: "test-build-a03" });
  const hostCommand = (commandType: "CreateGame" | "ConfigureSeats" | "LockGame" | "StartGame", commandId: string): Command => {
    if (commandType === "CreateGame") return { commandId, gameId, actorPlayerId: null, commandType, payload: { rulesetSnapshot: supportedRulesetSnapshot() }, windowToken: null };
    if (commandType === "ConfigureSeats") return { commandId, gameId, actorPlayerId: null, commandType, payload: { seats: seats() }, windowToken: null };
    return { commandId, gameId, actorPlayerId: null, commandType, payload: {}, windowToken: null };
  };
  service.handle(host, hostCommand("CreateGame", `${gameId}-create`));
  service.handle(host, hostCommand("ConfigureSeats", `${gameId}-seats`));
  service.handle(host, hostCommand("LockGame", `${gameId}-lock`));
  service.handle(host, hostCommand("StartGame", `${gameId}-start`));
  return { gameId, repository, service };
}
function stateOf(h: ReturnType<typeof harness>): GameState { const value = replay(h.repository.loadEvents(h.gameId)); if (value === null) throw new Error("missing state"); return value; }
function role(h: ReturnType<typeof harness>, roleId: string): string { const value = stateOf(h).lockedSetup?.assignments.find((entry) => entry.assignedRoleId === roleId)?.playerId; if (value === undefined) throw new Error(`missing ${roleId}`); return value; }
function wolves(h: ReturnType<typeof harness>): string[] { return stateOf(h).lockedSetup?.assignments.filter((entry) => entry.assignedFactionId === "WOLF").map((entry) => entry.playerId) ?? []; }
function token(h: ReturnType<typeof harness>): string { const value = stateOf(h).runtime?.nightSession.currentActionSession?.sessionId; if (value === undefined) throw new Error("missing action token"); return value; }
function guard(h: ReturnType<typeof harness>, targetPlayerId: string | null): void { const actorPlayerId = role(h, "GUARD"); h.service.handle(player(actorPlayerId), { commandId: `${h.gameId}-guard`, gameId: h.gameId, actorPlayerId, commandType: "CommitGuardAction", payload: { targetPlayerId }, windowToken: token(h) }); }
function knife(h: ReturnType<typeof harness>, targetPlayerId: string | null): void { for (const [index, actorPlayerId] of wolves(h).entries()) h.service.handle(player(actorPlayerId), { commandId: `${h.gameId}-wolf-${index}`, gameId: h.gameId, actorPlayerId, commandType: "CommitWolfBallot", payload: { targetPlayerId }, windowToken: token(h) }); }
function beauty(h: ReturnType<typeof harness>, targetPlayerId: string | null): void { const actorPlayerId = role(h, "WOLF_BEAUTY"); h.service.handle(player(actorPlayerId), targetPlayerId === null ? { commandId: `${h.gameId}-beauty`, gameId: h.gameId, actorPlayerId, commandType: "CommitBeautyAction", payload: { mode: "KEEP", targetPlayerId: null }, windowToken: token(h) } : { commandId: `${h.gameId}-beauty`, gameId: h.gameId, actorPlayerId, commandType: "CommitBeautyAction", payload: { mode: "CHARM", targetPlayerId }, windowToken: token(h) }); }
function witch(h: ReturnType<typeof harness>, action: "PASS" | "HEAL" | "POISON", targetPlayerId: string | null): void { const actorPlayerId = role(h, "WITCH"); const payload = action === "PASS" ? { action, targetPlayerId: null } as const : action === "HEAL" ? { action, targetPlayerId: targetPlayerId ?? "" } as const : { action, targetPlayerId: targetPlayerId ?? "" } as const; h.service.handle(player(actorPlayerId), { commandId: `${h.gameId}-witch`, gameId: h.gameId, actorPlayerId, commandType: "CommitWitchAction", payload, windowToken: token(h) }); }
function seer(h: ReturnType<typeof harness>, targetPlayerId: string | null): void { const actorPlayerId = role(h, "SEER"); h.service.handle(player(actorPlayerId), { commandId: `${h.gameId}-seer`, gameId: h.gameId, actorPlayerId, commandType: "CommitSeerAction", payload: { targetPlayerId }, windowToken: token(h) }); }
function resolve(h: ReturnType<typeof harness>): void { h.service.handle(host, { commandId: `${h.gameId}-resolve`, gameId: h.gameId, actorPlayerId: null, commandType: "ResolveNight", payload: {}, windowToken: null }); }
function runNight(h: ReturnType<typeof harness>, options: { guardTarget?: string | null; knifeTarget: string | null; beautyTarget?: string | null; witchAction?: "PASS" | "HEAL" | "POISON"; witchTarget?: string | null; seerTarget?: string | null }): void {
  guard(h, options.guardTarget ?? null); knife(h, options.knifeTarget); beauty(h, options.beautyTarget ?? null); witch(h, options.witchAction ?? "PASS", options.witchTarget ?? null); seer(h, options.seerTarget ?? null); resolve(h);
}

describe("A-03 night resolution, death waves, hunter and checkpoint", () => {
  it("A03-01 guard alone prevents wolf attack", () => {
    const h = harness("guard-prevents"); const target = role(h, "VILLAGER"); runNight(h, { guardTarget: target, knifeTarget: target });
    expect(stateOf(h).runtime?.players.find((entry) => entry.playerId === target)?.lifeState).toBe("ALIVE");
  });

  it("A03-02 witch heal alone prevents wolf attack", () => {
    const h = harness("heal-prevents"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: target, witchAction: "HEAL", witchTarget: target });
    expect(stateOf(h).runtime?.players.find((entry) => entry.playerId === target)?.lifeState).toBe("ALIVE");
  });

  it("A03-03 guard plus heal collision kills attacked player with collision cause", () => {
    const h = harness("collision"); const target = role(h, "VILLAGER"); runNight(h, { guardTarget: target, knifeTarget: target, witchAction: "HEAL", witchTarget: target });
    const death = stateOf(h).runtime?.resolutionGroup?.deathRecords.find((entry) => entry.playerId === target);
    expect(death?.causes).toContain("GUARD_HEAL_COLLISION"); expect(death?.causes).toContain("WEREWOLF_ATTACK");
  });

  it("A03-04 poison and wolf attack on same player create one death record with both causes", () => {
    const h = harness("multi-cause"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: target, witchAction: "POISON", witchTarget: target });
    const records = stateOf(h).runtime?.resolutionGroup?.deathRecords.filter((entry) => entry.playerId === target) ?? [];
    expect(records).toHaveLength(1); expect(records[0]?.causes).toEqual(expect.arrayContaining(["WEREWOLF_ATTACK", "WITCH_POISON"]));
  });

  it("A03-05 new beauty charm is applied and source death links target in same death wave", () => {
    const h = harness("beauty-link"); const beautyId = role(h, "WOLF_BEAUTY"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: beautyId, beautyTarget: target });
    const linked = stateOf(h).runtime?.resolutionGroup?.deathRecords.find((entry) => entry.playerId === target);
    expect(linked?.causes).toContain("WOLF_BEAUTY_LINK");
  });

  it("A03-06 seer resolution creates truth event and fixed private observation", () => {
    const h = harness("seer-result"); const seerId = role(h, "SEER"); const wolfId = wolves(h)[0]; if (wolfId === undefined) throw new Error("missing wolf"); runNight(h, { knifeTarget: null, seerTarget: wolfId });
    const events = h.repository.loadEvents(h.gameId);
    expect(events.some((event) => event.eventType === "SeerCheckResolved" && event.payload.result === "WOLF")).toBe(true);
    const observation = events.find((event) => event.eventType === "PrivateObservationPublished");
    expect(observation?.audience).toEqual({ kind: "PRIVATE_RECIPIENTS", playerIds: [seerId] });
  });

  it("A03-07 dawn announcement is PUBLIC and exposes only dead player IDs", () => {
    const h = harness("dawn"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: target });
    const dawn = h.repository.loadEvents(h.gameId).find((event) => event.eventType === "DawnAnnouncementPublished");
    expect(dawn?.audience.kind).toBe("PUBLIC"); expect(dawn?.payload.deadPlayerIds).toEqual([target]); expect("causes" in (dawn?.payload ?? {})).toBe(false);
  });

  it("A03-08 hunter killed by ordinary wolf attack receives reaction window after dawn", () => {
    const h = harness("hunter-wolf"); const hunterId = role(h, "HUNTER"); runNight(h, { knifeTarget: hunterId });
    const s = stateOf(h); expect(s.runtime?.phase?.phaseType).toBe("DAWN_HUNTER_REACTION"); expect(s.runtime?.pendingReactions[0]?.actorPlayerId).toBe(hunterId);
  });

  it("A03-09 hunter killed by guard-heal collision may still shoot", () => {
    const h = harness("hunter-collision"); const hunterId = role(h, "HUNTER"); runNight(h, { guardTarget: hunterId, knifeTarget: hunterId, witchAction: "HEAL", witchTarget: hunterId });
    expect(stateOf(h).runtime?.pendingReactions.some((entry) => entry.status === "OPEN")).toBe(true);
  });

  it("A03-10 poisoned hunter gets no reaction window", () => {
    const h = harness("hunter-poison"); const hunterId = role(h, "HUNTER"); const knifeTarget = role(h, "VILLAGER"); runNight(h, { knifeTarget, witchAction: "POISON", witchTarget: hunterId });
    expect(stateOf(h).runtime?.pendingReactions.some((entry) => entry.status === "OPEN")).toBe(false); expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAWN_READY_FOR_DAY");
  });

  it("A03-11 charmed hunter gets no reaction window", () => {
    const h = harness("hunter-charm"); const hunterId = role(h, "HUNTER"); const beautyId = role(h, "WOLF_BEAUTY"); runNight(h, { knifeTarget: beautyId, beautyTarget: hunterId });
    expect(stateOf(h).runtime?.resolutionGroup?.deathRecords.find((entry) => entry.playerId === hunterId)?.causes).toContain("WOLF_BEAUTY_LINK");
    expect(stateOf(h).runtime?.pendingReactions.some((entry) => entry.status === "OPEN")).toBe(false);
  });

  it("A03-12 hunter PASS spends shot and settles group", () => {
    const h = harness("hunter-pass"); const hunterId = role(h, "HUNTER"); runNight(h, { knifeTarget: hunterId }); const reaction = stateOf(h).runtime?.pendingReactions.find((entry) => entry.status === "OPEN"); if (reaction === undefined) throw new Error("missing reaction");
    h.service.handle(player(hunterId), { commandId: `${h.gameId}-reaction`, gameId: h.gameId, actorPlayerId: hunterId, commandType: "CommitHunterReaction", payload: { action: "PASS", targetPlayerId: null }, windowToken: reaction.sessionId });
    const s = stateOf(h); expect(s.runtime?.resolutionGroup?.status).toBe("SETTLED"); expect(s.runtime?.phase?.phaseType).toBe("DAWN_READY_FOR_DAY"); const hunter = s.runtime?.abilityStates.find((entry) => entry.kind === "HUNTER"); expect(hunter?.kind === "HUNTER" ? hunter.shotRemaining : null).toBe(0);
  });

  it("A03-13 hunter shot creates a later death wave", () => {
    const h = harness("hunter-shot"); const hunterId = role(h, "HUNTER"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: hunterId }); const reaction = stateOf(h).runtime?.pendingReactions.find((entry) => entry.status === "OPEN"); if (reaction === undefined) throw new Error("missing reaction");
    h.service.handle(player(hunterId), { commandId: `${h.gameId}-reaction`, gameId: h.gameId, actorPlayerId: hunterId, commandType: "CommitHunterReaction", payload: { action: "SHOOT", targetPlayerId: target }, windowToken: reaction.sessionId });
    expect(stateOf(h).runtime?.resolutionGroup?.deathRecords.find((entry) => entry.playerId === target)?.causes).toContain("HUNTER_SHOT");
  });

  it("A03-14 hunter shooting beauty triggers current charm target without undoing hunter shot", () => {
    const h = harness("shot-beauty"); const hunterId = role(h, "HUNTER"); const beautyId = role(h, "WOLF_BEAUTY"); const charmTarget = stateOf(h).runtime?.players.find((entry) => entry.effectiveFactionId === "GOOD" && entry.playerId !== hunterId)?.playerId; if (charmTarget === undefined) throw new Error("missing charm target");
    runNight(h, { knifeTarget: hunterId, beautyTarget: charmTarget }); const reaction = stateOf(h).runtime?.pendingReactions.find((entry) => entry.status === "OPEN"); if (reaction === undefined) throw new Error("missing reaction");
    h.service.handle(player(hunterId), { commandId: `${h.gameId}-reaction`, gameId: h.gameId, actorPlayerId: hunterId, commandType: "CommitHunterReaction", payload: { action: "SHOOT", targetPlayerId: beautyId }, windowToken: reaction.sessionId });
    const deaths = stateOf(h).runtime?.resolutionGroup?.deathRecords ?? []; expect(deaths.find((entry) => entry.playerId === beautyId)?.causes).toContain("HUNTER_SHOT"); expect(deaths.find((entry) => entry.playerId === charmTarget)?.causes).toContain("WOLF_BEAUTY_LINK");
  });

  it("A03-15 no open hunter reaction settles at DAWN_READY_FOR_DAY and does not start A-04", () => {
    const h = harness("a03-boundary"); const target = role(h, "VILLAGER"); runNight(h, { knifeTarget: target }); const s = stateOf(h);
    expect(s.status).toBe("IN_PROGRESS"); expect(s.runtime?.phase?.phaseType).toBe("DAWN_READY_FOR_DAY"); expect(s.runtime?.outcome).toBeNull(); expect(s.runtime?.speechSession).toBeNull(); expect(s.runtime?.voteSession).toBeNull();
  });

  it("A03-16 ResolveNight is idempotent for same commandId", () => {
    const h = harness("resolve-idempotent"); const target = role(h, "VILLAGER"); guard(h, null); knife(h, target); beauty(h, null); witch(h, "PASS", null); seer(h, null);
    const command: Command = { commandId: `${h.gameId}-resolve`, gameId: h.gameId, actorPlayerId: null, commandType: "ResolveNight", payload: {}, windowToken: null };
    const first = h.service.handle(host, command); const eventCount = h.repository.loadEvents(h.gameId).length; const second = h.service.handle(host, command); expect(second).toEqual(first); expect(h.repository.loadEvents(h.gameId)).toHaveLength(eventCount);
  });
});
