import { describe, expect, it } from "vitest";
import { PlayerViewSchema, type PlayerActionPrompt, type PlayerView, type PublicObservation, type ViewerAbilityState } from "../../src/projection/schemas.js";
import { initializeNpcCognitiveState } from "../../src/npc/cognition/state.js";
import { NpcCognitiveStateSchema, parseNpcCognitiveState, type NpcCognitiveState } from "../../src/npc/cognition/schemas.js";
import { runHeuristicReasoning } from "../../src/npc/reasoning/heuristics.js";
import { runAdvancedReasoning } from "../../src/npc/advanced/engine.js";
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

function baseView(roleId = "VILLAGER", actions: PlayerActionPrompt[] = [], timeline?: PublicObservation[]): PlayerView {
  const meta = roleMeta[roleId]!;
  return PlayerViewSchema.parse({
    contractVersion: "1.0.0",
    public: {
      contractVersion: "1.0.0",
      gameId: "g-c035",
      status: "IN_PROGRESS",
      stage: { kind: "DAY", round: 2 },
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
      timeline: timeline ?? [
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
    interactionStatus: actions.length > 0 ? "ACTION_REQUIRED" : "WAITING",
    finalReveal: null,
  });
}

function wolfView(timeline?: PublicObservation[]): PlayerView {
  const view = baseView("WEREWOLF", [], timeline);
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

function withPrivateCheck(view: PlayerView, targetPlayerId: string, result: "WOLF" | "GOOD"): PlayerView {
  return PlayerViewSchema.parse({ ...view, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId, result }] });
}

function analyzed(view: PlayerView): { state: NpcCognitiveState; report: ReturnType<typeof runAdvancedReasoning>["report"] } {
  const initialized = initializeNpcCognitiveState(view);
  const basic = runHeuristicReasoning(initialized).state;
  return runAdvancedReasoning(view, basic);
}

function speech(ordinal: number, speakerPlayerId: string, text: string): PublicObservation {
  return { ordinal, type: "SPEECH", speakerPlayerId, speechKind: "DAY_DISCUSSION", text, source: "NPC_TEXT" };
}

function baseTimeline(...extra: PublicObservation[]): PublicObservation[] {
  return [
    { ordinal: 1, type: "GAME_STARTED", round: 1 },
    { ordinal: 2, type: "NIGHT_STARTED", round: 1 },
    { ordinal: 3, type: "DAWN", round: 1, deadPlayerIds: [] },
    ...extra,
  ];
}

function countRoles(world: ReturnType<typeof analyzed>["state"]["advancedReasoning"]["topWorlds"][number]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const assignment of world.assignments) result[assignment.roleId] = (result[assignment.roleId] ?? 0) + 1;
  return result;
}

