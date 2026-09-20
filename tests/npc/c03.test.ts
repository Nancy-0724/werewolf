import { describe, expect, it } from "vitest";
import { PlayerViewSchema, type PlayerActionPrompt, type PlayerView, type PublicObservation, type ViewerAbilityState } from "../../src/projection/schemas.js";
import { initializeNpcCognitiveState, recordStructuredClaim } from "../../src/npc/cognition/state.js";
import { NpcCognitiveStateSchema, type NpcCognitiveState } from "../../src/npc/cognition/schemas.js";
import { planNpcStrategy } from "../../src/npc/strategy/engine.js";
import { InMemoryNpcCognitiveStore } from "../../src/npc/persistence/memoryStore.js";
import { NpcCognitiveStateService } from "../../src/npc/persistence/service.js";

const seats = Array.from({ length: 12 }, (_, index) => ({
  playerId: `p${index + 1}`,
  seatNumber: index + 1,
  displayName: `P${index + 1}`,
  controllerType: "NPC" as const,
  lifeState: "ALIVE" as const,
  isSheriff: false,
}));

const roleMeta: Record<string, { displayName: string; factionId: "WOLF" | "GOOD"; victoryBucket: "WOLF" | "GOD" | "VILLAGER"; ability: ViewerAbilityState }> = {
  WEREWOLF: { displayName: "普通狼人", factionId: "WOLF", victoryBucket: "WOLF", ability: { kind: "WOLF", currentNightBallotCommitted: false } },
  WOLF_BEAUTY: { displayName: "狼美人", factionId: "WOLF", victoryBucket: "WOLF", ability: { kind: "BEAUTY", lastCharmNight: null, activeCharmTargetPlayerId: null } },
  SEER: { displayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", ability: { kind: "SEER", lastActionNight: null } },
  WITCH: { displayName: "女巫", factionId: "GOOD", victoryBucket: "GOD", ability: { kind: "WITCH", healRemaining: 1, poisonRemaining: 1 } },
  HUNTER: { displayName: "獵人", factionId: "GOOD", victoryBucket: "GOD", ability: { kind: "HUNTER", shotRemaining: 1, reactionStatus: "NOT_AVAILABLE" } },
  GUARD: { displayName: "守衛", factionId: "GOOD", victoryBucket: "GOD", ability: { kind: "GUARD", lastNightNumber: null, lastTargetPlayerId: null } },
  VILLAGER: { displayName: "平民", factionId: "GOOD", victoryBucket: "VILLAGER", ability: { kind: "NONE" } },
};

function baseView(roleId = "VILLAGER", actions: PlayerActionPrompt[] = [], overrides: Partial<PlayerView> = {}): PlayerView {
  const meta = roleMeta[roleId]!;
  const view: PlayerView = {
    contractVersion: "1.0.0",
    public: {
      contractVersion: "1.0.0",
      gameId: "g-c03",
      status: "IN_PROGRESS",
      stage: { kind: "DAY", round: 1 },
      ruleset: {
        rulesetId: "wolf-beauty-12.app",
        rulesetVersion: "1.0.0",
        roles: [
          { roleId: "WEREWOLF", displayName: "普通狼人", count: 3 },
          { roleId: "WOLF_BEAUTY", displayName: "狼美人", count: 1 },
          { roleId: "SEER", displayName: "預言家", count: 1 },
          { roleId: "WITCH", displayName: "女巫", count: 1 },
          { roleId: "HUNTER", displayName: "獵人", count: 1 },
          { roleId: "GUARD", displayName: "守衛", count: 1 },
          { roleId: "VILLAGER", displayName: "平民", count: 4 },
        ],
        sheriffEnabled: true,
      },
      seats,
      sheriff: { badgeStatus: "UNASSIGNED", holderPlayerId: null, electionAttempted: false, visibleCandidatePlayerIds: [] },
      currentTurn: { kind: "NONE" },
      timeline: [
        { ordinal: 1, type: "GAME_STARTED", round: 1 },
        { ordinal: 2, type: "NIGHT_STARTED", round: 1 },
        { ordinal: 3, type: "DAWN", round: 1, deadPlayerIds: [] },
      ],
      outcome: null,
    },
    viewer: { playerId: "p2", seatNumber: 2, displayName: "P2", controllerType: "NPC", publicLifeState: "ALIVE" },
    identity: { playerId: "p2", roleId, roleDisplayName: meta.displayName, factionId: meta.factionId, victoryBucket: meta.victoryBucket, initiallyKnownIdentities: [] },
    abilityState: meta.ability,
    privateObservations: [],
    availableActions: actions,
    interactionStatus: actions.length ? "ACTION_REQUIRED" : "WAITING",
    finalReveal: null,
    ...overrides,
  };
  return PlayerViewSchema.parse(view);
}

function wolfView(actions: PlayerActionPrompt[], roleId = "WEREWOLF"): PlayerView {
  const view = baseView(roleId, actions);
  return PlayerViewSchema.parse({
    ...view,
    identity: {
      ...view.identity!,
      initiallyKnownIdentities: [
        { playerId: "p3", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF" },
        { playerId: "p4", roleId: "WOLF_BEAUTY", roleDisplayName: "狼美人", factionId: "WOLF" },
      ],
    },
  });
}

function stateFor(view: PlayerView): NpcCognitiveState { return initializeNpcCognitiveState(view); }
function setBelief(state: NpcCognitiveState, playerId: string, patch: Partial<NpcCognitiveState["beliefs"][number]>): NpcCognitiveState {
  return NpcCognitiveStateSchema.parse({ ...state, beliefs: state.beliefs.map((belief) => belief.playerId === playerId ? { ...belief, ...patch } : belief) });
}
function setPersona(state: NpcCognitiveState, patch: Partial<NpcCognitiveState["persona"]>): NpcCognitiveState {
  return NpcCognitiveStateSchema.parse({ ...state, persona: { ...state.persona, ...patch } });
}
function choice(view: PlayerView, state = stateFor(view)) { return planNpcStrategy(view, state).decision?.choice ?? null; }

const prompt = {
  guard: (): PlayerActionPrompt => ({ commandType: "CommitGuardAction", windowToken: "SECRET", legalTargetPlayerIds: ["p2", "p3", "p5"], allowPass: true }),
  wolf: (): PlayerActionPrompt => ({ commandType: "CommitWolfBallot", windowToken: "SECRET", legalTargetPlayerIds: ["p2", "p3", "p5", "p6"], allowPass: true }),
  beauty: (): PlayerActionPrompt => ({ commandType: "CommitBeautyAction", windowToken: "SECRET", legalTargetPlayerIds: ["p3", "p5", "p6"], modes: ["CHARM", "KEEP"] }),
  seer: (): PlayerActionPrompt => ({ commandType: "CommitSeerAction", windowToken: "SECRET", legalTargetPlayerIds: ["p3", "p5", "p6"], allowPass: true }),
  hunter: (): PlayerActionPrompt => ({ commandType: "CommitHunterReaction", windowToken: "SECRET", legalTargetPlayerIds: ["p3", "p5", "p6"], allowPass: true }),
  speech: (): PlayerActionPrompt => ({ commandType: "CommitSpeech", windowToken: "SECRET", speechKind: "DAY_DISCUSSION", allowPass: true }),
  signup: (): PlayerActionPrompt => ({ commandType: "CommitSheriffSignup", windowToken: "SECRET", choices: ["JOIN", "PASS"] }),
  withdrawal: (): PlayerActionPrompt => ({ commandType: "CommitSheriffWithdrawal", windowToken: "SECRET", choices: ["STAY", "WITHDRAW"] }),
  dayBallot: (targets = ["p3", "p5", "p6"]): PlayerActionPrompt => ({ commandType: "CommitBallot", windowToken: "SECRET", voteKind: "DAY", legalTargetPlayerIds: targets, allowAbstain: true }),
  sheriffBallot: (targets = ["p3", "p5", "p6"]): PlayerActionPrompt => ({ commandType: "CommitBallot", windowToken: "SECRET", voteKind: "SHERIFF", legalTargetPlayerIds: targets, allowAbstain: true }),
  order: (): PlayerActionPrompt => ({ commandType: "ChooseDaySpeechOrder", windowToken: "SECRET", legalFirstSpeakerPlayerIds: ["p3", "p5", "p6"], directions: ["ASC", "DESC"] }),
  explode: (): PlayerActionPrompt => ({ commandType: "CommitSelfExplosion", windowToken: "SECRET" }),
  badge: (): PlayerActionPrompt => ({ commandType: "CommitSheriffBadgeAction", windowToken: "SECRET", transferTargetPlayerIds: ["p3", "p5", "p6"], allowDestroy: true }),
};

function witchPrompt(healTarget: string | null, poisonTargets = ["p3", "p5", "p6"]): PlayerActionPrompt {
  return { commandType: "CommitWitchAction", windowToken: "SECRET", knifeInfo: { status: healTarget ? "TARGET" : "NO_ATTACK", targetPlayerId: healTarget }, healRemaining: 1, poisonRemaining: 1, healTargetPlayerId: healTarget, poisonTargetPlayerIds: poisonTargets, allowPass: true };
}

function withPublicTimeline(view: PlayerView, observation: PublicObservation): PlayerView {
  return PlayerViewSchema.parse({ ...view, public: { ...view.public, timeline: [...view.public.timeline, observation] } });
}

describe("C-03 zero-cost role strategy engine", () => {
  it("C03-01 returns no strategy decision when the NPC has no legal action", () => {
    expect(planNpcStrategy(baseView(), stateFor(baseView())).decision).toBeNull();
  });

  it("C03-02 refuses a cognitive state belonging to another NPC", () => {
    const view = baseView("VILLAGER", [prompt.dayBallot()]);
    const state = NpcCognitiveStateSchema.parse({ ...stateFor(view), npcPlayerId: "p9" });
    expect(() => planNpcStrategy(view, state)).toThrow();
  });

  it("C03-03 guard avoids the previous target and protects a more trusted legal target", () => {
    const view = PlayerViewSchema.parse({ ...baseView("GUARD", [prompt.guard()]), abilityState: { kind: "GUARD", lastNightNumber: 1, lastTargetPlayerId: "p3" } });
    let state = stateFor(view);
    state = setBelief(state, "p5", { wolfLikelihoodBps: 1000, trustScore: 700 });
    const result = choice(view, state);
    expect(result).toEqual({ commandType: "CommitGuardAction", targetPlayerId: "p5" });
  });

  it("C03-04 wolf night ballot never targets a known packmate when a non-pack target exists", () => {
    const view = wolfView([prompt.wolf()]);
    expect((choice(view) as { targetPlayerId: string | null }).targetPlayerId).not.toBe("p3");
  });

  it("C03-05 wolf night ballot prioritizes a high-value claimed seer", () => {
    const view = wolfView([prompt.wolf()]);
    let state = recordStructuredClaim(stateFor(view), "seer-claim", { sourcePlayerId: "p5", sourcePublicOrdinal: null, claimType: "ROLE_CLAIM", roleId: "SEER", targetPlayerId: "p5", alignment: "GOOD", statement: "我是預言家" });
    state = setBelief(state, "p5", { wolfLikelihoodBps: 1200, trustScore: 600 });
    expect((choice(view, state) as { targetPlayerId: string | null }).targetPlayerId).toBe("p5");
  });

  it("C03-06 wolf ballot passes if every legal target is a known packmate/self", () => {
    const view = wolfView([{ commandType: "CommitWolfBallot", windowToken: "SECRET", legalTargetPlayerIds: ["p2", "p3", "p4"], allowPass: true }]);
    expect(choice(view)).toEqual({ commandType: "CommitWolfBallot", targetPlayerId: null });
  });

  it("C03-07 wolf beauty charms a high-value good instead of a known packmate", () => {
    const view = wolfView([prompt.beauty()], "WOLF_BEAUTY");
    let state = recordStructuredClaim(stateFor(view), "witch-claim", { sourcePlayerId: "p5", sourcePublicOrdinal: null, claimType: "ROLE_CLAIM", roleId: "WITCH", targetPlayerId: "p5", alignment: "GOOD", statement: "我是女巫" });
    state = setBelief(state, "p5", { wolfLikelihoodBps: 900, trustScore: 500 });
    expect(choice(view, state)).toEqual({ commandType: "CommitBeautyAction", mode: "CHARM", targetPlayerId: "p5" });
  });

  it("C03-08 wolf beauty keeps an existing valuable living charm instead of churning it", () => {
    const view = PlayerViewSchema.parse({ ...wolfView([prompt.beauty()], "WOLF_BEAUTY"), abilityState: { kind: "BEAUTY", lastCharmNight: 1, activeCharmTargetPlayerId: "p5" } });
    let state = stateFor(view);
    state = setBelief(state, "p5", { wolfLikelihoodBps: 500, trustScore: 800 });
    expect(choice(view, state)).toEqual({ commandType: "CommitBeautyAction", mode: "KEEP", targetPlayerId: null });
  });

  it("C03-09 witch uses the legal first-night self heal", () => {
    const view = baseView("WITCH", [witchPrompt("p2")], { public: { ...baseView().public, stage: { kind: "NIGHT", round: 1 } } });
    expect(choice(view)).toEqual({ commandType: "CommitWitchAction", action: "HEAL", targetPlayerId: "p2" });
  });

  it("C03-10 witch refuses to heal a player it knows is a wolf and poisons that known wolf", () => {
    const base = baseView("WITCH", [witchPrompt("p5", ["p5", "p6"])], { public: { ...baseView().public, stage: { kind: "NIGHT", round: 2 } } });
    let state = stateFor(base);
    state = setBelief(state, "p5", { knownFaction: "WOLF", wolfLikelihoodBps: 10_000, suspicionScore: 900 });
    expect(choice(base, state)).toEqual({ commandType: "CommitWitchAction", action: "POISON", targetPlayerId: "p5" });
  });

  it("C03-11 witch conserves poison when suspicion is weak", () => {
    const view = baseView("WITCH", [witchPrompt(null)], { public: { ...baseView().public, stage: { kind: "NIGHT", round: 2 } } });
    expect(choice(view)).toEqual({ commandType: "CommitWitchAction", action: "PASS", targetPlayerId: null });
  });

  it("C03-12 aggressive witch poisons a high-confidence suspect", () => {
    const view = baseView("WITCH", [witchPrompt(null)], { public: { ...baseView().public, stage: { kind: "NIGHT", round: 2 } } });
    let state = setPersona(stateFor(view), { aggression: 95 });
    state = setBelief(state, "p5", { wolfLikelihoodBps: 9000, suspicionScore: 800 });
    expect(choice(view, state)).toEqual({ commandType: "CommitWitchAction", action: "POISON", targetPlayerId: "p5" });
  });

  it("C03-13 seer avoids an already-known faction and checks a suspicious unknown", () => {
    const view = baseView("SEER", [prompt.seer()], { public: { ...baseView().public, stage: { kind: "NIGHT", round: 2 } } });
    let state = stateFor(view);
    state = setBelief(state, "p3", { knownFaction: "GOOD", wolfLikelihoodBps: 0 });
    state = setBelief(state, "p5", { wolfLikelihoodBps: 8500, suspicionScore: 700 });
    expect(choice(view, state)).toEqual({ commandType: "CommitSeerAction", targetPlayerId: "p5" });
  });

  it("C03-14 hunter shoots a known wolf", () => {
    const view = baseView("HUNTER", [prompt.hunter()]);
    const state = setBelief(stateFor(view), "p5", { knownFaction: "WOLF", wolfLikelihoodBps: 10_000 });
    expect(choice(view, state)).toEqual({ commandType: "CommitHunterReaction", action: "SHOOT", targetPlayerId: "p5" });
  });

  it("C03-15 hunter passes when every target is low confidence", () => {
    const view = baseView("HUNTER", [prompt.hunter()]);
    expect(choice(view)).toEqual({ commandType: "CommitHunterReaction", action: "PASS", targetPlayerId: null });
  });

  it("C03-16 seer always joins the sheriff election", () => {
    expect(choice(baseView("SEER", [prompt.signup()]))).toEqual({ commandType: "CommitSheriffSignup", choice: "JOIN" });
  });

  it("C03-17 cautious civilian passes sheriff signup", () => {
    const view = baseView("VILLAGER", [prompt.signup()]);
    const state = setPersona(stateFor(view), { leadership: 30, assertiveness: 30, riskTolerance: 20 });
    expect(choice(view, state)).toEqual({ commandType: "CommitSheriffSignup", choice: "PASS" });
  });

  it("C03-18 assertive civilian with leadership joins sheriff signup", () => {
    const view = baseView("VILLAGER", [prompt.signup()]);
    const state = setPersona(stateFor(view), { leadership: 90, assertiveness: 85, riskTolerance: 60 });
    expect(choice(view, state)).toEqual({ commandType: "CommitSheriffSignup", choice: "JOIN" });
  });

  it("C03-19 good day ballot selects the highest legal suspect", () => {
    const view = baseView("VILLAGER", [prompt.dayBallot()]);
    let state = stateFor(view);
    state = setBelief(state, "p5", { wolfLikelihoodBps: 9100, suspicionScore: 800, trustScore: -600 });
    expect(choice(view, state)).toEqual({ commandType: "CommitBallot", targetPlayerId: "p5" });
  });

  it("C03-20 wolf day ballot avoids its known packmate and blends on a non-pack suspect", () => {
    const view = wolfView([prompt.dayBallot(["p3", "p5", "p6"])]);
    let state = stateFor(view);
    state = setBelief(state, "p5", { wolfLikelihoodBps: 8000, suspicionScore: 700 });
    expect(choice(view, state)).toEqual({ commandType: "CommitBallot", targetPlayerId: "p5" });
  });

  it("C03-21 wolf sheriff voter supports a legal packmate candidate", () => {
    const view = wolfView([prompt.sheriffBallot(["p3", "p5"])]);
    expect(choice(view)).toEqual({ commandType: "CommitBallot", targetPlayerId: "p3" });
  });

  it("C03-22 wolf sheriff transfers the badge to a legal packmate", () => {
    const view = wolfView([prompt.badge()]);
    expect(choice(view)).toEqual({ commandType: "CommitSheriffBadgeAction", action: "TRANSFER", targetPlayerId: "p3" });
  });

  it("C03-23 seer strategic speech reveals its latest private check without exposing hidden system truth", () => {
    const view = baseView("SEER", [prompt.speech()], { privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "WOLF" }] });
    const result = choice(view) as { commandType: "CommitSpeech"; mode: "SPEAK"; text: string };
    expect(result.text).toContain("5號是查殺");
    expect(result.text).not.toContain("SYSTEM_TRUTH");
  });

  it("C03-24 high-deception wolf may fake a seer claim but never names a packmate as the fake check target", () => {
    const view = wolfView([prompt.speech()]);
    let state = setPersona(stateFor(view), { deceptionComfort: 95, assertiveness: 90 });
    state = setBelief(state, "p5", { wolfLikelihoodBps: 8000, suspicionScore: 600 });
    const result = choice(view, state) as { commandType: "CommitSpeech"; text: string };
    expect(result.text).toContain("我是預言家");
    expect(result.text).not.toContain("3號是查殺");
  });

  it("C03-25 aggressive wolf self-explodes under sufficient public pressure and explosion outranks speech", () => {
    const view = wolfView([prompt.speech(), prompt.explode()]);
    let state = setPersona(stateFor(view), { aggression: 95, riskTolerance: 90 });
    state = recordStructuredClaim(state, "pressure1", { sourcePlayerId: "p5", sourcePublicOrdinal: null, claimType: "CHECK_RESULT", roleId: "SEER", targetPlayerId: "p2", alignment: "WOLF", statement: "2號查殺" });
    state = recordStructuredClaim(state, "pressure2", { sourcePlayerId: "p6", sourcePublicOrdinal: null, claimType: "ALIGNMENT_READ", roleId: null, targetPlayerId: "p2", alignment: "WOLF", statement: "2號偏狼" });
    expect(choice(view, state)).toEqual({ commandType: "CommitSelfExplosion" });
  });

  it("C03-26 wolf does not self-explode with no pressure and instead takes its speech turn", () => {
    const view = wolfView([prompt.speech(), prompt.explode()]);
    const state = setPersona(stateFor(view), { aggression: 95, riskTolerance: 90 });
    expect((choice(view, state) as { commandType: string }).commandType).toBe("CommitSpeech");
  });

  it("C03-27 sheriff speech order starts near the top suspect", () => {
    const view = baseView("VILLAGER", [prompt.order()]);
    let state = stateFor(view);
    state = setBelief(state, "p6", { wolfLikelihoodBps: 9300, suspicionScore: 900 });
    const result = choice(view, state) as { commandType: "ChooseDaySpeechOrder"; firstSpeakerPlayerId: string };
    expect(result.firstSpeakerPlayerId).toBe("p6");
  });

  it("C03-28 strategy result never persists or returns the PlayerView windowToken", () => {
    const view = baseView("VILLAGER", [prompt.dayBallot()]);
    const result = planNpcStrategy(view, stateFor(view));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(JSON.stringify(result)).not.toContain("windowToken");
  });

  it("C03-29 durable service persists a planned role-strategy decision and can mark it committed", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const service = new NpcCognitiveStateService(store);
    const view = baseView("VILLAGER", [prompt.dayBallot()]);
    const planned = await service.loadSynchronizeReasonAndStrategize(view);
    expect(planned.strategy.decision).not.toBeNull();
    expect(planned.state.decisionHistory.at(-1)?.status).toBe("PLANNED");
    const decisionId = planned.strategy.decision!.decisionId;
    const committed = await service.markStrategyDecision(view.public.gameId, view.viewer.playerId, decisionId, "COMMITTED");
    expect(committed?.decisionHistory.find((entry) => entry.decisionId === decisionId)?.status).toBe("COMMITTED");
    expect(JSON.stringify(committed)).not.toContain("SECRET");
  });

  it("C03-30 repeated planning of the same action window does not duplicate decision history", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const service = new NpcCognitiveStateService(store);
    const view = baseView("VILLAGER", [prompt.dayBallot()]);
    const first = await service.loadSynchronizeReasonAndStrategize(view);
    const second = await service.loadSynchronizeReasonAndStrategize(view);
    expect(second.state.decisionHistory).toHaveLength(first.state.decisionHistory.length);
    expect(second.strategy.decision?.decisionId).toBe(first.strategy.decision?.decisionId);
    expect(second.state.revision).toBe(first.state.revision);
  });
});
