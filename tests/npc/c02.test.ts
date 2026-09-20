import { describe, expect, it } from "vitest";
import { PlayerViewSchema, type PlayerView, type PublicObservation } from "../../src/projection/schemas.js";
import { initializeNpcCognitiveState, recordStructuredClaim } from "../../src/npc/cognition/state.js";
import { NpcCognitiveStateSchema, type NpcCognitiveState } from "../../src/npc/cognition/schemas.js";
import { extractClaimsFromSpeechMemory } from "../../src/npc/reasoning/claims.js";
import { runHeuristicReasoning } from "../../src/npc/reasoning/heuristics.js";
import { InMemoryNpcCognitiveStore } from "../../src/npc/persistence/memoryStore.js";
import { NpcCognitiveStateService } from "../../src/npc/persistence/service.js";

const seats = Array.from({ length: 12 }, (_, index) => ({
  playerId: `p${index + 1}`,
  seatNumber: index + 1,
  displayName: `P${index + 1}`,
  controllerType: (index === 0 ? "HUMAN" : "NPC") as "HUMAN" | "NPC",
  lifeState: "ALIVE" as const,
  isSheriff: false,
}));

function baseView(overrides: Partial<PlayerView> = {}): PlayerView {
  const view = {
    contractVersion: "1.0.0" as const,
    public: {
      contractVersion: "1.0.0" as const,
      gameId: "g-c02",
      status: "IN_PROGRESS" as const,
      stage: { kind: "DAY" as const, round: 1 },
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
      sheriff: { badgeStatus: "UNASSIGNED" as const, holderPlayerId: null, electionAttempted: false, visibleCandidatePlayerIds: [] },
      currentTurn: { kind: "NONE" as const },
      timeline: [
        { ordinal: 1, type: "GAME_STARTED" as const, round: 1 as const },
        { ordinal: 2, type: "NIGHT_STARTED" as const, round: 1 },
        { ordinal: 3, type: "DAWN" as const, round: 1, deadPlayerIds: [] },
      ],
      outcome: null,
    },
    viewer: { playerId: "p2", seatNumber: 2, displayName: "P2", controllerType: "NPC" as const, publicLifeState: "ALIVE" as const },
    identity: { playerId: "p2", roleId: "VILLAGER", roleDisplayName: "平民", factionId: "GOOD" as const, victoryBucket: "VILLAGER" as const, initiallyKnownIdentities: [] },
    abilityState: { kind: "NONE" as const },
    privateObservations: [],
    availableActions: [],
    interactionStatus: "WAITING" as const,
    finalReveal: null,
    ...overrides,
  };
  return PlayerViewSchema.parse(view);
}

function withTimeline(view: PlayerView, extra: PublicObservation[]): PlayerView {
  return PlayerViewSchema.parse({ ...view, public: { ...view.public, timeline: [...view.public.timeline, ...extra] } });
}

function speech(ordinal: number, speakerPlayerId: string, text: string): PublicObservation {
  return { ordinal, type: "SPEECH", speakerPlayerId, speechKind: "DAY_DISCUSSION", text, source: "NPC_TEXT" };
}

function reason(view: PlayerView): ReturnType<typeof runHeuristicReasoning> {
  return runHeuristicReasoning(initializeNpcCognitiveState(view));
}

function belief(state: NpcCognitiveState, playerId: string) {
  return state.beliefs.find((entry) => entry.playerId === playerId)!;
}