describe("C-03.5 advanced five-layer reasoning", () => {
  it("C035-01 legacy C-03 cognitive JSON without advancedReasoning upgrades with an empty default", () => {
    const state = initializeNpcCognitiveState(baseView());
    const { advancedReasoning: _removed, ...legacy } = state;
    const parsed = parseNpcCognitiveState(legacy);
    expect(parsed.advancedReasoning.topWorlds).toHaveLength(0);
  });

  it("C035-02 builds at most eight constrained worlds whose weights sum to 10000", () => {
    const result = analyzed(baseView());
    expect(result.report.snapshot.topWorlds.length).toBeLessThan(9);
    expect(result.report.snapshot.topWorlds.reduce((sum, world) => sum + world.relativeWeightBps, 0)).toBe(10_000);
  });

  it("C035-03 every world respects the WB12 role counts", () => {
    const result = analyzed(baseView());
    for (const world of result.report.snapshot.topWorlds) {
      expect(countRoles(world)).toEqual({ GUARD: 1, HUNTER: 1, SEER: 1, VILLAGER: 4, WEREWOLF: 3, WITCH: 1, WOLF_BEAUTY: 1 });
    }
  });

  it("C035-04 own exact role is fixed in every world", () => {
    const result = analyzed(baseView("VILLAGER"));
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p2")?.roleId === "VILLAGER")).toBe(true);
    expect(result.report.snapshot.marginals.find((entry) => entry.playerId === "p2")?.wolfLikelihoodBps).toBe(0);
  });

  it("C035-05 wolf initial pack knowledge is a hard role constraint", () => {
    const result = analyzed(wolfView());
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p3")?.roleId === "WEREWOLF")).toBe(true);
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p4")?.roleId === "WOLF_BEAUTY")).toBe(true);
  });

  it("C035-06 seer private check constrains faction but does not invent an exact wolf role", () => {
    const result = analyzed(withPrivateCheck(baseView("SEER"), "p5", "WOLF"));
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p5")?.factionId === "WOLF")).toBe(true);
    expect(result.report.snapshot.marginals.find((entry) => entry.playerId === "p5")?.wolfLikelihoodBps).toBe(10_000);
    expect(result.state.identityKnowledge.exactIdentities.some((entry) => entry.playerId === "p5")).toBe(false);
  });

  it("C035-07 public self explosion constrains wolf faction in every world", () => {
    const view = baseView("VILLAGER", [], baseTimeline({ ordinal: 4, type: "SELF_EXPLOSION", playerId: "p5" }));
    const result = analyzed(view);
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p5")?.factionId === "WOLF")).toBe(true);
  });

  it("C035-08 public hunter shot fixes hunter role in every world", () => {
    const view = baseView("VILLAGER", [], baseTimeline({ ordinal: 4, type: "HUNTER_SHOT", hunterPlayerId: "p5", targetPlayerId: "p6" }));
    const result = analyzed(view);
    expect(result.report.snapshot.topWorlds.every((world) => world.assignments.find((a) => a.playerId === "p5")?.roleId === "HUNTER")).toBe(true);
  });

  it("C035-09 ordinary death is not converted into an identity fact", () => {
    const view = baseView("VILLAGER", [], baseTimeline({ ordinal: 4, type: "DEATHS_REVEALED", playerIds: ["p5"] }));
    const result = analyzed(view);
    expect(result.state.beliefs.find((entry) => entry.playerId === "p5")?.knownFaction).toBeNull();
    expect(result.state.identityKnowledge.exactIdentities.some((entry) => entry.playerId === "p5")).toBe(false);
  });

  it("C035-10 unsupported high-certainty hidden-role read becomes soft information-overreach evidence", () => {
    const view = baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "我很確定，7號一定是女巫。")));
    const result = analyzed(view);
    const evidence = result.report.snapshot.evidence.find((entry) => entry.code === "HIDDEN_ROLE_OVERREACH");
    expect(evidence?.subjectPlayerId).toBe("p5");
    expect(evidence?.relatedPlayerIds).toContain("p7");
    expect(result.state.beliefs.find((entry) => entry.playerId === "p5")?.knownFaction).toBeNull();
  });

  it("C035-11 publicly proven hunter role does not trigger hidden-role overreach", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      { ordinal: 4, type: "HUNTER_SHOT", hunterPlayerId: "p7", targetPlayerId: "p8" },
      speech(5, "p5", "7號一定是獵人。"),
    ));
    const result = analyzed(view);
    expect(result.report.snapshot.evidence.some((entry) => entry.code === "HIDDEN_ROLE_OVERREACH" && entry.subjectPlayerId === "p5")).toBe(false);
  });

  it("C035-12 unsupported absolute alignment read becomes excess-certainty evidence, not a fact", () => {
    const view = baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "7號一定是狼，我百分百確定。")));
    const result = analyzed(view);
    expect(result.report.snapshot.evidence.some((entry) => entry.code === "EXCESS_CERTAINTY" && entry.subjectPlayerId === "p5")).toBe(true);
    expect(result.state.beliefs.find((entry) => entry.playerId === "p7")?.knownFaction).toBeNull();
  });

  it("C035-13 seer claim with a check result has stronger identity fit than a bare seer claim", () => {
    const supported = analyzed(baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "我是預言家，我查了7號是金水。"))));
    const bare = analyzed(baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "我是預言家。"))));
    expect(supported.report.snapshot.evidence.some((entry) => entry.code === "SEER_CLAIM_WITH_CHECK_SUPPORT" && entry.subjectPlayerId === "p5")).toBe(true);
    expect(bare.report.snapshot.evidence.some((entry) => entry.code === "SEER_CLAIM_WITHOUT_CHECK_SUPPORT" && entry.subjectPlayerId === "p5")).toBe(true);
  });

  it("C035-14 later counterclaim is timing evidence but never a hard wolf assignment", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我是預言家，我查了8號是金水。"),
      speech(5, "p6", "我才是預言家，我查了9號是金水。"),
    ));
    const result = analyzed(view);
    expect(result.report.snapshot.evidence.some((entry) => entry.code === "LATE_ROLE_COUNTERCLAIM" && entry.subjectPlayerId === "p6")).toBe(true);
    expect(result.state.beliefs.find((entry) => entry.playerId === "p6")?.knownFaction).toBeNull();
  });

  it("C035-15 unexplained stance reversal is detected when no new information appears", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我覺得7號偏好。"),
      speech(5, "p5", "現在我覺得7號是狼。"),
    ));
    const result = analyzed(view);
    expect(result.report.snapshot.temporalTransitions[0]?.assessment).toBe("UNEXPLAINED");
    expect(result.report.snapshot.evidence.some((entry) => entry.code === "UNEXPLAINED_STANCE_SHIFT")).toBe(true);
  });

  it("C035-16 stance reversal after a new check claim is treated as explained", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我覺得7號偏好。"),
      speech(5, "p6", "我是預言家，我查了7號是查殺。"),
      speech(6, "p5", "現在我覺得7號是狼。"),
    ));
    const result = analyzed(view);
    expect(result.report.snapshot.temporalTransitions[0]?.assessment).toBe("EXPLAINED");
    expect(result.report.snapshot.evidence.some((entry) => entry.code === "EXPLAINED_STANCE_SHIFT")).toBe(true);
  });

  it("C035-17 vote/death-scale new information only partially explains a stance reversal", () => {
    const vote: PublicObservation = { ordinal: 5, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p6", targetPlayerId: "p7" }], tallyUnitsByTarget: { p7: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p7", resolutionKind: "WINNER" };
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我覺得7號偏好。"), vote, speech(6, "p5", "現在我覺得7號是狼。"),
    ));
    expect(analyzed(view).report.snapshot.temporalTransitions[0]?.assessment).toBe("PARTIALLY_EXPLAINED");
  });

  it("C035-18 death of an accuser creates low-confidence utility evidence against the beneficiary only", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p7", "我覺得5號是狼。"),
      { ordinal: 5, type: "DEATHS_REVEALED", playerIds: ["p7"] },
    ));
    const evidence = analyzed(view).report.snapshot.evidence.find((entry) => entry.code === "DEATH_REMOVES_ACCUSER");
    expect(evidence?.subjectPlayerId).toBe("p5");
    expect(evidence?.confidenceBps).toBeLessThan(3_000);
  });

  it("C035-19 voting an already heavily pressured known wolf is marked as possible bussing", () => {
    const timeline = baseTimeline(
      speech(4, "p6", "我覺得5號是狼。"),
      speech(5, "p7", "我也覺得5號是狼。"),
      { ordinal: 6, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p8", targetPlayerId: "p5" }], tallyUnitsByTarget: { p5: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p5", resolutionKind: "WINNER" },
    );
    const view = withPrivateCheck(baseView("SEER", [], timeline), "p5", "WOLF");
    expect(analyzed(view).report.snapshot.evidence.some((entry) => entry.code === "BUSSING_PLAUSIBLE" && entry.subjectPlayerId === "p8")).toBe(true);
  });

  it("C035-20 a knife-target knowledge claim favors information-capable roles without proving one", () => {
    const view = baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "昨晚刀口是7號，我很確定。")));
    const result = analyzed(view);
    const evidence = result.report.snapshot.evidence.find((entry) => entry.code === "KNIFE_INFO_CLAIM");
    expect(evidence?.favoredRoleIds).toContain("WITCH");
    expect(evidence?.favoredRoleIds).toContain("WEREWOLF");
    expect(result.state.identityKnowledge.exactIdentities.some((entry) => entry.playerId === "p5")).toBe(false);
  });

  it("C035-21 a supported seer claim tends to appear as SEER in the top world", () => {
    const view = baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "我是預言家，我查了7號是金水。")));
    const top = analyzed(view).report.snapshot.topWorlds[0]!;
    expect(top.assignments.find((entry) => entry.playerId === "p5")?.roleId).toBe("SEER");
  });

  it("C035-22 competing seer worlds keep exactly one seer and compare alternative explanations", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我是預言家，我查了8號是金水。"),
      speech(5, "p6", "我才是預言家，我查了9號是金水。"),
    ));
    const worlds = analyzed(view).report.snapshot.topWorlds;
    expect(worlds.every((world) => world.assignments.filter((entry) => entry.roleId === "SEER").length === 1)).toBe(true);
    expect(worlds.some((world) => world.assignments.find((entry) => entry.playerId === "p5")?.roleId === "SEER")).toBe(true);
    expect(worlds.some((world) => world.assignments.find((entry) => entry.playerId === "p6")?.roleId === "SEER")).toBe(true);
  });

  it("C035-23 world hypotheses expose assumption cost instead of pretending the best world is certain", () => {
    const view = baseView("VILLAGER", [], baseTimeline(
      speech(4, "p5", "我是預言家，我查了8號是金水。"),
      speech(5, "p6", "我是預言家，我查了9號是金水。"),
    ));
    const worlds = analyzed(view).report.snapshot.topWorlds;
    expect(worlds.length).toBeGreaterThan(1);
    expect(worlds.every((world) => world.assumptionCost >= 0 && world.relativeWeightBps < 10_001)).toBe(true);
  });

  it("C035-24 rerunning the same evidence is deterministic and does not increment revision twice", () => {
    const view = baseView("VILLAGER", [], baseTimeline(speech(4, "p5", "我是預言家，我查了7號是金水。")));
    const basic = runHeuristicReasoning(initializeNpcCognitiveState(view)).state;
    const first = runAdvancedReasoning(view, basic);
    const second = runAdvancedReasoning(view, first.state);
    expect(second.report.stateChanged).toBe(false);
    expect(second.state.revision).toBe(first.state.revision);
    expect(second.state.advancedReasoning).toEqual(first.state.advancedReasoning);
  });

  it("C035-25 advanced reasoning never stores a PlayerView window token", () => {
    const action: PlayerActionPrompt = { commandType: "CommitBallot", windowToken: "TOP-SECRET-TOKEN", voteKind: "DAY", legalTargetPlayerIds: ["p5", "p6"], allowAbstain: true };
    const view = baseView("VILLAGER", [action]);
    expect(JSON.stringify(analyzed(view).state.advancedReasoning)).not.toContain("TOP-SECRET-TOKEN");
    expect(JSON.stringify(analyzed(view).state.advancedReasoning)).not.toContain("windowToken");
  });

  it("C035-26 durable service persists the advanced snapshot and repeated planning stays idempotent", async () => {
    const action: PlayerActionPrompt = { commandType: "CommitBallot", windowToken: "SECRET", voteKind: "DAY", legalTargetPlayerIds: ["p5", "p6"], allowAbstain: true };
    const view = baseView("VILLAGER", [action], baseTimeline(speech(4, "p5", "我覺得6號是狼。")));
    const store = new InMemoryNpcCognitiveStore();
    const service = new NpcCognitiveStateService(store);
    const first = await service.loadSynchronizeReasonAndStrategize(view);
    const second = await service.loadSynchronizeReasonAndStrategize(view);
    expect(first.state.advancedReasoning.topWorlds.length).toBeGreaterThan(0);
    expect(second.state.revision).toBe(first.state.revision);
    expect(second.advancedReport.stateChanged).toBe(false);
  });

  it("C035-27 strategy treats world marginals as soft refinement, not hard truth", () => {
    const action: PlayerActionPrompt = { commandType: "CommitBallot", windowToken: "SECRET", voteKind: "DAY", legalTargetPlayerIds: ["p5", "p6"], allowAbstain: true };
    const view = baseView("VILLAGER", [action]);
    const base = initializeNpcCognitiveState(view);
    const state = NpcCognitiveStateSchema.parse({
      ...base,
      beliefs: base.beliefs.map((belief) => belief.playerId === "p5" ? { ...belief, wolfLikelihoodBps: 6_200 } : belief.playerId === "p6" ? { ...belief, wolfLikelihoodBps: 5_900 } : belief),
      advancedReasoning: {
        ...base.advancedReasoning,
        marginals: [
          { playerId: "p5", wolfLikelihoodBps: 2_000, mostLikelyRoleId: "VILLAGER", roleConfidenceBps: 6_000 },
          { playerId: "p6", wolfLikelihoodBps: 9_500, mostLikelyRoleId: "WEREWOLF", roleConfidenceBps: 6_000 },
        ],
      },
    });
    expect(planNpcStrategy(view, state).decision?.choice).toEqual({ commandType: "CommitBallot", targetPlayerId: "p6" });
  });

  it("C035-28 exact known faction still overrides contradictory world marginal in strategy", () => {
    const action: PlayerActionPrompt = { commandType: "CommitBallot", windowToken: "SECRET", voteKind: "DAY", legalTargetPlayerIds: ["p5", "p6"], allowAbstain: true };
    const view = baseView("SEER", [action]);
    let state = initializeNpcCognitiveState(view);
    state = NpcCognitiveStateSchema.parse({
      ...state,
      beliefs: state.beliefs.map((belief) => belief.playerId === "p5" ? { ...belief, knownFaction: "WOLF", wolfLikelihoodBps: 10_000 } : belief),
      advancedReasoning: {
        ...state.advancedReasoning,
        marginals: [
          { playerId: "p5", wolfLikelihoodBps: 0, mostLikelyRoleId: "VILLAGER", roleConfidenceBps: 10_000 },
          { playerId: "p6", wolfLikelihoodBps: 9_900, mostLikelyRoleId: "WEREWOLF", roleConfidenceBps: 9_000 },
        ],
      },
    });
    expect(planNpcStrategy(view, state).decision?.choice).toEqual({ commandType: "CommitBallot", targetPlayerId: "p5" });
  });
});
