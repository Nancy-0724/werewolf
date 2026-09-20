import { CoreError } from "./errors.js";
import { cloneJson, stableStringify } from "./json.js";
import {
  GameStateSchema,
  type AbilityState,
  type ActionSession,
  type DomainEvent,
  type GameState,
  type PhaseType,
  type RuntimeState,
  parseEvent,
} from "./schemas.js";
import { assertSupportedRuleset, validateSeats } from "../rulesets/wb12.js";
import { assertRulesetRegistryCompatible } from "../rulesets/registry.js";

function assertNextSequence(state: GameState | null, event: DomainEvent): void {
  const expected = state === null ? 1 : state.lastSequence + 1;
  if (event.sequence !== expected) throw new CoreError("INVALID_EVENT_STREAM", `Expected sequence ${expected}, got ${event.sequence}`);
  if (state !== null && event.gameId !== state.gameId) throw new CoreError("INVALID_EVENT_STREAM", "Cross-game event in stream");
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function unique(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function seatOrdered(state: GameState, playerIds: readonly string[], direction: "ASC" | "DESC" = "ASC"): string[] {
  if (state.manifest === null) throw new CoreError("INVALID_EVENT_STREAM", "Missing manifest for seat order");
  const seats = new Map(state.manifest.seatsSnapshot.map((entry) => [entry.playerId, entry.seatNumber]));
  return [...playerIds].sort((a, b) => direction === "ASC"
    ? (seats.get(a) ?? 999) - (seats.get(b) ?? 999)
    : (seats.get(b) ?? -1) - (seats.get(a) ?? -1));
}

function isRotation(base: readonly string[], candidate: readonly string[]): boolean {
  if (base.length !== candidate.length) return false;
  if (base.length === 0) return true;
  for (let offset = 0; offset < base.length; offset += 1) {
    if (candidate.every((value, index) => value === base[(offset + index) % base.length])) return true;
  }
  return false;
}

function expectedLastWordSpeakers(state: GameState, runtime: RuntimeState): string[] {
  const group = runtime.resolutionGroup;
  if (group === null) return [];
  const disallowed = (causes: readonly string[]) => causes.includes("HUNTER_SHOT") || causes.includes("WOLF_BEAUTY_LINK") || causes.includes("SELF_EXPLOSION");
  if (group.kind === "NIGHT" && runtime.round === 1) {
    return seatOrdered(state, group.deathRecords.filter((record) => record.round === 1 && !disallowed(record.causes)).map((record) => record.playerId));
  }
  if (group.kind === "VOTE_EXECUTION") {
    return seatOrdered(state, group.deathRecords.filter((record) => record.causes.includes("VOTE_EXECUTION") && !disallowed(record.causes)).map((record) => record.playerId));
  }
  return [];
}

function speechSnapshotIsValid(state: GameState, runtime: RuntimeState, kind: "LAST_WORDS" | "SHERIFF_SPEECH" | "SHERIFF_PK_SPEECH" | "DAY_DISCUSSION" | "DAY_PK_SPEECH", speakers: readonly string[]): boolean {
  if (kind === "LAST_WORDS") return stableStringify(speakers) === stableStringify(expectedLastWordSpeakers(state, runtime));
  if (kind === "SHERIFF_SPEECH") return stableStringify(speakers) === stableStringify(seatOrdered(state, runtime.sheriff.candidatePlayerIds.filter((id) => playerById(runtime, id)?.lifeState === "ALIVE")));
  if (kind === "SHERIFF_PK_SPEECH" || kind === "DAY_PK_SPEECH") {
    const tied = runtime.voteSession?.result?.tiedPlayerIds ?? [];
    return tied.length >= 2 && stableStringify(speakers) === stableStringify(seatOrdered(state, tied.filter((id) => playerById(runtime, id)?.lifeState === "ALIVE")));
  }
  const alive = seatOrdered(state, runtime.players.filter((player) => player.lifeState === "ALIVE").map((player) => player.playerId));
  const holder = runtime.sheriff.badgeStatus === "ACTIVE" ? runtime.sheriff.holderPlayerId : null;
  if (holder === null || playerById(runtime, holder)?.lifeState !== "ALIVE") return stableStringify(speakers) === stableStringify(alive);
  if (speakers.length !== alive.length || speakers.at(-1) !== holder) return false;
  const nonSheriff = alive.filter((id) => id !== holder);
  const proposed = speakers.slice(0, -1);
  if (!sameStringSet(nonSheriff, proposed)) return false;
  return isRotation(seatOrdered(state, nonSheriff, "ASC"), proposed) || isRotation(seatOrdered(state, nonSheriff, "DESC"), proposed);
}

function expectedVoteSnapshot(state: GameState, runtime: RuntimeState, kind: "SHERIFF" | "SHERIFF_PK" | "DAY" | "DAY_PK") {
  if (state.manifest === null) throw new CoreError("INVALID_EVENT_STREAM", "Missing manifest for vote snapshot");
  const alive = seatOrdered(state, runtime.players.filter((player) => player.lifeState === "ALIVE").map((player) => player.playerId));
  const aliveSet = new Set(alive);
  const ordinary = state.manifest.rulesetSnapshot.options.ordinaryVoteUnits;
  const sheriffWeight = state.manifest.rulesetSnapshot.options.sheriffDayVoteUnits;
  let voters: string[];
  let targets: string[];
  let roundIndex: 1 | 2;
  if (kind === "SHERIFF") {
    voters = seatOrdered(state, runtime.sheriff.originalVoterPlayerIds.filter((id) => aliveSet.has(id)));
    targets = seatOrdered(state, runtime.sheriff.candidatePlayerIds.filter((id) => aliveSet.has(id)));
    roundIndex = 1;
  } else if (kind === "SHERIFF_PK") {
    const tied = runtime.voteSession?.result?.tiedPlayerIds ?? [];
    voters = seatOrdered(state, runtime.sheriff.originalVoterPlayerIds.filter((id) => aliveSet.has(id)));
    targets = seatOrdered(state, tied.filter((id) => aliveSet.has(id)));
    roundIndex = 2;
  } else if (kind === "DAY") {
    voters = [...alive]; targets = [...alive]; roundIndex = 1;
  } else {
    const tied = runtime.voteSession?.result?.tiedPlayerIds ?? [];
    targets = seatOrdered(state, tied.filter((id) => aliveSet.has(id)));
    voters = alive.filter((id) => !targets.includes(id));
    roundIndex = 2;
  }
  const weights: Record<string, number> = {};
  for (const voter of voters) {
    weights[voter] = kind === "SHERIFF" || kind === "SHERIFF_PK"
      ? ordinary
      : (runtime.sheriff.badgeStatus === "ACTIVE" && runtime.sheriff.holderPlayerId === voter ? sheriffWeight : ordinary);
  }
  return { voters, targets, roundIndex, weights };
}

function assertLockedPayload(state: GameState, event: Extract<DomainEvent, { eventType: "SetupLocked" }>): void {
  if (state.status !== "LOBBY" || state.lobby === null) throw new CoreError("INVALID_EVENT_STREAM", "SetupLocked requires LOBBY");
  const { manifest, lockedSetup } = event.payload;
  assertSupportedRuleset(manifest.rulesetSnapshot);
  assertRulesetRegistryCompatible(manifest.rulesetSnapshot);
  const seats = validateSeats(manifest.seatsSnapshot);
  if (manifest.gameId !== state.gameId || event.gameId !== state.gameId) throw new CoreError("INVALID_EVENT_STREAM", "Manifest gameId mismatch");
  if (manifest.createdAtIso !== state.createdAtIso) throw new CoreError("INVALID_EVENT_STREAM", "Manifest createdAt mismatch");
  if (stableStringify(seats) !== stableStringify(state.lobby.seats)) throw new CoreError("INVALID_EVENT_STREAM", "Locked seat snapshot differs from lobby");
  if (stableStringify(manifest.rulesetSnapshot) !== stableStringify(state.lobby.rulesetDraft)) throw new CoreError("INVALID_EVENT_STREAM", "Locked ruleset differs from lobby");

  const byRole = new Map(manifest.rulesetSnapshot.roleDefinitions.map((role) => [role.roleId, role]));
  const expectedCounts = new Map(manifest.rulesetSnapshot.roleCounts.map((entry) => [entry.roleId, entry.count]));
  const actualCounts = new Map<string, number>();
  const expectedPlayers = new Set(seats.map((seat) => seat.playerId));
  const actualPlayers = new Set<string>();
  for (const assignment of lockedSetup.assignments) {
    if (assignment.assignedAtSequence !== event.sequence) throw new CoreError("INVALID_EVENT_STREAM", "assignedAtSequence must equal SetupLocked sequence");
    if (!expectedPlayers.has(assignment.playerId) || actualPlayers.has(assignment.playerId)) throw new CoreError("INVALID_EVENT_STREAM", "Assignment players must exactly match seats");
    actualPlayers.add(assignment.playerId);
    const role = byRole.get(assignment.assignedRoleId);
    if (role === undefined || role.factionId !== assignment.assignedFactionId || role.victoryBucket !== assignment.victoryBucket) {
      throw new CoreError("INVALID_EVENT_STREAM", "Assignment role metadata mismatch");
    }
    actualCounts.set(role.roleId, (actualCounts.get(role.roleId) ?? 0) + 1);
  }
  if (actualPlayers.size !== 12) throw new CoreError("INVALID_EVENT_STREAM", "Assignments must cover all 12 players");
  for (const [roleId, count] of expectedCounts) if (actualCounts.get(roleId) !== count) throw new CoreError("INVALID_EVENT_STREAM", `Role count mismatch for ${roleId}`);
}

function onePlayerByRole(state: GameState, roleId: string): string {
  const assignments = state.lockedSetup?.assignments.filter((assignment) => assignment.assignedRoleId === roleId) ?? [];
  if (assignments.length !== 1 || assignments[0] === undefined) throw new CoreError("INVALID_EVENT_STREAM", `Expected exactly one ${roleId}`);
  return assignments[0].playerId;
}

function buildInitialRuntime(state: GameState, startedAtIso: string): RuntimeState {
  if (state.lockedSetup === null || state.manifest === null) throw new CoreError("INVALID_EVENT_STREAM", "GameStarted requires locked setup");
  const players = state.manifest.seatsSnapshot.map((seat) => {
    const assignment = state.lockedSetup?.assignments.find((entry) => entry.playerId === seat.playerId);
    if (assignment === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Missing role assignment for seat");
    return {
      playerId: seat.playerId,
      lifeState: "ALIVE" as const,
      deathRecordId: null,
      effectiveRoleId: assignment.assignedRoleId,
      effectiveFactionId: assignment.assignedFactionId,
    };
  });
  const aliveIds = players.map((player) => player.playerId);
  const abilityStates: AbilityState[] = [
    { kind: "WITCH", ownerPlayerId: onePlayerByRole(state, "WITCH"), healRemaining: 1, poisonRemaining: 1, lastActionNight: null },
    { kind: "GUARD", ownerPlayerId: onePlayerByRole(state, "GUARD"), lastNightNumber: null, lastTargetPlayerId: null },
    { kind: "BEAUTY", ownerPlayerId: onePlayerByRole(state, "WOLF_BEAUTY"), activeCharmStatusId: null, lastCharmNight: null },
    { kind: "HUNTER", ownerPlayerId: onePlayerByRole(state, "HUNTER"), shotRemaining: 1, reactionStatus: "NOT_AVAILABLE" },
    { kind: "SEER", ownerPlayerId: onePlayerByRole(state, "SEER"), lastActionNight: null },
    { kind: "WOLF_TEAM", ownerTeamId: "WOLF", nightNumber: 1, ballots: [], knifeTargetStatus: "UNRESOLVED", knifeTargetPlayerId: null },
  ];
  return {
    phase: null,
    round: 1,
    players,
    abilityStates,
    statusEffects: [],
    nightSession: {
      nightNumber: 1,
      nightStartAlivePlayerIds: aliveIds,
      currentActionSession: null,
      intents: [],
      status: "COLLECTING",
    },
    speechSession: null,
    voteSession: null,
    sheriff: {
      enabled: state.manifest.rulesetSnapshot.options.sheriffEnabled,
      holderPlayerId: null,
      badgeStatus: "UNASSIGNED",
      electionAttempted: false,
      electedAtSequence: null,
      candidatePlayerIds: [],
      withdrawnPlayerIds: [],
      originalVoterPlayerIds: [],
      signupSession: null,
      withdrawalSession: null,
    },
    resolutionGroup: null,
    pendingReactions: [],
    outcome: null,
    startedAtIso,
    endedAtIso: null,
  };
}

function requireRuntime(state: GameState): RuntimeState {
  if (state.status !== "IN_PROGRESS" || state.runtime === null) throw new CoreError("INVALID_EVENT_STREAM", "Runtime event requires IN_PROGRESS game");
  return cloneJson(state.runtime);
}

function playerById(runtime: RuntimeState, playerId: string) {
  return runtime.players.find((player) => player.playerId === playerId);
}

function expectedWindow(runtime: RuntimeState, phaseType: PhaseType): { actors: string[]; targets: string[] } {
  const alive = runtime.nightSession.nightStartAlivePlayerIds;
  const aliveSet = new Set(alive);
  const alivePlayers = runtime.players.filter((player) => aliveSet.has(player.playerId));
  const byRole = (roleId: string) => alivePlayers.filter((player) => player.effectiveRoleId === roleId).map((player) => player.playerId);
  switch (phaseType) {
    case "NIGHT_GUARD":
      return { actors: byRole("GUARD"), targets: [...alive] };
    case "NIGHT_WOLF":
      return { actors: alivePlayers.filter((player) => player.effectiveFactionId === "WOLF").map((player) => player.playerId), targets: [...alive] };
    case "NIGHT_BEAUTY": {
      const actors = byRole("WOLF_BEAUTY");
      const actor = actors[0];
      return { actors, targets: actor === undefined ? [] : alive.filter((playerId) => playerId !== actor) };
    }
    case "NIGHT_WITCH":
      return { actors: byRole("WITCH"), targets: [...alive] };
    case "NIGHT_SEER": {
      const actors = byRole("SEER");
      const actor = actors[0];
      return { actors, targets: actor === undefined ? [] : alive.filter((playerId) => playerId !== actor) };
    }
    case "NIGHT_READY_FOR_RESOLUTION":
    case "NIGHT_RESOLUTION":
    case "DAWN_HUNTER_REACTION":
    case "DAWN_READY_FOR_DAY":
    case "LAST_WORDS":
    case "SHERIFF_SIGNUP":
    case "SHERIFF_SPEECH":
    case "SHERIFF_WITHDRAWAL":
    case "SHERIFF_VOTE":
    case "SHERIFF_PK_SPEECH":
    case "SHERIFF_PK_VOTE":
    case "DAY_ORDER_SELECTION":
    case "DAY_DISCUSSION":
    case "DAY_VOTE":
    case "DAY_PK_SPEECH":
    case "DAY_PK_VOTE":
    case "DAY_RESOLUTION":
    case "DAY_HUNTER_REACTION":
    case "SHERIFF_BADGE_ACTION":
      return { actors: [], targets: [] };
  }
}

function assertActionSessionMatches(runtime: RuntimeState, session: ActionSession): void {
  if (runtime.phase === null || runtime.phase.status !== "OPEN") throw new CoreError("INVALID_EVENT_STREAM", "Action window requires open phase");
  if (!["NIGHT_GUARD", "NIGHT_WOLF", "NIGHT_BEAUTY", "NIGHT_WITCH", "NIGHT_SEER"].includes(runtime.phase.phaseType)) throw new CoreError("INVALID_EVENT_STREAM", "This phase has no night action window");
  if (session.phaseId !== runtime.phase.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "Session phaseId mismatch");
  if (session.status !== "OPEN" || session.committedActors.length !== 0) throw new CoreError("INVALID_EVENT_STREAM", "New action session must be open and uncommitted");
  if (!unique(session.eligibleActorsSnapshot) || !unique(session.legalTargetsSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Session snapshots must be unique");
  const expected = expectedWindow(runtime, runtime.phase.phaseType);
  if (!sameStringSet(session.eligibleActorsSnapshot, expected.actors) || !sameStringSet(session.legalTargetsSnapshot, expected.targets)) {
    throw new CoreError("INVALID_EVENT_STREAM", "Action session eligibility/targets mismatch phase snapshot");
  }
  if (session.eligibleActorsSnapshot.length === 0) throw new CoreError("INVALID_EVENT_STREAM", "A-02 action window requires at least one eligible actor");
}


function phaseTransitionAllowed(current: PhaseType | null, next: PhaseType): boolean {
  const allowed: Record<string, readonly PhaseType[]> = {
    ROOT: ["NIGHT_GUARD"],
    NIGHT_GUARD: ["NIGHT_WOLF"],
    NIGHT_WOLF: ["NIGHT_BEAUTY"],
    NIGHT_BEAUTY: ["NIGHT_WITCH"],
    NIGHT_WITCH: ["NIGHT_SEER"],
    NIGHT_SEER: ["NIGHT_READY_FOR_RESOLUTION"],
    NIGHT_READY_FOR_RESOLUTION: ["NIGHT_RESOLUTION"],
    NIGHT_RESOLUTION: ["DAWN_HUNTER_REACTION", "DAWN_READY_FOR_DAY"],
    DAWN_HUNTER_REACTION: ["DAWN_READY_FOR_DAY"],
    DAWN_READY_FOR_DAY: ["LAST_WORDS", "SHERIFF_BADGE_ACTION", "SHERIFF_SIGNUP", "DAY_ORDER_SELECTION", "DAY_DISCUSSION"],
    LAST_WORDS: ["SHERIFF_SIGNUP", "SHERIFF_BADGE_ACTION", "NIGHT_GUARD"],
    SHERIFF_SIGNUP: ["SHERIFF_SPEECH", "DAY_ORDER_SELECTION", "DAY_DISCUSSION"],
    SHERIFF_SPEECH: ["SHERIFF_WITHDRAWAL", "DAY_RESOLUTION"],
    SHERIFF_WITHDRAWAL: ["SHERIFF_VOTE", "DAY_ORDER_SELECTION", "DAY_DISCUSSION"],
    SHERIFF_VOTE: ["SHERIFF_PK_SPEECH", "DAY_ORDER_SELECTION", "DAY_DISCUSSION"],
    SHERIFF_PK_SPEECH: ["SHERIFF_PK_VOTE", "DAY_RESOLUTION"],
    SHERIFF_PK_VOTE: ["DAY_ORDER_SELECTION", "DAY_DISCUSSION"],
    DAY_ORDER_SELECTION: ["DAY_DISCUSSION"],
    DAY_DISCUSSION: ["DAY_VOTE", "DAY_RESOLUTION"],
    DAY_VOTE: ["DAY_PK_SPEECH", "DAY_RESOLUTION", "NIGHT_GUARD"],
    DAY_PK_SPEECH: ["DAY_PK_VOTE", "DAY_RESOLUTION"],
    DAY_PK_VOTE: ["DAY_RESOLUTION", "NIGHT_GUARD"],
    DAY_RESOLUTION: ["DAY_HUNTER_REACTION", "LAST_WORDS", "SHERIFF_BADGE_ACTION", "NIGHT_GUARD"],
    DAY_HUNTER_REACTION: ["LAST_WORDS", "SHERIFF_BADGE_ACTION", "NIGHT_GUARD"],
    SHERIFF_BADGE_ACTION: ["DAY_ORDER_SELECTION", "DAY_DISCUSSION", "NIGHT_GUARD"],
  };
  return (allowed[current ?? "ROOT"] ?? []).includes(next);
}

function currentOpenSession(runtime: RuntimeState): ActionSession {
  const session = runtime.nightSession.currentActionSession;
  if (session === null || session.status !== "OPEN") throw new CoreError("INVALID_EVENT_STREAM", "No open action session");
  return session;
}

function replaceAbilityState(runtime: RuntimeState, replacement: AbilityState): void {
  const index = runtime.abilityStates.findIndex((state) => state.kind === replacement.kind);
  if (index < 0) throw new CoreError("INVALID_EVENT_STREAM", `Missing ability state ${replacement.kind}`);
  runtime.abilityStates[index] = replacement;
}

function abilityState<K extends AbilityState["kind"]>(runtime: RuntimeState, kind: K): Extract<AbilityState, { kind: K }> {
  const found = runtime.abilityStates.find((state): state is Extract<AbilityState, { kind: K }> => state.kind === kind);
  if (found === undefined) throw new CoreError("INVALID_EVENT_STREAM", `Missing ability state ${kind}`);
  return cloneJson(found);
}

function assertActorCanCommit(runtime: RuntimeState, actorPlayerId: string): ActionSession {
  const session = currentOpenSession(runtime);
  if (!session.eligibleActorsSnapshot.includes(actorPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Actor is not eligible for this action window");
  if (session.committedActors.includes(actorPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Actor already committed in this action window");
  return session;
}

function markCommitted(runtime: RuntimeState, actorPlayerId: string): void {
  const session = currentOpenSession(runtime);
  runtime.nightSession.currentActionSession = {
    ...session,
    committedActors: [...session.committedActors, actorPlayerId],
  };
}

function computeWolfTarget(ballots: readonly { targetPlayerId: string | null }[]): string | null {
  const counts = new Map<string, number>();
  for (const ballot of ballots) {
    const key = ballot.targetPlayerId ?? "__PASS__";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let max = -1;
  let winners: string[] = [];
  for (const [key, count] of counts) {
    if (count > max) {
      max = count;
      winners = [key];
    } else if (count === max) {
      winners.push(key);
    }
  }
  if (winners.length !== 1 || winners[0] === "__PASS__") return null;
  return winners[0] ?? null;
}

export function computeVoteResult(
  eligibleTargets: readonly string[],
  weights: Readonly<Record<string, number>>,
  ballots: readonly { voterPlayerId: string; targetPlayerId: string | null }[],
): { tallyUnitsByTarget: Record<string, number>; abstainedPlayerIds: string[]; tiedPlayerIds: string[]; winningTargetId: string | null; resolutionKind: "WINNER" | "TIE" | "NO_RESULT" } {
  const tallyUnitsByTarget: Record<string, number> = {};
  for (const target of eligibleTargets) tallyUnitsByTarget[target] = 0;
  const abstainedPlayerIds: string[] = [];
  for (const ballot of ballots) {
    if (ballot.targetPlayerId === null) { abstainedPlayerIds.push(ballot.voterPlayerId); continue; }
    tallyUnitsByTarget[ballot.targetPlayerId] = (tallyUnitsByTarget[ballot.targetPlayerId] ?? 0) + (weights[ballot.voterPlayerId] ?? 0);
  }
  let max = 0;
  for (const value of Object.values(tallyUnitsByTarget)) if (value > max) max = value;
  if (max === 0) return { tallyUnitsByTarget, abstainedPlayerIds, tiedPlayerIds: [], winningTargetId: null, resolutionKind: "NO_RESULT" };
  const tiedPlayerIds = eligibleTargets.filter((target) => tallyUnitsByTarget[target] === max);
  if (tiedPlayerIds.length === 1) return { tallyUnitsByTarget, abstainedPlayerIds, tiedPlayerIds: [], winningTargetId: tiedPlayerIds[0] ?? null, resolutionKind: "WINNER" };
  return { tallyUnitsByTarget, abstainedPlayerIds, tiedPlayerIds, winningTargetId: null, resolutionKind: "TIE" };
}

export function reduceEvent(inputState: GameState | null, inputEvent: unknown): GameState {
  const state = inputState === null ? null : GameStateSchema.parse(cloneJson(inputState));
  const event = parseEvent(inputEvent);
  assertNextSequence(state, event);

  switch (event.eventType) {
    case "GameCreated": {
      if (state !== null) throw new CoreError("INVALID_EVENT_STREAM", "GameCreated must be first and unique");
      const ruleset = assertSupportedRuleset(event.payload.rulesetDraft);
      assertRulesetRegistryCompatible(ruleset);
      return GameStateSchema.parse({
        gameId: event.gameId,
        status: "LOBBY",
        createdAtIso: event.payload.createdAtIso,
        lastSequence: event.sequence,
        lobby: { seats: [], rulesetDraft: ruleset },
        manifest: null,
        lockedSetup: null,
        runtime: null,
        abortReason: null,
      });
    }
    case "SeatsConfigured": {
      if (state === null || state.status !== "LOBBY" || state.lobby === null) throw new CoreError("INVALID_EVENT_STREAM", "SeatsConfigured requires LOBBY");
      const seats = validateSeats(event.payload.seats);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, lobby: { ...cloneJson(state.lobby), seats } });
    }
    case "SetupLocked": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SetupLocked requires existing game");
      assertLockedPayload(state, event);
      return GameStateSchema.parse({
        gameId: state.gameId,
        status: "LOCKED",
        createdAtIso: state.createdAtIso,
        lastSequence: event.sequence,
        lobby: null,
        manifest: cloneJson(event.payload.manifest),
        lockedSetup: cloneJson(event.payload.lockedSetup),
        runtime: null,
        abortReason: null,
      });
    }
    case "GameStarted": {
      if (state === null || state.status !== "LOCKED") throw new CoreError("INVALID_EVENT_STREAM", "GameStarted requires LOCKED game");
      if (event.phaseId !== null) throw new CoreError("INVALID_EVENT_STREAM", "GameStarted phaseId must be null");
      return GameStateSchema.parse({
        ...cloneJson(state),
        status: "IN_PROGRESS",
        lastSequence: event.sequence,
        runtime: buildInitialRuntime(state, event.payload.startedAtIso),
      });
    }
    case "PhaseOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "PhaseOpened requires existing game");
      const runtime = requireRuntime(state);
      if (event.phaseId !== event.payload.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "PhaseOpened envelope phaseId mismatch");
      if (runtime.phase !== null && runtime.phase.status !== "CLOSED") throw new CoreError("INVALID_EVENT_STREAM", "Cannot open a phase while prior phase is open");
      const priorPhase = runtime.phase?.phaseType ?? null;
      if (!phaseTransitionAllowed(priorPhase, event.payload.phaseType)) {
        throw new CoreError("INVALID_EVENT_STREAM", `Illegal phase transition ${String(priorPhase)} -> ${event.payload.phaseType}`);
      }
      if (priorPhase === "NIGHT_RESOLUTION") {
        const expected = runtime.pendingReactions.some((reaction) => reaction.status === "OPEN") ? "DAWN_HUNTER_REACTION" : "DAWN_READY_FOR_DAY";
        if (event.payload.phaseType !== expected) throw new CoreError("INVALID_EVENT_STREAM", `Expected next phase ${expected}`);
      }
      if (event.payload.roundNumber !== runtime.round || event.payload.roundNumber !== runtime.nightSession.nightNumber) throw new CoreError("INVALID_EVENT_STREAM", "Phase round mismatch");
      runtime.phase = {
        phaseId: event.payload.phaseId,
        phaseType: event.payload.phaseType,
        roundNumber: event.payload.roundNumber,
        openedAtSequence: event.sequence,
        status: "OPEN",
        continuation: event.payload.continuation,
      };
      if (event.payload.phaseType === "NIGHT_READY_FOR_RESOLUTION") {
        runtime.nightSession.currentActionSession = null;
        runtime.nightSession.status = "READY_FOR_RESOLUTION";
      }
      if (event.payload.phaseType === "NIGHT_RESOLUTION") {
        if (runtime.nightSession.status !== "READY_FOR_RESOLUTION") throw new CoreError("INVALID_EVENT_STREAM", "Night is not ready for resolution");
        runtime.resolutionGroup = { resolutionGroupId: event.payload.phaseId, kind: "NIGHT", round: runtime.round, status: "RESOLVING", deathRecords: [] };
      }
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "PhaseClosed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "PhaseClosed requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase === null || runtime.phase.status !== "OPEN" || runtime.phase.phaseId !== event.payload.phaseId || event.phaseId !== runtime.phase.phaseId) {
        throw new CoreError("INVALID_EVENT_STREAM", "PhaseClosed does not match current open phase");
      }
      const session = runtime.nightSession.currentActionSession;
      if (["NIGHT_GUARD", "NIGHT_WOLF", "NIGHT_BEAUTY", "NIGHT_WITCH", "NIGHT_SEER"].includes(runtime.phase.phaseType)) {
        const expected = expectedWindow(runtime, runtime.phase.phaseType);
        if (expected.actors.length > 0 && (session === null || session.status !== "CLOSED")) throw new CoreError("INVALID_EVENT_STREAM", "Action window must close before phase");
      }
      if (["LAST_WORDS", "SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"].includes(runtime.phase.phaseType) && runtime.speechSession?.status !== "CLOSED") {
        throw new CoreError("INVALID_EVENT_STREAM", "Speech session must close before phase");
      }
      if (runtime.phase.phaseType === "SHERIFF_SIGNUP" && runtime.sheriff.signupSession?.status !== "CLOSED") throw new CoreError("INVALID_EVENT_STREAM", "Sheriff signup must close before phase");
      if (runtime.phase.phaseType === "SHERIFF_WITHDRAWAL" && runtime.sheriff.withdrawalSession?.status !== "CLOSED") throw new CoreError("INVALID_EVENT_STREAM", "Sheriff withdrawal must close before phase");
      if (["SHERIFF_VOTE", "SHERIFF_PK_VOTE", "DAY_VOTE", "DAY_PK_VOTE"].includes(runtime.phase.phaseType) && runtime.voteSession?.status !== "CLOSED") throw new CoreError("INVALID_EVENT_STREAM", "Vote session must close before phase");
      runtime.phase = { ...runtime.phase, status: "CLOSED" };
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ActionWindowOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ActionWindowOpened requires existing game");
      const runtime = requireRuntime(state);
      if (event.phaseId !== event.payload.session.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "ActionWindowOpened envelope phaseId mismatch");
      if (runtime.nightSession.currentActionSession?.status === "OPEN") throw new CoreError("INVALID_EVENT_STREAM", "Another action session is already open");
      assertActionSessionMatches(runtime, event.payload.session);
      runtime.nightSession.currentActionSession = cloneJson(event.payload.session);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ActionWindowClosed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ActionWindowClosed requires existing game");
      const runtime = requireRuntime(state);
      const session = currentOpenSession(runtime);
      if (event.phaseId !== session.phaseId || session.sessionId !== event.payload.sessionId) throw new CoreError("INVALID_EVENT_STREAM", "ActionWindowClosed session mismatch");
      if (!sameStringSet(session.committedActors, session.eligibleActorsSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Cannot close action window before all eligible actors commit");
      if (runtime.phase?.phaseType === "NIGHT_WOLF") {
        const team = abilityState(runtime, "WOLF_TEAM");
        if (team.knifeTargetStatus !== "LOCKED") throw new CoreError("INVALID_EVENT_STREAM", "Wolf target must be locked before closing wolf window");
      }
      if (runtime.phase?.phaseType === "NIGHT_WITCH") {
        const witchIntent = [...runtime.nightSession.intents].reverse().find((intent) => intent.intentType === "WITCH" && intent.nightNumber === runtime.nightSession.nightNumber);
        const witch = abilityState(runtime, "WITCH");
        if (witchIntent?.intentType !== "WITCH") throw new CoreError("INVALID_EVENT_STREAM", "Witch window requires committed witch intent");
        if (witchIntent.action === "HEAL" && witch.healRemaining !== 0) throw new CoreError("INVALID_EVENT_STREAM", "Heal resource must be spent before closing witch window");
        if (witchIntent.action === "POISON" && witch.poisonRemaining !== 0) throw new CoreError("INVALID_EVENT_STREAM", "Poison resource must be spent before closing witch window");
      }
      runtime.nightSession.currentActionSession = { ...session, status: "CLOSED" };
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "NightActionCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "NightActionCommitted requires existing game");
      const runtime = requireRuntime(state);
      const phase = runtime.phase;
      if (phase === null || phase.status !== "OPEN" || event.phaseId !== phase.phaseId || event.payload.nightNumber !== runtime.nightSession.nightNumber) {
        throw new CoreError("INVALID_EVENT_STREAM", "Night action phase/night mismatch");
      }
      const session = assertActorCanCommit(runtime, event.payload.actorPlayerId);
      const target = event.payload.targetPlayerId;
      const expectedPhaseByIntent = {
        GUARD: "NIGHT_GUARD",
        BEAUTY: "NIGHT_BEAUTY",
        WITCH: "NIGHT_WITCH",
        SEER: "NIGHT_SEER",
      } as const;
      if (phase.phaseType !== expectedPhaseByIntent[event.payload.intentType]) throw new CoreError("INVALID_EVENT_STREAM", "Intent type does not match phase");

      if (event.payload.intentType === "GUARD") {
        if (target !== null && !session.legalTargetsSnapshot.includes(target)) throw new CoreError("INVALID_EVENT_STREAM", "Illegal guard target");
        const guard = abilityState(runtime, "GUARD");
        if (guard.ownerPlayerId !== event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Guard owner mismatch");
        if (target !== null && guard.lastNightNumber === event.payload.nightNumber - 1 && guard.lastTargetPlayerId === target) throw new CoreError("INVALID_EVENT_STREAM", "Guard repeated consecutive target");
        replaceAbilityState(runtime, { ...guard, lastNightNumber: event.payload.nightNumber, lastTargetPlayerId: target });
      }

      if (event.payload.intentType === "BEAUTY") {
        const beauty = abilityState(runtime, "BEAUTY");
        if (beauty.ownerPlayerId !== event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Beauty owner mismatch");
        if (event.payload.mode === "KEEP") {
          if (target !== null) throw new CoreError("INVALID_EVENT_STREAM", "KEEP must not have target");
        } else {
          if (target === null || !session.legalTargetsSnapshot.includes(target) || target === event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Illegal charm target");
          replaceAbilityState(runtime, { ...beauty, lastCharmNight: event.payload.nightNumber });
        }
      }

      if (event.payload.intentType === "WITCH") {
        const witch = abilityState(runtime, "WITCH");
        if (witch.ownerPlayerId !== event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Witch owner mismatch");
        const wolfTeam = abilityState(runtime, "WOLF_TEAM");
        if (wolfTeam.knifeTargetStatus !== "LOCKED") throw new CoreError("INVALID_EVENT_STREAM", "Witch action requires locked wolf target");
        if (event.payload.action === "PASS") {
          if (target !== null) throw new CoreError("INVALID_EVENT_STREAM", "PASS must not have target");
        } else if (event.payload.action === "HEAL") {
          if (witch.healRemaining !== 1 || target === null || wolfTeam.knifeTargetPlayerId === null || target !== wolfTeam.knifeTargetPlayerId) {
            throw new CoreError("INVALID_EVENT_STREAM", "Illegal witch heal intent");
          }
          if (event.payload.nightNumber > 1 && target === event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Witch cannot self-heal after first night");
        } else {
          if (witch.poisonRemaining !== 1 || target === null || target === event.payload.actorPlayerId || !runtime.nightSession.nightStartAlivePlayerIds.includes(target)) {
            throw new CoreError("INVALID_EVENT_STREAM", "Illegal witch poison intent");
          }
        }
        replaceAbilityState(runtime, { ...witch, lastActionNight: event.payload.nightNumber });
      }

      if (event.payload.intentType === "SEER") {
        const seer = abilityState(runtime, "SEER");
        if (seer.ownerPlayerId !== event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Seer owner mismatch");
        if (target !== null && (!session.legalTargetsSnapshot.includes(target) || target === event.payload.actorPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Illegal seer target");
        replaceAbilityState(runtime, { ...seer, lastActionNight: event.payload.nightNumber });
      }

      runtime.nightSession.intents.push({ ...cloneJson(event.payload), committedAtSequence: event.sequence });
      markCommitted(runtime, event.payload.actorPlayerId);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "AbilityResourceSpent": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "AbilityResourceSpent requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "NIGHT_WITCH" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "Witch resource spend outside witch phase");
      const witch = abilityState(runtime, "WITCH");
      if (witch.ownerPlayerId !== event.payload.actorPlayerId || event.payload.nightNumber !== runtime.nightSession.nightNumber) throw new CoreError("INVALID_EVENT_STREAM", "Witch resource owner/night mismatch");
      const matchingIntent = [...runtime.nightSession.intents].reverse().find((intent) => intent.intentType === "WITCH" && intent.actorPlayerId === event.payload.actorPlayerId && intent.nightNumber === event.payload.nightNumber);
      if (matchingIntent === undefined || matchingIntent.intentType !== "WITCH") throw new CoreError("INVALID_EVENT_STREAM", "Resource spend requires committed witch intent");
      if (event.payload.resource === "HEAL") {
        if (event.payload.abilityId !== "WITCH_HEAL" || matchingIntent.action !== "HEAL" || witch.healRemaining !== 1) throw new CoreError("INVALID_EVENT_STREAM", "Invalid heal resource spend");
        replaceAbilityState(runtime, { ...witch, healRemaining: 0 });
      } else {
        if (event.payload.abilityId !== "WITCH_POISON" || matchingIntent.action !== "POISON" || witch.poisonRemaining !== 1) throw new CoreError("INVALID_EVENT_STREAM", "Invalid poison resource spend");
        replaceAbilityState(runtime, { ...witch, poisonRemaining: 0 });
      }
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "WolfBallotCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "WolfBallotCommitted requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "NIGHT_WOLF" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId || event.payload.nightNumber !== runtime.nightSession.nightNumber) {
        throw new CoreError("INVALID_EVENT_STREAM", "Wolf ballot phase/night mismatch");
      }
      const session = assertActorCanCommit(runtime, event.payload.actorPlayerId);
      if (event.payload.targetPlayerId !== null && !session.legalTargetsSnapshot.includes(event.payload.targetPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Illegal wolf ballot target");
      const actor = playerById(runtime, event.payload.actorPlayerId);
      if (actor?.effectiveFactionId !== "WOLF") throw new CoreError("INVALID_EVENT_STREAM", "Wolf ballot actor is not wolf faction");
      const wolfTeam = abilityState(runtime, "WOLF_TEAM");
      if (wolfTeam.nightNumber !== event.payload.nightNumber || wolfTeam.knifeTargetStatus !== "UNRESOLVED") throw new CoreError("INVALID_EVENT_STREAM", "Wolf team state already resolved or wrong night");
      wolfTeam.ballots.push({ voterPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId, committedAtSequence: event.sequence });
      replaceAbilityState(runtime, wolfTeam);
      markCommitted(runtime, event.payload.actorPlayerId);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "WolfTargetCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "WolfTargetCommitted requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "NIGHT_WOLF" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId || event.payload.nightNumber !== runtime.nightSession.nightNumber) {
        throw new CoreError("INVALID_EVENT_STREAM", "Wolf target phase/night mismatch");
      }
      const session = currentOpenSession(runtime);
      if (!sameStringSet(session.committedActors, session.eligibleActorsSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Wolf target cannot lock before all ballots");
      const wolfTeam = abilityState(runtime, "WOLF_TEAM");
      if (wolfTeam.knifeTargetStatus !== "UNRESOLVED" || wolfTeam.ballots.length !== session.eligibleActorsSnapshot.length) throw new CoreError("INVALID_EVENT_STREAM", "Wolf target state mismatch");
      const expectedTarget = computeWolfTarget(wolfTeam.ballots);
      if (event.payload.targetPlayerId !== expectedTarget) throw new CoreError("INVALID_EVENT_STREAM", "Wolf target does not match ballot tally");
      replaceAbilityState(runtime, { ...wolfTeam, knifeTargetStatus: "LOCKED", knifeTargetPlayerId: expectedTarget });
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "StatusApplied": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "StatusApplied requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "NIGHT_RESOLUTION" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "StatusApplied outside night resolution");
      if (runtime.statusEffects.some((effect) => effect.statusId === event.payload.status.statusId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate statusId");
      if (event.payload.status.appliedAtSequence !== event.sequence) throw new CoreError("INVALID_EVENT_STREAM", "Status applied sequence mismatch");
      runtime.statusEffects.push(cloneJson(event.payload.status));
      if (event.payload.status.type === "CHARMED") {
        const beauty = abilityState(runtime, "BEAUTY");
        if (beauty.ownerPlayerId !== event.payload.status.sourcePlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Charm source mismatch");
        replaceAbilityState(runtime, { ...beauty, activeCharmStatusId: event.payload.status.statusId });
      }
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "StatusExpired": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "StatusExpired requires existing game");
      const runtime = requireRuntime(state);
      const index = runtime.statusEffects.findIndex((effect) => effect.statusId === event.payload.statusId && effect.active);
      if (index < 0) throw new CoreError("INVALID_EVENT_STREAM", "Cannot expire missing/inactive status");
      const found = runtime.statusEffects[index];
      if (found === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Missing status");
      runtime.statusEffects[index] = { ...found, active: false };
      if (found.type === "CHARMED") {
        const beauty = abilityState(runtime, "BEAUTY");
        if (beauty.activeCharmStatusId === found.statusId) replaceAbilityState(runtime, { ...beauty, activeCharmStatusId: null });
      }
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SeerCheckResolved": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SeerCheckResolved requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "NIGHT_RESOLUTION" || event.payload.nightNumber !== runtime.nightSession.nightNumber) throw new CoreError("INVALID_EVENT_STREAM", "Invalid seer resolution phase/night");
      const actor = playerById(runtime, event.payload.actorPlayerId);
      const target = playerById(runtime, event.payload.targetPlayerId);
      if (actor?.effectiveRoleId !== "SEER" || target === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Invalid seer resolution actor/target");
      const expected = target.effectiveFactionId === "WOLF" ? "WOLF" : "GOOD";
      if (event.payload.result !== expected) throw new CoreError("INVALID_EVENT_STREAM", "Incorrect seer result");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "PrivateObservationPublished": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "PrivateObservationPublished requires existing game");
      if (event.audience.kind !== "PRIVATE_RECIPIENTS" || !sameStringSet(event.audience.playerIds, event.payload.recipientPlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Private observation audience mismatch");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence });
    }
    case "EffectResolved": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "EffectResolved requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.resolutionGroup === null || runtime.resolutionGroup.resolutionGroupId !== event.payload.resolutionGroupId) throw new CoreError("INVALID_EVENT_STREAM", "Effect outside current resolution group");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence });
    }
    case "DeathWaveResolved": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "DeathWaveResolved requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.resolutionGroup === null || runtime.resolutionGroup.resolutionGroupId !== event.payload.resolutionGroupId || event.payload.round !== runtime.round) throw new CoreError("INVALID_EVENT_STREAM", "Death wave group/round mismatch");
      const seen = new Set<string>();
      for (const death of event.payload.deaths) {
        if (seen.has(death.playerId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate death in same wave");
        seen.add(death.playerId);
        const index = runtime.players.findIndex((player) => player.playerId === death.playerId);
        const player = runtime.players[index];
        if (index < 0 || player === undefined || player.lifeState !== "ALIVE") throw new CoreError("INVALID_EVENT_STREAM", "Death target must be alive at wave start");
        const deathId = `${event.payload.waveId}:${death.playerId}`;
        runtime.players[index] = { ...player, lifeState: "DEAD", deathRecordId: deathId };
        runtime.resolutionGroup.deathRecords.push({ deathId, playerId: death.playerId, resolutionGroupId: event.payload.resolutionGroupId, waveId: event.payload.waveId, round: event.payload.round, causes: [...new Set(death.causes)], sourceEffectIds: [...new Set(death.sourceEffectIds)], deathEventSequence: event.sequence });
      }
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "DawnAnnouncementPublished": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Dawn announcement requires existing game");
      const runtime = requireRuntime(state);
      if (event.audience.kind !== "PUBLIC" || runtime.resolutionGroup === null) throw new CoreError("INVALID_EVENT_STREAM", "Dawn announcement audience/group mismatch");
      const expected = runtime.resolutionGroup.deathRecords.filter((record) => record.round === event.payload.round).map((record) => record.playerId).sort();
      if (!sameStringSet(expected, event.payload.deadPlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Dawn death list mismatch");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence });
    }
    case "ReactionWindowOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ReactionWindowOpened requires existing game");
      const runtime = requireRuntime(state);
      const reaction = event.payload.reaction;
      if (reaction.kind !== "HUNTER_SHOT" || reaction.status !== "OPEN" || reaction.sessionId !== event.payload.reaction.sessionId) throw new CoreError("INVALID_EVENT_STREAM", "Invalid reaction window");
      const hunter = abilityState(runtime, "HUNTER");
      if (hunter.ownerPlayerId !== reaction.actorPlayerId || hunter.shotRemaining !== 1) throw new CoreError("INVALID_EVENT_STREAM", "Hunter reaction owner/resource mismatch");
      const death = runtime.resolutionGroup?.deathRecords.find((record) => record.deathId === reaction.triggerDeathId);
      if (death === undefined || death.playerId !== reaction.actorPlayerId || death.causes.includes("WITCH_POISON") || death.causes.includes("WOLF_BEAUTY_LINK")) throw new CoreError("INVALID_EVENT_STREAM", "Hunter death is not reaction-eligible");
      runtime.pendingReactions.push(cloneJson(reaction));
      if (runtime.resolutionGroup !== null) runtime.resolutionGroup.status = "WAITING_REACTIONS";
      replaceAbilityState(runtime, { ...hunter, reactionStatus: "PENDING" });
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ReactionCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ReactionCommitted requires existing game");
      const runtime = requireRuntime(state);
      const index = runtime.pendingReactions.findIndex((reaction) => reaction.reactionId === event.payload.reactionId && reaction.status === "OPEN");
      const reaction = runtime.pendingReactions[index];
      if (index < 0 || reaction === undefined || reaction.actorPlayerId !== event.payload.actorPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "No matching open reaction");
      if (event.payload.action === "SHOOT") {
        if (event.payload.targetPlayerId === null || !reaction.legalTargetsSnapshot.includes(event.payload.targetPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Illegal hunter target");
        runtime.pendingReactions[index] = { ...reaction, status: "COMMITTED" };
      } else {
        if (event.payload.targetPlayerId !== null) throw new CoreError("INVALID_EVENT_STREAM", "PASS has no target");
        runtime.pendingReactions[index] = { ...reaction, status: "FORFEITED" };
      }
      const hunter = abilityState(runtime, "HUNTER");
      replaceAbilityState(runtime, { ...hunter, shotRemaining: 0, reactionStatus: event.payload.action === "SHOOT" ? "COMMITTED" : "FORFEITED" });
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ReactionClosed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ReactionClosed requires existing game");
      const runtime = requireRuntime(state);
      const reaction = runtime.pendingReactions.find((entry) => entry.reactionId === event.payload.reactionId);
      if (reaction === undefined || reaction.status === "OPEN") throw new CoreError("INVALID_EVENT_STREAM", "Cannot close uncommitted reaction");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "NightStarted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "NightStarted requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.phase === null || runtime.phase.status !== "CLOSED") throw new CoreError("INVALID_EVENT_STREAM", "NightStarted requires closed prior phase");
      if (event.payload.nightNumber !== runtime.round + 1) throw new CoreError("INVALID_EVENT_STREAM", "Night number must increment by one");
      const alive = runtime.players.filter((player) => player.lifeState === "ALIVE").map((player) => player.playerId);
      if (!sameStringSet(alive, event.payload.alivePlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Night alive snapshot mismatch");
      runtime.round = event.payload.nightNumber;
      runtime.nightSession = { nightNumber: event.payload.nightNumber, nightStartAlivePlayerIds: [...event.payload.alivePlayerIds], currentActionSession: null, intents: [], status: "COLLECTING" };
      const wolfTeam = abilityState(runtime, "WOLF_TEAM");
      replaceAbilityState(runtime, { ...wolfTeam, nightNumber: event.payload.nightNumber, ballots: [], knifeTargetStatus: "UNRESOLVED", knifeTargetPlayerId: null });
      runtime.speechSession = null;
      runtime.voteSession = null;
      runtime.resolutionGroup = null;
      runtime.pendingReactions = [];
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SpeechSessionOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SpeechSessionOpened requires existing game");
      const runtime = requireRuntime(state);
      const session = event.payload.session;
      if (runtime.phase === null || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId || session.phaseId !== runtime.phase.phaseId) throw new CoreError("INVALID_EVENT_STREAM", "Speech session phase mismatch");
      const phaseKind: Partial<Record<PhaseType, typeof session.kind>> = { LAST_WORDS: "LAST_WORDS", SHERIFF_SPEECH: "SHERIFF_SPEECH", SHERIFF_PK_SPEECH: "SHERIFF_PK_SPEECH", DAY_DISCUSSION: "DAY_DISCUSSION", DAY_PK_SPEECH: "DAY_PK_SPEECH" };
      if (phaseKind[runtime.phase.phaseType] !== session.kind || session.status !== "OPEN" || session.completedSpeakers.length !== 0 || !unique(session.speakerOrderSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid speech session");
      for (const speaker of session.speakerOrderSnapshot) {
        const p = playerById(runtime, speaker); if (p === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Unknown speech participant");
        if (session.kind !== "LAST_WORDS" && p.lifeState !== "ALIVE") throw new CoreError("INVALID_EVENT_STREAM", "Dead player cannot join normal speech session");
      }
      if (!speechSnapshotIsValid(state, runtime, session.kind, session.speakerOrderSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Speech speaker/order snapshot mismatch");
      runtime.speechSession = cloneJson(session);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SpeechPublished": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SpeechPublished requires existing game");
      const runtime = requireRuntime(state); const session = runtime.speechSession;
      if (event.audience.kind !== "PUBLIC" || session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || event.payload.publishedAtSequence !== event.sequence) throw new CoreError("INVALID_EVENT_STREAM", "Invalid speech publication");
      const expected = session.speakerOrderSnapshot[session.completedSpeakers.length];
      if (expected !== event.payload.speakerPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Speech out of order");
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence });
    }
    case "SpeechFinished": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SpeechFinished requires existing game");
      const runtime = requireRuntime(state); const session = runtime.speechSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId) throw new CoreError("INVALID_EVENT_STREAM", "No matching speech session");
      const expected = session.speakerOrderSnapshot[session.completedSpeakers.length];
      if (expected !== event.payload.speakerPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Speech finish out of order");
      session.completedSpeakers.push(event.payload.speakerPlayerId);
      if (session.completedSpeakers.length === session.speakerOrderSnapshot.length) session.status = "CLOSED";
      runtime.speechSession = session;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffSignupSessionOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff signup requires existing game");
      const runtime = requireRuntime(state); const session = event.payload.session;
      if (runtime.phase?.phaseType !== "SHERIFF_SIGNUP" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId || session.status !== "OPEN" || session.committedPlayerIds.length !== 0 || session.joinedPlayerIds.length !== 0) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff signup session");
      const alive = runtime.players.filter((p) => p.lifeState === "ALIVE").map((p) => p.playerId);
      if (!sameStringSet(alive, session.eligiblePlayersSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff signup eligibility mismatch");
      runtime.sheriff.electionAttempted = true; runtime.sheriff.signupSession = cloneJson(session); runtime.sheriff.candidatePlayerIds = []; runtime.sheriff.withdrawnPlayerIds = [];
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffSignupCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff signup commit requires game");
      const runtime = requireRuntime(state); const session = runtime.sheriff.signupSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || !session.eligiblePlayersSnapshot.includes(event.payload.actorPlayerId) || session.committedPlayerIds.includes(event.payload.actorPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff signup commit");
      session.committedPlayerIds.push(event.payload.actorPlayerId); if (event.payload.join) session.joinedPlayerIds.push(event.payload.actorPlayerId); runtime.sheriff.signupSession = session;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffSignupSessionClosed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff signup close requires game");
      const runtime = requireRuntime(state); const session = runtime.sheriff.signupSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || !sameStringSet(session.committedPlayerIds, session.eligiblePlayersSnapshot) || !sameStringSet(session.joinedPlayerIds, event.payload.candidatePlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff signup closure");
      const voters = session.eligiblePlayersSnapshot.filter((id) => !session.joinedPlayerIds.includes(id));
      if (!sameStringSet(voters, event.payload.originalVoterPlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Original sheriff voter snapshot mismatch");
      runtime.sheriff.signupSession = { ...session, status: "CLOSED" }; runtime.sheriff.candidatePlayerIds = [...event.payload.candidatePlayerIds]; runtime.sheriff.originalVoterPlayerIds = [...event.payload.originalVoterPlayerIds];
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffWithdrawalSessionOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff withdrawal requires game");
      const runtime = requireRuntime(state); const session = event.payload.session;
      if (runtime.phase?.phaseType !== "SHERIFF_WITHDRAWAL" || runtime.phase.status !== "OPEN" || session.status !== "OPEN" || session.committedPlayerIds.length !== 0 || session.withdrawnPlayerIds.length !== 0 || !sameStringSet(session.candidatePlayersSnapshot, runtime.sheriff.candidatePlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff withdrawal session");
      runtime.sheriff.withdrawalSession = cloneJson(session);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffWithdrawalCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff withdrawal commit requires game");
      const runtime = requireRuntime(state); const session = runtime.sheriff.withdrawalSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || !session.candidatePlayersSnapshot.includes(event.payload.actorPlayerId) || session.committedPlayerIds.includes(event.payload.actorPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff withdrawal commit");
      session.committedPlayerIds.push(event.payload.actorPlayerId); if (event.payload.withdraw) session.withdrawnPlayerIds.push(event.payload.actorPlayerId); runtime.sheriff.withdrawalSession = session;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffWithdrawalSessionClosed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff withdrawal close requires game");
      const runtime = requireRuntime(state); const session = runtime.sheriff.withdrawalSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || !sameStringSet(session.committedPlayerIds, session.candidatePlayersSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff withdrawal closure");
      const remaining = session.candidatePlayersSnapshot.filter((id) => !session.withdrawnPlayerIds.includes(id));
      if (!sameStringSet(remaining, event.payload.remainingCandidatePlayerIds)) throw new CoreError("INVALID_EVENT_STREAM", "Remaining candidate mismatch");
      runtime.sheriff.withdrawalSession = { ...session, status: "CLOSED" }; runtime.sheriff.withdrawnPlayerIds = [...session.withdrawnPlayerIds]; runtime.sheriff.candidatePlayerIds = [...remaining];
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "VoteSessionOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "VoteSessionOpened requires game");
      const runtime = requireRuntime(state); const session = event.payload.session;
      const kindByPhase: Partial<Record<PhaseType, typeof session.kind>> = { SHERIFF_VOTE: "SHERIFF", SHERIFF_PK_VOTE: "SHERIFF_PK", DAY_VOTE: "DAY", DAY_PK_VOTE: "DAY_PK" };
      if (runtime.phase === null || runtime.phase.status !== "OPEN" || session.phaseId !== runtime.phase.phaseId || event.phaseId !== runtime.phase.phaseId || kindByPhase[runtime.phase.phaseType] !== session.kind || session.status !== "OPEN" || session.ballots.length !== 0 || session.result !== null || !unique(session.eligibleVotersSnapshot) || !unique(session.eligibleTargetsSnapshot)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid vote session");
      for (const voter of session.eligibleVotersSnapshot) { if (playerById(runtime, voter)?.lifeState !== "ALIVE" || session.weightUnitsByVoter[voter] === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Invalid voter snapshot"); }
      for (const key of Object.keys(session.weightUnitsByVoter)) if (!session.eligibleVotersSnapshot.includes(key)) throw new CoreError("INVALID_EVENT_STREAM", "Vote weight for ineligible voter");
      for (const target of session.eligibleTargetsSnapshot) if (playerById(runtime, target)?.lifeState !== "ALIVE") throw new CoreError("INVALID_EVENT_STREAM", "Invalid vote target snapshot");
      const expectedVote = expectedVoteSnapshot(state, runtime, session.kind);
      if (session.roundIndex !== expectedVote.roundIndex || stableStringify(session.eligibleVotersSnapshot) !== stableStringify(expectedVote.voters) || stableStringify(session.eligibleTargetsSnapshot) !== stableStringify(expectedVote.targets) || stableStringify(session.weightUnitsByVoter) !== stableStringify(expectedVote.weights)) throw new CoreError("INVALID_EVENT_STREAM", "Vote snapshot/weight mismatch");
      runtime.voteSession = cloneJson(session);
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "BallotCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "BallotCommitted requires game");
      const runtime = requireRuntime(state); const session = runtime.voteSession;
      if (session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || !session.eligibleVotersSnapshot.includes(event.payload.voterPlayerId) || session.ballots.some((b) => b.voterPlayerId === event.payload.voterPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid ballot voter/session");
      if (event.payload.targetPlayerId !== null && !session.eligibleTargetsSnapshot.includes(event.payload.targetPlayerId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid ballot target");
      session.ballots.push({ voterPlayerId: event.payload.voterPlayerId, targetPlayerId: event.payload.targetPlayerId, committedAtSequence: event.sequence }); runtime.voteSession = session;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "VoteSessionResolved": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Vote resolution requires game");
      const runtime = requireRuntime(state); const session = runtime.voteSession;
      if (event.audience.kind !== "PUBLIC" || session === null || session.status !== "OPEN" || session.sessionId !== event.payload.sessionId || session.ballots.length !== session.eligibleVotersSnapshot.length) throw new CoreError("INVALID_EVENT_STREAM", "Vote not ready to resolve");
      const normalize = (xs: typeof session.ballots) => [...xs].sort((a,b)=>a.voterPlayerId.localeCompare(b.voterPlayerId));
      if (stableStringify(normalize(session.ballots)) !== stableStringify(normalize(event.payload.ballots))) throw new CoreError("INVALID_EVENT_STREAM", "Published ballot set mismatch");
      const expected = computeVoteResult(session.eligibleTargetsSnapshot, session.weightUnitsByVoter, session.ballots);
      if (stableStringify(expected) !== stableStringify(event.payload.result)) throw new CoreError("INVALID_EVENT_STREAM", "Vote result mismatch");
      runtime.voteSession = { ...session, status: "CLOSED", result: cloneJson(event.payload.result) };
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffElected": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "SheriffElected requires game"); const runtime = requireRuntime(state);
      if (event.audience.kind !== "PUBLIC" || playerById(runtime, event.payload.playerId)?.lifeState !== "ALIVE" || !runtime.sheriff.candidatePlayerIds.includes(event.payload.playerId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid elected sheriff");
      const phaseType = runtime.phase?.phaseType;
      let expectedWinner: string | null = null;
      if (phaseType === "SHERIFF_SIGNUP" || phaseType === "SHERIFF_WITHDRAWAL") {
        const livingCandidates = runtime.sheriff.candidatePlayerIds.filter((id) => playerById(runtime, id)?.lifeState === "ALIVE");
        if (livingCandidates.length === 1) expectedWinner = livingCandidates[0] ?? null;
      } else if (phaseType === "SHERIFF_VOTE" || phaseType === "SHERIFF_PK_VOTE") {
        const result = runtime.voteSession?.result;
        if (result?.resolutionKind === "WINNER") expectedWinner = result.winningTargetId;
      }
      if (expectedWinner !== event.payload.playerId) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff winner does not match election state");
      runtime.sheriff.holderPlayerId = event.payload.playerId; runtime.sheriff.badgeStatus = "ACTIVE"; runtime.sheriff.electedAtSequence = event.sequence; runtime.sheriff.electionAttempted = true;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffElectionClosedNoBadge": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff no-badge event requires game"); const runtime = requireRuntime(state);
      if (event.audience.kind !== "PUBLIC") throw new CoreError("INVALID_EVENT_STREAM", "Sheriff result must be public");
      runtime.sheriff.holderPlayerId = null; runtime.sheriff.badgeStatus = "NO_BADGE"; runtime.sheriff.electionAttempted = true;
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffTransferred": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff transfer requires game"); const runtime = requireRuntime(state);
      if (event.audience.kind !== "PUBLIC" || runtime.sheriff.badgeStatus !== "ACTIVE" || runtime.sheriff.holderPlayerId !== event.payload.fromPlayerId || playerById(runtime, event.payload.fromPlayerId)?.lifeState !== "DEAD" || playerById(runtime, event.payload.toPlayerId)?.lifeState !== "ALIVE") throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff transfer");
      runtime.sheriff.holderPlayerId = event.payload.toPlayerId; runtime.sheriff.badgeStatus = "ACTIVE";
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SheriffBadgeDestroyed": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Sheriff badge destruction requires game"); const runtime = requireRuntime(state);
      if (event.audience.kind !== "PUBLIC" || runtime.sheriff.badgeStatus !== "ACTIVE" || runtime.sheriff.holderPlayerId !== event.payload.holderPlayerId || playerById(runtime, event.payload.holderPlayerId)?.lifeState !== "DEAD") throw new CoreError("INVALID_EVENT_STREAM", "Invalid sheriff badge destruction");
      runtime.sheriff.holderPlayerId = null; runtime.sheriff.badgeStatus = "DESTROYED";
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ResolutionGroupOpened": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Day resolution group requires game"); const runtime = requireRuntime(state);
      if (runtime.phase?.phaseType !== "DAY_RESOLUTION" || runtime.phase.status !== "OPEN" || event.phaseId !== runtime.phase.phaseId || event.payload.round !== runtime.round || (runtime.resolutionGroup !== null && runtime.resolutionGroup.status !== "SETTLED")) throw new CoreError("INVALID_EVENT_STREAM", "Invalid day resolution group open");
      runtime.resolutionGroup = { resolutionGroupId: event.payload.resolutionGroupId, kind: event.payload.kind, round: event.payload.round, status: "RESOLVING", deathRecords: [] };
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "SelfExplosionCommitted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "Self explosion requires game"); const runtime = requireRuntime(state);
      const allowed = ["SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"] as const;
      const actor = playerById(runtime, event.payload.actorPlayerId);
      if (event.audience.kind !== "PUBLIC" || runtime.phase === null || runtime.phase.status !== "OPEN" || !allowed.includes(runtime.phase.phaseType as typeof allowed[number]) || actor?.lifeState !== "ALIVE" || actor.effectiveFactionId !== "WOLF" || runtime.speechSession === null || runtime.speechSession.status !== "OPEN") throw new CoreError("INVALID_EVENT_STREAM", "Invalid self explosion");
      runtime.speechSession = { ...runtime.speechSession, status: "CLOSED" };
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "ResolutionGroupSettled": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "ResolutionGroupSettled requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.resolutionGroup === null || runtime.resolutionGroup.resolutionGroupId !== event.payload.resolutionGroupId) throw new CoreError("INVALID_EVENT_STREAM", "Resolution group mismatch");
      if (runtime.pendingReactions.some((reaction) => reaction.status === "OPEN")) throw new CoreError("INVALID_EVENT_STREAM", "Cannot settle with open reactions");
      runtime.resolutionGroup.status = "SETTLED";
      if (runtime.resolutionGroup.kind === "NIGHT") runtime.nightSession.status = "READY_FOR_RESOLUTION";
      return GameStateSchema.parse({ ...cloneJson(state), lastSequence: event.sequence, runtime });
    }
    case "GameEnded": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "GameEnded requires existing game");
      const runtime = requireRuntime(state);
      if (runtime.resolutionGroup?.status !== "SETTLED") throw new CoreError("INVALID_EVENT_STREAM", "Game may end only after settled resolution group");
      runtime.outcome = { result: event.payload.result, determinedAtSequence: event.sequence };
      runtime.endedAtIso = event.payload.endedAtIso;
      return GameStateSchema.parse({ ...cloneJson(state), status: "ENDED", lastSequence: event.sequence, runtime });
    }
    case "GameAborted": {
      if (state === null) throw new CoreError("INVALID_EVENT_STREAM", "GameAborted requires existing game");
      if (state.status === "ABORTED" || state.status === "ENDED") throw new CoreError("INVALID_EVENT_STREAM", "Game cannot be aborted from current status");
      return GameStateSchema.parse({ ...cloneJson(state), status: "ABORTED", lastSequence: event.sequence, abortReason: event.payload.reason });
    }
  }
}

export function replay(events: readonly unknown[]): GameState | null {
  let state: GameState | null = null;
  const seenIds = new Set<string>();
  for (const raw of events) {
    const event = parseEvent(raw);
    if (seenIds.has(event.eventId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate eventId");
    seenIds.add(event.eventId);
    state = reduceEvent(state, event);
  }
  return state === null ? null : cloneJson(state);
}

export function replayFromState(initialState: GameState | null, events: readonly unknown[]): GameState | null {
  let state: GameState | null = initialState === null ? null : GameStateSchema.parse(cloneJson(initialState));
  const seenIds = new Set<string>();
  for (const raw of events) {
    const event = parseEvent(raw);
    if (seenIds.has(event.eventId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate eventId in replay tail");
    seenIds.add(event.eventId);
    state = reduceEvent(state, event);
  }
  return state === null ? null : cloneJson(state);
}

export function tallyWolfTarget(ballots: readonly { targetPlayerId: string | null }[]): string | null {
  return computeWolfTarget(ballots);
}