describe("C-02 deterministic heuristic reasoning", () => {
  it("C02-01 is idempotent when no observation or claim changes", () => {
    const first = reason(baseView()).state;
    const second = runHeuristicReasoning(first).state;
    expect(second).toEqual(first);
  });

  it("C02-02 extracts a self role claim, seer result claim, and vote intent from structured speech", () => {
    const view = withTimeline(baseView(), [speech(4, "p3", "我是預言家，昨晚查5號查殺，今天我會投5號。")]);
    const state = initializeNpcCognitiveState(view);
    const claims = extractClaimsFromSpeechMemory(state);
    expect(claims.some((claim) => claim.claimType === "ROLE_CLAIM" && claim.roleId === "SEER")).toBe(true);
    expect(claims.some((claim) => claim.claimType === "CHECK_RESULT" && claim.targetPlayerId === "p5" && claim.alignment === "WOLF")).toBe(true);
    expect(claims.some((claim) => claim.claimType === "VOTE_INTENT" && claim.targetPlayerId === "p5")).toBe(true);
  });

  it("C02-03 does not convert an unsupported public role claim into exact role knowledge", () => {
    const result = reason(withTimeline(baseView(), [speech(4, "p3", "我是預言家。")]));
    expect(belief(result.state, "p3").knownRoleId).toBeNull();
  });

  it("C02-04 a private seer result remains locked as exact faction knowledge", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "WOLF" }] });
    const result = reason(view);
    expect(belief(result.state, "p5")).toMatchObject({ knownFaction: "WOLF", knownRoleId: null, wolfLikelihoodBps: 10000 });
  });

  it("C02-05 a public self-explosion becomes certain wolf-faction knowledge", () => {
    const result = reason(withTimeline(baseView(), [{ ordinal: 4, type: "SELF_EXPLOSION", playerId: "p5" }]));
    expect(belief(result.state, "p5")).toMatchObject({ knownFaction: "WOLF", wolfLikelihoodBps: 10000 });
    expect(result.report.evidence.some((entry) => entry.code === "PUBLIC_SELF_EXPLOSION")).toBe(true);
  });

  it("C02-06 a public hunter shot proves the hunter as GOOD/HUNTER", () => {
    const result = reason(withTimeline(baseView(), [{ ordinal: 4, type: "HUNTER_SHOT", hunterPlayerId: "p5", targetPlayerId: "p6" }]));
    expect(belief(result.state, "p5")).toMatchObject({ knownFaction: "GOOD", knownRoleId: "HUNTER", wolfLikelihoodBps: 0 });
  });

  it("C02-07 an ordinary public death does not infer hidden alignment or role", () => {
    const result = reason(withTimeline(baseView(), [{ ordinal: 4, type: "DEATHS_REVEALED", playerIds: ["p5"] }]));
    expect(belief(result.state, "p5")).toMatchObject({ knownFaction: null, knownRoleId: null, wolfLikelihoodBps: 5000 });
  });

  it("C02-08 switching between incompatible role claims raises suspicion", () => {
    const view = withTimeline(baseView(), [speech(4, "p3", "我是預言家。"), speech(5, "p3", "我是女巫。")]);
    const result = reason(view);
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeGreaterThan(5000);
    expect(result.report.evidence.some((entry) => entry.code === "ROLE_CLAIM_CONTRADICTION")).toBe(true);
  });

  it("C02-09 counterclaiming the NPC's own unique god role raises suspicion", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: null } });
    const result = reason(withTimeline(view, [speech(4, "p3", "我是預言家。")]));
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeGreaterThan(7000);
    expect(result.report.evidence.some((entry) => entry.code === "ROLE_COUNTERCLAIM")).toBe(true);
  });

  it("C02-10 a claimed check contradicting a known faction strongly raises source suspicion", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "GOOD" }] });
    const result = reason(withTimeline(view, [speech(4, "p3", "我是預言家，查5號查殺。")]));
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeGreaterThan(8000);
    expect(result.report.evidence.some((entry) => entry.code === "CHECK_CONTRADICTION")).toBe(true);
  });

  it("C02-11 a claimed check matching known faction modestly improves source trust", () => {
    const view = withTimeline(baseView(), [
      { ordinal: 4, type: "HUNTER_SHOT", hunterPlayerId: "p5", targetPlayerId: "p6" },
      speech(5, "p3", "我是預言家，查5號金水。"),
    ]);
    const result = reason(view);
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeLessThan(5000);
    expect(belief(result.state, "p3").trustScore).toBeGreaterThan(0);
  });

  it("C02-12 conflicting check results by the same speaker are flagged", () => {
    const view = withTimeline(baseView(), [speech(4, "p3", "我是預言家，查5號金水。"), speech(5, "p3", "昨晚查5號查殺。")]);
    const result = reason(view);
    expect(result.report.evidence.some((entry) => entry.code === "CHECK_INTERNAL_CONFLICT")).toBe(true);
    expect(belief(result.state, "p3").suspicionScore).toBeGreaterThan(400);
  });

  it("C02-13 voting against a known wolf makes an unknown voter less wolf-like", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "WOLF" }] });
    const vote: PublicObservation = { ordinal: 4, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p3", targetPlayerId: "p5" }], tallyUnitsByTarget: { p5: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p5", resolutionKind: "WINNER" };
    const result = reason(withTimeline(view, [vote]));
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeLessThan(5000);
  });

  it("C02-14 voting against a known good slightly raises voter suspicion", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "GOOD" }] });
    const vote: PublicObservation = { ordinal: 4, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p3", targetPlayerId: "p5" }], tallyUnitsByTarget: { p5: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p5", resolutionKind: "WINNER" };
    const result = reason(withTimeline(view, [vote]));
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeGreaterThan(5000);
  });

  it("C02-15 pressure from a known wolf modestly lowers the target's wolf likelihood", () => {
    const wolfView = baseView({ identity: { playerId: "p2", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF", victoryBucket: "WOLF", initiallyKnownIdentities: [{ playerId: "p3", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF" }] }, abilityState: { kind: "WOLF", currentNightBallotCommitted: false } });
    const vote: PublicObservation = { ordinal: 4, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p3", targetPlayerId: "p5" }], tallyUnitsByTarget: { p5: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p5", resolutionKind: "WINNER" };
    const result = reason(withTimeline(wolfView, [vote]));
    expect(belief(result.state, "p5").wolfLikelihoodBps).toBeLessThan(5000);
  });

  it("C02-16 keeping a declared vote intent improves consistency trust", () => {
    const vote: PublicObservation = { ordinal: 5, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p3", targetPlayerId: "p5" }], tallyUnitsByTarget: { p5: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p5", resolutionKind: "WINNER" };
    const result = reason(withTimeline(baseView(), [speech(4, "p3", "我今天會投5號。"), vote]));
    expect(result.report.evidence.some((entry) => entry.code === "VOTE_INTENT_KEPT")).toBe(true);
    expect(belief(result.state, "p3").trustScore).toBeGreaterThan(0);
  });

  it("C02-17 breaking a declared vote intent raises inconsistency suspicion", () => {
    const vote: PublicObservation = { ordinal: 5, type: "VOTE_RESULT", voteKind: "DAY", roundIndex: 1, ballots: [{ voterPlayerId: "p3", targetPlayerId: "p6" }], tallyUnitsByTarget: { p6: 2 }, abstainedPlayerIds: [], tiedPlayerIds: [], winningTargetId: "p6", resolutionKind: "WINNER" };
    const result = reason(withTimeline(baseView(), [speech(4, "p3", "我今天會投5號。"), vote]));
    expect(result.report.evidence.some((entry) => entry.code === "VOTE_INTENT_BROKEN")).toBe(true);
    expect(belief(result.state, "p3").suspicionScore).toBeGreaterThan(0);
  });

  it("C02-18 non-parseable conversational text does not invent structured claims", () => {
    const result = reason(withTimeline(baseView(), [speech(4, "p3", "我先聽大家發言，暫時沒有結論。") ]));
    expect(result.state.claimLedger).toHaveLength(0);
  });

  it("C02-19 auto-extracted claims do not duplicate across repeated reasoning", () => {
    const first = reason(withTimeline(baseView(), [speech(4, "p3", "我是預言家，查5號金水。")])).state;
    const second = runHeuristicReasoning(first).state;
    expect(second.claimLedger).toEqual(first.claimLedger);
  });

  it("C02-20 manual structured claims participate in reasoning without being discarded", () => {
    const base = initializeNpcCognitiveState(baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "GOOD" }] }));
    const withClaim = recordStructuredClaim(base, "manual-check", { sourcePlayerId: "p3", sourcePublicOrdinal: null, claimType: "CHECK_RESULT", roleId: "SEER", targetPlayerId: "p5", alignment: "WOLF", statement: "manual structured claim" });
    const result = runHeuristicReasoning(withClaim);
    expect(result.state.claimLedger.some((claim) => claim.claimId === "manual-check")).toBe(true);
    expect(belief(result.state, "p3").wolfLikelihoodBps).toBeGreaterThan(5000);
  });

  it("C02-21 working theory points at the highest-ranked living suspect and excludes self", () => {
    const result = reason(withTimeline(baseView(), [{ ordinal: 4, type: "SELF_EXPLOSION", playerId: "p5" }]));
    expect(result.state.workingTheory.opposedPlayerId).toBe("p5");
    expect(result.state.workingTheory.voteIntentPlayerId).toBe("p5");
    expect(result.state.workingTheory.voteIntentPlayerId).not.toBe("p2");
  });

  it("C02-22 a wolf NPC never recommends a known packmate as its generic working vote intent", () => {
    const wolfView = baseView({ identity: { playerId: "p2", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF", victoryBucket: "WOLF", initiallyKnownIdentities: [{ playerId: "p3", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF" }] }, abilityState: { kind: "WOLF", currentNightBallotCommitted: false } });
    const result = reason(wolfView);
    expect(result.state.workingTheory.voteIntentPlayerId).not.toBe("p3");
  });

  it("C02-23 persona skepticism scales contradiction evidence deterministically", () => {
    const view = withTimeline(baseView(), [speech(4, "p3", "我是預言家。"), speech(5, "p3", "我是女巫。")]);
    const base = initializeNpcCognitiveState(view);
    const low = NpcCognitiveStateSchema.parse({ ...base, persona: { ...base.persona, skepticism: 0 } });
    const high = NpcCognitiveStateSchema.parse({ ...base, persona: { ...base.persona, skepticism: 100 } });
    expect(belief(runHeuristicReasoning(high).state, "p3").wolfLikelihoodBps).toBeGreaterThan(belief(runHeuristicReasoning(low).state, "p3").wolfLikelihoodBps);
  });

  it("C02-24 durable cognition service persists the reasoned state while exposing no capability token", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const service = new NpcCognitiveStateService(store);
    const view = withTimeline(baseView({ availableActions: [{ commandType: "CommitBallot", windowToken: "DO-NOT-PERSIST", voteKind: "DAY", legalTargetPlayerIds: ["p5"], allowAbstain: true }], interactionStatus: "ACTION_REQUIRED" }), [speech(4, "p3", "我是預言家，查5號查殺。")]);
    const result = await service.loadSynchronizeAndReason(view);
    const persisted = await store.load(view.public.gameId, view.viewer.playerId);
    expect(persisted).toEqual(result.state);
    expect(JSON.stringify({ state: result.state, report: result.report })).not.toContain("DO-NOT-PERSIST");
    expect(JSON.stringify(result.state)).not.toContain("SYSTEM_TRUTH");
  });
});
