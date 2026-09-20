import { describe, expect, it } from "vitest";
import { PlayerViewSchema, type PlayerView, type PublicObservation } from "../../src/projection/schemas.js";
import { deriveNpcPersona } from "../../src/npc/cognition/persona.js";
import {
  initializeNpcCognitiveState,
  MAX_NPC_MEMORIES,
  NpcCognitionError,
  recordNpcDecision,
  recordStructuredClaim,
  synchronizeNpcCognitiveState,
  updateWorkingTheory,
} from "../../src/npc/cognition/state.js";
import { NpcCognitiveStateSchema } from "../../src/npc/cognition/schemas.js";
import { InMemoryNpcCognitiveStore } from "../../src/npc/persistence/memoryStore.js";
import { NpcCognitiveConcurrencyError } from "../../src/npc/persistence/contracts.js";
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
      gameId: "g-c01",
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

function withTimeline(view: PlayerView, timeline: PublicObservation[]): PlayerView {
  return PlayerViewSchema.parse({ ...view, public: { ...view.public, timeline } });
}

describe("C-01 NPC cognitive state", () => {
  it("C01-01 initializes only from an NPC PlayerView", () => {
    const state = initializeNpcCognitiveState(baseView());
    expect(state.npcPlayerId).toBe("p2");
    const human = baseView({ viewer: { playerId: "p1", seatNumber: 1, displayName: "P1", controllerType: "HUMAN", publicLifeState: "ALIVE" }, identity: { playerId: "p1", roleId: "VILLAGER", roleDisplayName: "平民", factionId: "GOOD", victoryBucket: "VILLAGER", initiallyKnownIdentities: [] } });
    expect(() => initializeNpcCognitiveState(human)).toThrowError(NpcCognitionError);
  });

  it("C01-02 derives a deterministic persona without RNG", () => {
    expect(deriveNpcPersona("g1", "p2")).toEqual(deriveNpcPersona("g1", "p2"));
  });

  it("C01-03 records self identity as exact fact and unknown players as beliefs", () => {
    const state = initializeNpcCognitiveState(baseView());
    expect(state.identityKnowledge.exactIdentities).toContainEqual({ playerId: "p2", roleId: "VILLAGER", factionId: "GOOD", source: "SELF" });
    expect(state.beliefs.find((entry) => entry.playerId === "p3")).toMatchObject({ knownFaction: null, knownRoleId: null, wolfLikelihoodBps: 5000 });
  });

  it("C01-04 stores wolf-team initial knowledge as facts but does not invent other roles", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "WEREWOLF", roleDisplayName: "普通狼人", factionId: "WOLF", victoryBucket: "WOLF", initiallyKnownIdentities: [{ playerId: "p4", roleId: "WOLF_BEAUTY", roleDisplayName: "狼美人", factionId: "WOLF" }] }, abilityState: { kind: "WOLF", currentNightBallotCommitted: false } });
    const state = initializeNpcCognitiveState(view);
    expect(state.identityKnowledge.exactIdentities).toContainEqual({ playerId: "p4", roleId: "WOLF_BEAUTY", factionId: "WOLF", source: "INITIAL_KNOWLEDGE" });
    expect(state.beliefs.find((entry) => entry.playerId === "p4")?.wolfLikelihoodBps).toBe(10000);
    expect(state.beliefs.find((entry) => entry.playerId === "p3")?.knownRoleId).toBeNull();
  });

  it("C01-05 persists only observations, never action windowToken capabilities", () => {
    const view = baseView({ availableActions: [{ commandType: "CommitBallot", windowToken: "SECRET-TOKEN", voteKind: "DAY", legalTargetPlayerIds: ["p3"], allowAbstain: true }], interactionStatus: "ACTION_REQUIRED" });
    const state = initializeNpcCognitiveState(view);
    expect(JSON.stringify(state)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(state)).not.toContain("windowToken");
  });

  it("C01-06 captures public observations once and advances the public cursor", () => {
    const state = initializeNpcCognitiveState(baseView());
    expect(state.cursor.publicOrdinal).toBe(3);
    expect(state.memory.filter((entry) => entry.visibility === "PUBLIC")).toHaveLength(3);
    const again = synchronizeNpcCognitiveState(state, baseView());
    expect(again.memory).toEqual(state.memory);
    expect(again.revision).toBe(state.revision);
  });

  it("C01-07 captures a new public observation on synchronization", () => {
    const initial = initializeNpcCognitiveState(baseView());
    const nextView = withTimeline(baseView(), [...baseView().public.timeline, { ordinal: 4, type: "SPEECH", speakerPlayerId: "p3", speechKind: "DAY_DISCUSSION", text: "我先聽後置位。", source: "NPC_TEXT" }]);
    const next = synchronizeNpcCognitiveState(initial, nextView);
    expect(next.cursor.publicOrdinal).toBe(4);
    expect(next.memory.some((entry) => entry.memoryId === "PUBLIC:4")).toBe(true);
    expect(next.revision).toBe(initial.revision + 1);
  });

  it("C01-08 a private seer result becomes exact faction knowledge, not exact role knowledge", () => {
    const view = baseView({ identity: { playerId: "p2", roleId: "SEER", roleDisplayName: "預言家", factionId: "GOOD", victoryBucket: "GOD", initiallyKnownIdentities: [] }, abilityState: { kind: "SEER", lastActionNight: 1 }, privateObservations: [{ ordinal: 1, type: "SEER_CHECK", nightNumber: 1, targetPlayerId: "p5", result: "WOLF" }] });
    const state = initializeNpcCognitiveState(view);
    const belief = state.beliefs.find((entry) => entry.playerId === "p5");
    expect(belief).toMatchObject({ knownFaction: "WOLF", knownRoleId: null, wolfLikelihoodBps: 10000 });
    expect(belief?.evidenceMemoryIds).toContain("PRIVATE:1");
  });

  it("C01-09 remembers private observations only for that PlayerView", () => {
    const view = baseView({ privateObservations: [{ ordinal: 1, type: "WITCH_KNIFE_INFO", nightNumber: 1, status: "TARGET", targetPlayerId: "p8" }] });
    const state = initializeNpcCognitiveState(view);
    expect(state.memory).toContainEqual(expect.objectContaining({ memoryId: "PRIVATE:1", visibility: "PRIVATE" }));
  });

  it("C01-10 does not infer a dead player's hidden role from public death", () => {
    const view = baseView({ public: { ...baseView().public, seats: seats.map((seat) => seat.playerId === "p5" ? { ...seat, lifeState: "DEAD" as const } : seat), timeline: [...baseView().public.timeline, { ordinal: 4, type: "DEATHS_REVEALED", playerIds: ["p5"] }] } });
    const state = initializeNpcCognitiveState(view);
    expect(state.publicSnapshot.seats.find((seat) => seat.playerId === "p5")?.lifeState).toBe("DEAD");
    expect(state.beliefs.find((entry) => entry.playerId === "p5")?.knownRoleId).toBeNull();
  });

  it("C01-11 rejects synchronization with another viewer or game", () => {
    const state = initializeNpcCognitiveState(baseView());
    const other = baseView({ viewer: { playerId: "p3", seatNumber: 3, displayName: "P3", controllerType: "NPC", publicLifeState: "ALIVE" }, identity: { playerId: "p3", roleId: "VILLAGER", roleDisplayName: "平民", factionId: "GOOD", victoryBucket: "VILLAGER", initiallyKnownIdentities: [] } });
    expect(() => synchronizeNpcCognitiveState(state, other)).toThrowError(NpcCognitionError);
  });

  it("C01-12 bounds episodic memory while retaining an advanced cursor", () => {
    const longTimeline: PublicObservation[] = Array.from({ length: 300 }, (_, index) => ({ ordinal: index + 1, type: "SPEECH", speakerPlayerId: `p${(index % 12) + 1}`, speechKind: "DAY_DISCUSSION", text: `speech-${index + 1}`, source: "NPC_TEXT" }));
    const state = initializeNpcCognitiveState(withTimeline(baseView(), longTimeline));
    expect(state.memory).toHaveLength(MAX_NPC_MEMORIES);
    expect(state.cursor.publicOrdinal).toBe(300);
    expect(state.memoryStats.observedPublic).toBe(300);
    expect(state.memoryStats.pruned).toBe(44);
  });

  it("C01-13 appends a structured claim idempotently", () => {
    const state = initializeNpcCognitiveState(baseView());
    const claim = { sourcePlayerId: "p3", sourcePublicOrdinal: 4, claimType: "ROLE_CLAIM" as const, roleId: "SEER", targetPlayerId: null, alignment: null, statement: "3號聲稱自己是預言家" };
    const once = recordStructuredClaim(state, "claim-1", claim);
    const twice = recordStructuredClaim(once, "claim-1", claim);
    expect(once.claimLedger).toHaveLength(1);
    expect(twice).toEqual(once);
  });

  it("C01-14 rejects a claim that references a non-seat player", () => {
    const state = initializeNpcCognitiveState(baseView());
    expect(() => recordStructuredClaim(state, "claim-x", { sourcePlayerId: "missing", sourcePublicOrdinal: null, claimType: "OTHER", roleId: null, targetPlayerId: null, alignment: null, statement: "bad" })).toThrowError(NpcCognitionError);
  });

  it("C01-15 updates working theory without turning it into factual identity knowledge", () => {
    const state = initializeNpcCognitiveState(baseView());
    const next = updateWorkingTheory(state, { opposedPlayerId: "p5", voteIntentPlayerId: "p5", notes: ["發言與票型待核對"] });
    expect(next.workingTheory.opposedPlayerId).toBe("p5");
    expect(next.beliefs.find((entry) => entry.playerId === "p5")?.knownFaction).toBeNull();
  });

  it("C01-16 records decisions idempotently and assigns monotonically increasing ordinals", () => {
    const state = initializeNpcCognitiveState(baseView());
    const one = recordNpcDecision(state, { decisionId: "d1", round: 1, stage: "DAY", decisionKind: "VOTE", actionCode: "VOTE", targetPlayerId: "p5", rationaleCodes: ["TOP_SUSPECT"], status: "PLANNED" });
    const duplicate = recordNpcDecision(one, { decisionId: "d1", round: 1, stage: "DAY", decisionKind: "VOTE", actionCode: "VOTE", targetPlayerId: "p5", rationaleCodes: ["TOP_SUSPECT"], status: "PLANNED" });
    const two = recordNpcDecision(duplicate, { decisionId: "d2", round: 1, stage: "DAY", decisionKind: "SPEECH", actionCode: "SPEAK", targetPlayerId: null, rationaleCodes: [], status: "COMMITTED" });
    expect(two.decisionHistory.map((entry) => entry.ordinal)).toEqual([1, 2]);
  });

  it("C01-17 reveals all exact identities only after PlayerView finalReveal exists", () => {
    const before = initializeNpcCognitiveState(baseView());
    expect(before.identityKnowledge.exactIdentities.some((entry) => entry.playerId === "p5")).toBe(false);
    const assignments = seats.map((seat, index) => ({ playerId: seat.playerId, roleId: index < 4 ? "WEREWOLF" : "VILLAGER", roleDisplayName: index < 4 ? "普通狼人" : "平民", factionId: index < 4 ? "WOLF" as const : "GOOD" as const, victoryBucket: index < 4 ? "WOLF" as const : "VILLAGER" as const }));
    const ended = baseView({ public: { ...baseView().public, status: "ENDED", stage: { kind: "ENDED", round: 3 }, outcome: { result: "GOOD" } }, interactionStatus: "GAME_OVER", finalReveal: { assignments, nightActions: [], seerChecks: [], deaths: [] } });
    const after = synchronizeNpcCognitiveState(before, ended);
    expect(after.identityKnowledge.exactIdentities).toHaveLength(12);
    expect(after.beliefs.find((entry) => entry.playerId === "p5")?.knownRoleId).toBe("VILLAGER");
  });

  it("C01-18 round-trips through the strict cognitive-state schema", () => {
    const state = initializeNpcCognitiveState(baseView());
    expect(NpcCognitiveStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("C01-19 memory store enforces optimistic revision on updates", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const state = initializeNpcCognitiveState(baseView());
    await store.save(state, null);
    const updated = updateWorkingTheory(state, { voteIntentPlayerId: "p5" });
    await store.save(updated, state.revision);
    await expect(store.save(updated, state.revision)).rejects.toThrowError(NpcCognitiveConcurrencyError);
  });

  it("C01-20 durable service initializes once and synchronizes only when PlayerView changes", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const service = new NpcCognitiveStateService(store);
    const first = await service.loadOrInitialize(baseView());
    const same = await service.loadOrInitialize(baseView());
    expect(same).toEqual(first);
    const changedView = withTimeline(baseView(), [...baseView().public.timeline, { ordinal: 4, type: "SPEECH", speakerPlayerId: "p3", speechKind: "DAY_DISCUSSION", text: "新的公開資訊", source: "NPC_TEXT" }]);
    const changed = await service.loadOrInitialize(changedView);
    expect(changed.revision).toBe(first.revision + 1);
  });

  it("C01-21 deleting a game removes its cognitive states from the memory store", async () => {
    const store = new InMemoryNpcCognitiveStore();
    const state = initializeNpcCognitiveState(baseView());
    await store.save(state, null);
    await store.deleteGame(state.gameId);
    expect(await store.load(state.gameId, state.npcPlayerId)).toBeNull();
  });

  it("C01-22 persona and cognitive state contain no wall-clock timestamps", () => {
    const state = initializeNpcCognitiveState(baseView());
    const json = JSON.stringify(state);
    expect(json).not.toContain("createdAt");
    expect(json).not.toContain("updatedAt");
    expect(json).not.toMatch(/20\d{2}-\d{2}-\d{2}T/);
  });
  it("C01-23 rejects a stale PlayerView that would move the observation cursor backward", () => {
    const advancedView = withTimeline(baseView(), [...baseView().public.timeline, { ordinal: 4, type: "SPEECH", speakerPlayerId: "p3", speechKind: "DAY_DISCUSSION", text: "new", source: "NPC_TEXT" }]);
    const state = initializeNpcCognitiveState(advancedView);
    expect(() => synchronizeNpcCognitiveState(state, baseView())).toThrowError(NpcCognitionError);
  });

  it("C01-24 rejects non-contiguous observation ordinals", () => {
    const broken = withTimeline(baseView(), [{ ordinal: 1, type: "GAME_STARTED", round: 1 }, { ordinal: 3, type: "NIGHT_STARTED", round: 1 }]);
    expect(() => initializeNpcCognitiveState(broken)).toThrowError(NpcCognitionError);
  });

});
