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
class CountingIds implements IdPort { calls = 0; nextId(): string { this.calls += 1; return `a04-id-${this.calls}`; } }
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
  const service = new GameService({ repository, clock: new FixedClock(), ids: new CountingIds(), random: new FixedRandom(), engineBuildId: "test-build-a04" });
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
function rolePlayers(h: ReturnType<typeof harness>, roleId: string): string[] { return stateOf(h).lockedSetup?.assignments.filter((entry) => entry.assignedRoleId === roleId).map((entry) => entry.playerId) ?? []; }
function wolves(h: ReturnType<typeof harness>): string[] { return stateOf(h).lockedSetup?.assignments.filter((entry) => entry.assignedFactionId === "WOLF").map((entry) => entry.playerId) ?? []; }
function nightToken(h: ReturnType<typeof harness>): string { const value = stateOf(h).runtime?.nightSession.currentActionSession?.sessionId; if (value === undefined) throw new Error("missing night token"); return value; }
function playerCommand(h: ReturnType<typeof harness>, actorPlayerId: string, command: Omit<Extract<Command, { actorPlayerId: string }>, "gameId" | "actorPlayerId">): void { h.service.handle(player(actorPlayerId), { ...command, gameId: h.gameId, actorPlayerId } as Command); }
function passNight(h: ReturnType<typeof harness>, knifeTarget: string | null = null): void {
  const night = stateOf(h).runtime?.round ?? 1;
  let actor = role(h, "GUARD"); playerCommand(h, actor, { commandId: `${h.gameId}-n${night}-guard`, commandType: "CommitGuardAction", payload: { targetPlayerId: null }, windowToken: nightToken(h) });
  for (const [index, wolf] of wolves(h).entries()) playerCommand(h, wolf, { commandId: `${h.gameId}-n${night}-wolf-${index}`, commandType: "CommitWolfBallot", payload: { targetPlayerId: knifeTarget }, windowToken: nightToken(h) });
  actor = role(h, "WOLF_BEAUTY"); playerCommand(h, actor, { commandId: `${h.gameId}-n${night}-beauty`, commandType: "CommitBeautyAction", payload: { mode: "KEEP", targetPlayerId: null }, windowToken: nightToken(h) });
  actor = role(h, "WITCH"); playerCommand(h, actor, { commandId: `${h.gameId}-n${night}-witch`, commandType: "CommitWitchAction", payload: { action: "PASS", targetPlayerId: null }, windowToken: nightToken(h) });
  actor = role(h, "SEER"); playerCommand(h, actor, { commandId: `${h.gameId}-n${night}-seer`, commandType: "CommitSeerAction", payload: { targetPlayerId: null }, windowToken: nightToken(h) });
  h.service.handle(host, { commandId: `${h.gameId}-n${night}-resolve`, gameId: h.gameId, actorPlayerId: null, commandType: "ResolveNight", payload: {}, windowToken: null });
}
function beginDay(h: ReturnType<typeof harness>): void { const round = stateOf(h).runtime?.round ?? 1; h.service.handle(host, { commandId: `${h.gameId}-r${round}-begin-day`, gameId: h.gameId, actorPlayerId: null, commandType: "BeginDay", payload: {}, windowToken: null }); }
function commitSpeech(h: ReturnType<typeof harness>, actor: string, prefix: string, text: string | null = null): void {
  const token = stateOf(h).runtime?.speechSession?.sessionId; if (token === undefined) throw new Error("missing speech token");
  if (text === null) playerCommand(h, actor, { commandId: `${prefix}-${actor}`, commandType: "CommitSpeech", payload: { mode: "PASS", text: null, source: null }, windowToken: token });
  else playerCommand(h, actor, { commandId: `${prefix}-${actor}`, commandType: "CommitSpeech", payload: { mode: "SPEAK", text, source: "HUMAN_TEXT" }, windowToken: token });
}
function finishSpeechSession(h: ReturnType<typeof harness>, prefix: string): void { const speakers = stateOf(h).runtime?.speechSession?.speakerOrderSnapshot ?? []; for (const speaker of speakers) commitSpeech(h, speaker, prefix); }
function sheriffSignup(h: ReturnType<typeof harness>, joined: ReadonlySet<string>): void { const session = stateOf(h).runtime?.sheriff.signupSession; if (session === null || session === undefined) throw new Error("missing signup"); for (const actor of session.eligiblePlayersSnapshot) playerCommand(h, actor, { commandId: `${h.gameId}-signup-${actor}`, commandType: "CommitSheriffSignup", payload: { join: joined.has(actor) }, windowToken: session.sessionId }); }
function noSheriffToDiscussion(h: ReturnType<typeof harness>): void { sheriffSignup(h, new Set()); expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_DISCUSSION"); }
function voteAll(h: ReturnType<typeof harness>, targetFor: (voter: string, index: number) => string | null, prefix: string): void { const session = stateOf(h).runtime?.voteSession; if (session === null || session === undefined) throw new Error("missing vote"); for (const [index, voter] of session.eligibleVotersSnapshot.entries()) playerCommand(h, voter, { commandId: `${prefix}-${voter}`, commandType: "CommitBallot", payload: { targetPlayerId: targetFor(voter, index) }, windowToken: session.sessionId }); }

function electSingleSheriffAndOpenDiscussion(h: ReturnType<typeof harness>, sheriff: string): void {
  sheriffSignup(h, new Set([sheriff]));
  expect(stateOf(h).runtime?.sheriff.holderPlayerId).toBe(sheriff);
  const phase = stateOf(h).runtime?.phase; if (phase?.phaseType !== "DAY_ORDER_SELECTION") throw new Error("missing order phase");
  const first = stateOf(h).runtime?.players.find((entry) => entry.lifeState === "ALIVE" && entry.playerId !== sheriff)?.playerId; if (first === undefined) throw new Error("missing first speaker");
  playerCommand(h, sheriff, { commandId: `${h.gameId}-order`, commandType: "ChooseDaySpeechOrder", payload: { firstSpeakerPlayerId: first, direction: "ASC" }, windowToken: phase.phaseId });
}

describe("A-04 sheriff, speech, vote, PK, self explosion, last words and loop", () => {
  it("A04-01 BeginDay after peaceful first night opens sheriff signup", () => { const h = harness("a04-begin"); passNight(h); beginDay(h); expect(stateOf(h).runtime?.phase?.phaseType).toBe("SHERIFF_SIGNUP"); });

  it("A04-02 first-night ordinary death receives last words before sheriff election", () => { const h = harness("a04-last-words"); const target = rolePlayers(h, "VILLAGER")[0]; if (target === undefined) throw new Error("villager"); passNight(h, target); beginDay(h); expect(stateOf(h).runtime?.phase?.phaseType).toBe("LAST_WORDS"); finishSpeechSession(h, "lw"); expect(stateOf(h).runtime?.phase?.phaseType).toBe("SHERIFF_SIGNUP"); });

  it("A04-03 one sheriff candidate is directly elected without opening a vote", () => { const h = harness("a04-single"); passNight(h); beginDay(h); const candidate = rolePlayers(h, "VILLAGER")[0]; if (candidate === undefined) throw new Error("candidate"); sheriffSignup(h, new Set([candidate])); expect(stateOf(h).runtime?.sheriff.holderPlayerId).toBe(candidate); expect(stateOf(h).runtime?.voteSession).toBeNull(); expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_ORDER_SELECTION"); });

  it("A04-04 no candidate produces NO_BADGE and starts day discussion", () => { const h = harness("a04-no-candidate"); passNight(h); beginDay(h); noSheriffToDiscussion(h); expect(stateOf(h).runtime?.sheriff.badgeStatus).toBe("NO_BADGE"); });

  it("A04-05 withdrawn candidate does not become a sheriff voter", () => {
    const h = harness("a04-withdraw"); passNight(h); beginDay(h); const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("candidates"); sheriffSignup(h, new Set([a, b])); finishSpeechSession(h, "campaign"); const ws = stateOf(h).runtime?.sheriff.withdrawalSession; if (ws === null || ws === undefined) throw new Error("withdraw session");
    for (const actor of ws.candidatePlayersSnapshot) playerCommand(h, actor, { commandId: `wd-${actor}`, commandType: "CommitSheriffWithdrawal", payload: { withdraw: actor === b }, windowToken: ws.sessionId });
    expect(stateOf(h).runtime?.sheriff.holderPlayerId).toBe(a); expect(stateOf(h).runtime?.sheriff.originalVoterPlayerIds).not.toContain(b);
  });

  it("A04-06 sheriff election uses 2 units for every eligible voter", () => {
    const h = harness("a04-sheriff-units"); passNight(h); beginDay(h); const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("candidates"); sheriffSignup(h, new Set([a, b])); finishSpeechSession(h, "sp"); const ws = stateOf(h).runtime?.sheriff.withdrawalSession; if (ws === null || ws === undefined) throw new Error("withdraw"); for (const actor of ws.candidatePlayersSnapshot) playerCommand(h, actor, { commandId: `stay-${actor}`, commandType: "CommitSheriffWithdrawal", payload: { withdraw: false }, windowToken: ws.sessionId }); const vs = stateOf(h).runtime?.voteSession; expect(new Set(Object.values(vs?.weightUnitsByVoter ?? {}))).toEqual(new Set([2]));
  });

  it("A04-07 sheriff election tie opens one PK speech round", () => {
    const h = harness("a04-sheriff-pk"); passNight(h); beginDay(h); const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("candidates"); sheriffSignup(h, new Set([a, b])); finishSpeechSession(h, "sp"); const ws = stateOf(h).runtime?.sheriff.withdrawalSession; if (ws === null || ws === undefined) throw new Error("withdraw"); for (const actor of ws.candidatePlayersSnapshot) playerCommand(h, actor, { commandId: `stay-${actor}`, commandType: "CommitSheriffWithdrawal", payload: { withdraw: false }, windowToken: ws.sessionId }); let index = 0; voteAll(h, () => (index++ % 2 === 0 ? a : b), "sv"); expect(stateOf(h).runtime?.phase?.phaseType).toBe("SHERIFF_PK_SPEECH");
  });

  it("A04-08 sheriff chooses first non-sheriff speaker and always speaks last", () => { const h = harness("a04-order"); passNight(h); beginDay(h); const sheriff = rolePlayers(h, "VILLAGER")[0]; if (sheriff === undefined) throw new Error("sheriff"); electSingleSheriffAndOpenDiscussion(h, sheriff); const order = stateOf(h).runtime?.speechSession?.speakerOrderSnapshot ?? []; expect(order.at(-1)).toBe(sheriff); expect(order[0]).not.toBe(sheriff); });

  it("A04-09 day exile vote gives sheriff 3 units and others 2", () => { const h = harness("a04-day-units"); passNight(h); beginDay(h); const sheriff = rolePlayers(h, "VILLAGER")[0]; if (sheriff === undefined) throw new Error("sheriff"); electSingleSheriffAndOpenDiscussion(h, sheriff); finishSpeechSession(h, "day"); const vs = stateOf(h).runtime?.voteSession; expect(vs?.weightUnitsByVoter[sheriff]).toBe(3); expect(Object.entries(vs?.weightUnitsByVoter ?? {}).filter(([id]) => id !== sheriff).every(([, weight]) => weight === 2)).toBe(true); });

  it("A04-10 day vote tie opens PK and tied candidates cannot vote in PK", () => { const h = harness("a04-day-pk"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day"); const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("targets"); let index = 0; voteAll(h, () => (index++ % 2 === 0 ? a : b), "dv"); expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_PK_SPEECH"); finishSpeechSession(h, "pk"); const voters = stateOf(h).runtime?.voteSession?.eligibleVotersSnapshot ?? []; expect(voters).not.toContain(a); expect(voters).not.toContain(b); });

  it("A04-11 second PK tie produces no exile and advances to next night", () => { const h = harness("a04-no-exile"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day"); const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("targets"); let i = 0; voteAll(h, () => (i++ % 2 === 0 ? a : b), "v1"); finishSpeechSession(h, "pk"); let j = 0; voteAll(h, () => (j++ % 2 === 0 ? a : b), "v2"); expect(stateOf(h).runtime?.round).toBe(2); });

  it("A04-12 formal exile is VOTE_EXECUTION and receives last words", () => { const h = harness("a04-exile"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day"); const target = rolePlayers(h, "VILLAGER")[0]; if (target === undefined) throw new Error("target"); voteAll(h, () => target, "vote"); expect(stateOf(h).runtime?.resolutionGroup?.deathRecords.find((d) => d.playerId === target)?.causes).toContain("VOTE_EXECUTION"); expect(stateOf(h).runtime?.phase?.phaseType).toBe("LAST_WORDS"); });

  it("A04-13 speech text claiming a role never changes effective identity", () => { const h = harness("a04-claim"); passNight(h); beginDay(h); noSheriffToDiscussion(h); const speaker = stateOf(h).runtime?.speechSession?.speakerOrderSnapshot[0]; if (speaker === undefined) throw new Error("speaker"); const before = stateOf(h).runtime?.players.find((p) => p.playerId === speaker)?.effectiveRoleId; commitSpeech(h, speaker, "claim", "我是女巫"); expect(stateOf(h).runtime?.players.find((p) => p.playerId === speaker)?.effectiveRoleId).toBe(before); });

  it("A04-14 any living wolf may self-explode during day speech, not only current speaker", () => { const h = harness("a04-boom"); passNight(h); beginDay(h); noSheriffToDiscussion(h); const session = stateOf(h).runtime?.speechSession; const wolf = wolves(h).find((id) => id !== session?.speakerOrderSnapshot[0]); if (session === null || session === undefined || wolf === undefined) throw new Error("wolf/session"); playerCommand(h, wolf, { commandId: "boom", commandType: "CommitSelfExplosion", payload: {}, windowToken: session.sessionId }); expect(stateOf(h).runtime?.players.find((p) => p.playerId === wolf)?.lifeState).toBe("DEAD"); expect(stateOf(h).runtime?.round).toBe(2); });

  it("A04-15 self explosion during sheriff speech cancels election for the game", () => { const h = harness("a04-election-boom"); passNight(h); beginDay(h); const candidates = rolePlayers(h, "VILLAGER").slice(0, 2); sheriffSignup(h, new Set(candidates)); const session = stateOf(h).runtime?.speechSession; const wolf = wolves(h)[0]; if (session === null || session === undefined || wolf === undefined) throw new Error("session/wolf"); playerCommand(h, wolf, { commandId: "election-boom", commandType: "CommitSelfExplosion", payload: {}, windowToken: session.sessionId }); expect(stateOf(h).runtime?.sheriff.badgeStatus).toBe("NO_BADGE"); expect(stateOf(h).runtime?.round).toBe(2); });

  it("A04-16 dead sheriff can transfer badge after exile resolution and last words", () => { const h = harness("a04-transfer"); passNight(h); beginDay(h); const sheriff = rolePlayers(h, "VILLAGER")[0]; if (sheriff === undefined) throw new Error("sheriff"); electSingleSheriffAndOpenDiscussion(h, sheriff); finishSpeechSession(h, "day"); voteAll(h, () => sheriff, "vote"); finishSpeechSession(h, "last"); const phase = stateOf(h).runtime?.phase; expect(phase?.phaseType).toBe("SHERIFF_BADGE_ACTION"); const target = stateOf(h).runtime?.players.find((p) => p.lifeState === "ALIVE")?.playerId; if (phase === null || phase === undefined || target === undefined) throw new Error("badge target"); playerCommand(h, sheriff, { commandId: "transfer", commandType: "CommitSheriffBadgeAction", payload: { action: "TRANSFER", targetPlayerId: target }, windowToken: phase.phaseId }); expect(stateOf(h).runtime?.sheriff.holderPlayerId).toBe(target); expect(stateOf(h).runtime?.round).toBe(2); });

  it("A04-17 badge may be destroyed instead of transferred", () => { const h = harness("a04-destroy"); passNight(h); beginDay(h); const sheriff = rolePlayers(h, "VILLAGER")[0]; if (sheriff === undefined) throw new Error("sheriff"); electSingleSheriffAndOpenDiscussion(h, sheriff); finishSpeechSession(h, "day"); voteAll(h, () => sheriff, "vote"); finishSpeechSession(h, "last"); const phase = stateOf(h).runtime?.phase; if (phase === null || phase === undefined) throw new Error("phase"); playerCommand(h, sheriff, { commandId: "destroy", commandType: "CommitSheriffBadgeAction", payload: { action: "DESTROY", targetPlayerId: null }, windowToken: phase.phaseId }); expect(stateOf(h).runtime?.sheriff.badgeStatus).toBe("DESTROYED"); });

  it("A04-18 dead night role is automatically skipped on the next night", () => { const h = harness("a04-skip-dead"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day"); const guard = role(h, "GUARD"); voteAll(h, () => guard, "vote"); finishSpeechSession(h, "last"); expect(stateOf(h).runtime?.phase?.phaseType).toBe("NIGHT_WOLF"); expect(stateOf(h).runtime?.round).toBe(2); });

  it("A04-19 all candidates with no original sheriff voters closes the election without a badge", () => {
    const h = harness("a04-no-voter"); passNight(h); beginDay(h);
    const alive = stateOf(h).runtime?.players.filter((p) => p.lifeState === "ALIVE").map((p) => p.playerId) ?? [];
    sheriffSignup(h, new Set(alive));
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("SHERIFF_SPEECH");
    finishSpeechSession(h, "campaign-all");
    const ws = stateOf(h).runtime?.sheriff.withdrawalSession; if (ws === null || ws === undefined) throw new Error("withdraw");
    for (const actor of ws.candidatePlayersSnapshot) playerCommand(h, actor, { commandId: `all-stay-${actor}`, commandType: "CommitSheriffWithdrawal", payload: { withdraw: false }, windowToken: ws.sessionId });
    expect(stateOf(h).runtime?.sheriff.badgeStatus).toBe("NO_BADGE");
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_DISCUSSION");
  });

  it("A04-20 hunter exiled by the day vote receives a reaction window before last words", () => {
    const h = harness("a04-day-hunter"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day");
    const hunter = role(h, "HUNTER"); voteAll(h, () => hunter, "hunter-vote");
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_HUNTER_REACTION");
    const reaction = stateOf(h).runtime?.pendingReactions.find((entry) => entry.status === "OPEN"); if (reaction === undefined) throw new Error("reaction");
    playerCommand(h, hunter, { commandId: "hunter-pass", commandType: "CommitHunterReaction", payload: { action: "PASS", targetPlayerId: null }, windowToken: reaction.sessionId });
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("LAST_WORDS");
  });

  it("A04-21 sheriff killed on a later night handles the badge before day discussion", () => {
    const h = harness("a04-night-badge"); passNight(h); beginDay(h);
    const sheriff = rolePlayers(h, "VILLAGER")[0]; if (sheriff === undefined) throw new Error("sheriff");
    electSingleSheriffAndOpenDiscussion(h, sheriff); finishSpeechSession(h, "day-one"); voteAll(h, () => null, "abstain");
    expect(stateOf(h).runtime?.round).toBe(2);
    passNight(h, sheriff); beginDay(h);
    const phase = stateOf(h).runtime?.phase; expect(phase?.phaseType).toBe("SHERIFF_BADGE_ACTION");
    const target = stateOf(h).runtime?.players.find((p) => p.lifeState === "ALIVE" && p.playerId !== sheriff)?.playerId; if (phase === null || phase === undefined || target === undefined) throw new Error("badge target");
    playerCommand(h, sheriff, { commandId: "night-transfer", commandType: "CommitSheriffBadgeAction", payload: { action: "TRANSFER", targetPlayerId: target }, windowToken: phase.phaseId });
    expect(stateOf(h).runtime?.sheriff.holderPlayerId).toBe(target);
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_ORDER_SELECTION");
  });
  it("A04-22 sheriff PK may occur only once; a second tie closes with no badge", () => {
    const h = harness("a04-sheriff-second-tie"); passNight(h); beginDay(h);
    const [a, b] = rolePlayers(h, "VILLAGER"); if (a === undefined || b === undefined) throw new Error("candidates");
    sheriffSignup(h, new Set([a, b])); finishSpeechSession(h, "campaign");
    const ws = stateOf(h).runtime?.sheriff.withdrawalSession; if (ws === null || ws === undefined) throw new Error("withdraw");
    for (const actor of ws.candidatePlayersSnapshot) playerCommand(h, actor, { commandId: `second-tie-stay-${actor}`, commandType: "CommitSheriffWithdrawal", payload: { withdraw: false }, windowToken: ws.sessionId });
    let first = 0; voteAll(h, () => (first++ % 2 === 0 ? a : b), "sheriff-tie-one");
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("SHERIFF_PK_SPEECH");
    finishSpeechSession(h, "sheriff-pk");
    let second = 0; voteAll(h, () => (second++ % 2 === 0 ? a : b), "sheriff-tie-two");
    expect(stateOf(h).runtime?.sheriff.badgeStatus).toBe("NO_BADGE");
    expect(stateOf(h).runtime?.phase?.phaseType).toBe("DAY_DISCUSSION");
  });

  it("A04-23 replay rejects a forged day-vote weight snapshot", () => {
    const h = harness("a04-forged-weight"); passNight(h); beginDay(h); noSheriffToDiscussion(h); finishSpeechSession(h, "day");
    const forged = h.repository.loadEvents(h.gameId).map((event) => {
      if (event.eventType !== "VoteSessionOpened" || event.payload.session.kind !== "DAY") return event;
      const voter = event.payload.session.eligibleVotersSnapshot[0]; if (voter === undefined) throw new Error("voter");
      return { ...event, payload: { session: { ...event.payload.session, weightUnitsByVoter: { ...event.payload.session.weightUnitsByVoter, [voter]: 99 } } } };
    });
    expect(() => replay(forged)).toThrow();
  });

  it("A04-24 replay rejects a forged no-sheriff day speech order", () => {
    const h = harness("a04-forged-speech"); passNight(h); beginDay(h); noSheriffToDiscussion(h);
    const forged = h.repository.loadEvents(h.gameId).map((event) => {
      if (event.eventType !== "SpeechSessionOpened" || event.payload.session.kind !== "DAY_DISCUSSION") return event;
      return { ...event, payload: { session: { ...event.payload.session, speakerOrderSnapshot: [...event.payload.session.speakerOrderSnapshot].reverse() } } };
    });
    expect(() => replay(forged)).toThrow();
  });

});
