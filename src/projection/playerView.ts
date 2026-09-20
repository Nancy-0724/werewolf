import { CoreError } from "../core/domain/errors.js";
import { cloneJson } from "../core/domain/json.js";
import { reduceEvent } from "../core/domain/reducer.js";
import {
  parseEvent,
  type AbilityState,
  type DomainEvent,
  type GameState,
  type RuntimeState,
  type Seat,
} from "../core/domain/schemas.js";
import type { DurableGameStore } from "../core/persistence/contracts.js";
import {
  PlayerViewSchema,
  PublicGameViewSchema,
  type PlayerActionPrompt,
  type PlayerView,
  type PostGameReveal,
  type PrivateObservation,
  type PublicGameView,
  type PublicObservation,
  type PublicStageKind,
  type PublicTurnView,
  type ViewerAbilityState,
  type ViewerIdentity,
} from "./schemas.js";

interface ProjectionCompilation {
  state: GameState;
  events: DomainEvent[];
  publicTimeline: PublicObservation[];
  publicDeadPlayerIds: Set<string>;
  sheriff: {
    badgeStatus: "UNASSIGNED" | "ACTIVE" | "NO_BADGE" | "DESTROYED";
    holderPlayerId: string | null;
    electionAttempted: boolean;
    visibleCandidatePlayerIds: string[];
  };
  privateByPlayer: Map<string, PrivateObservation[]>;
}

function roleDefinition(state: GameState, roleId: string) {
  const ruleset = state.manifest?.rulesetSnapshot ?? state.lobby?.rulesetDraft;
  const role = ruleset?.roleDefinitions.find((entry) => entry.roleId === roleId);
  if (role === undefined) throw new CoreError("INVALID_EVENT_STREAM", `Missing role definition ${roleId}`);
  return role;
}

function seatsForState(state: GameState): Seat[] {
  const seats = state.manifest?.seatsSnapshot ?? state.lobby?.seats ?? [];
  return [...seats].sort((a, b) => a.seatNumber - b.seatNumber);
}

function seatSort(state: GameState, playerIds: readonly string[]): string[] {
  const numbers = new Map(seatsForState(state).map((seat) => [seat.playerId, seat.seatNumber]));
  return [...playerIds].sort((a, b) => (numbers.get(a) ?? 999) - (numbers.get(b) ?? 999));
}

function ability<K extends AbilityState["kind"]>(runtime: RuntimeState, kind: K): Extract<AbilityState, { kind: K }> | null {
  return runtime.abilityStates.find((entry): entry is Extract<AbilityState, { kind: K }> => entry.kind === kind) ?? null;
}

function privatePush(map: Map<string, PrivateObservation[]>, playerId: string, observation: Omit<PrivateObservation, "ordinal">): void {
  const current = map.get(playerId) ?? [];
  current.push({ ...observation, ordinal: current.length + 1 } as PrivateObservation);
  map.set(playerId, current);
}

function publicPush(list: PublicObservation[], observation: Omit<PublicObservation, "ordinal">): void {
  list.push({ ...observation, ordinal: list.length + 1 } as PublicObservation);
}

function compile(rawEvents: readonly unknown[]): ProjectionCompilation {
  if (rawEvents.length === 0) throw new CoreError("GAME_NOT_FOUND", "Cannot project an empty game");
  const events = rawEvents.map((raw) => parseEvent(raw));
  let state: GameState | null = null;
  const publicTimeline: PublicObservation[] = [];
  const publicDeadPlayerIds = new Set<string>();
  const announcedNightGroups = new Set<string>();
  const privateByPlayer = new Map<string, PrivateObservation[]>();
  const sheriff: ProjectionCompilation["sheriff"] = { badgeStatus: "UNASSIGNED", holderPlayerId: null, electionAttempted: false, visibleCandidatePlayerIds: [] };

  for (const event of events) {
    const before = state;
    state = reduceEvent(state, event);
    const after = state;

    if (event.eventType === "GameStarted") publicPush(publicTimeline, { type: "GAME_STARTED", round: 1 });
    else if (event.eventType === "NightStarted") publicPush(publicTimeline, { type: "NIGHT_STARTED", round: event.payload.nightNumber });
    else if (event.eventType === "DawnAnnouncementPublished") {
      const deadPlayerIds = seatSort(after, event.payload.deadPlayerIds);
      for (const playerId of deadPlayerIds) publicDeadPlayerIds.add(playerId);
      const groupId = before?.runtime?.resolutionGroup?.resolutionGroupId ?? after.runtime?.resolutionGroup?.resolutionGroupId ?? null;
      if (groupId !== null) announcedNightGroups.add(groupId);
      publicPush(publicTimeline, { type: "DAWN", round: event.payload.round, deadPlayerIds });
    } else if (event.eventType === "SpeechPublished") {
      const speechKind = before?.runtime?.speechSession?.kind;
      if (speechKind !== undefined && speechKind !== null) publicPush(publicTimeline, { type: "SPEECH", speakerPlayerId: event.payload.speakerPlayerId, speechKind, text: event.payload.text, source: event.payload.source });
    } else if (event.eventType === "SheriffSignupSessionClosed") {
      sheriff.electionAttempted = true;
      sheriff.visibleCandidatePlayerIds = seatSort(after, event.payload.candidatePlayerIds);
      publicPush(publicTimeline, { type: "SHERIFF_CANDIDATES", candidatePlayerIds: seatSort(after, event.payload.candidatePlayerIds), voterPlayerIds: seatSort(after, event.payload.originalVoterPlayerIds) });
    } else if (event.eventType === "SheriffWithdrawalSessionClosed") {
      sheriff.visibleCandidatePlayerIds = seatSort(after, event.payload.remainingCandidatePlayerIds);
      publicPush(publicTimeline, { type: "SHERIFF_WITHDRAWAL_RESULT", remainingCandidatePlayerIds: seatSort(after, event.payload.remainingCandidatePlayerIds) });
    } else if (event.eventType === "VoteSessionResolved") {
      const session = before?.runtime?.voteSession;
      if (session !== undefined && session !== null) publicPush(publicTimeline, {
        type: "VOTE_RESULT",
        voteKind: session.kind,
        roundIndex: session.roundIndex,
        ballots: event.payload.ballots.map((ballot) => ({ voterPlayerId: ballot.voterPlayerId, targetPlayerId: ballot.targetPlayerId })),
        tallyUnitsByTarget: cloneJson(event.payload.result.tallyUnitsByTarget),
        abstainedPlayerIds: seatSort(after, event.payload.result.abstainedPlayerIds),
        tiedPlayerIds: seatSort(after, event.payload.result.tiedPlayerIds),
        winningTargetId: event.payload.result.winningTargetId,
        resolutionKind: event.payload.result.resolutionKind,
      });
    } else if (event.eventType === "SheriffElected") {
      sheriff.badgeStatus = "ACTIVE"; sheriff.holderPlayerId = event.payload.playerId; sheriff.electionAttempted = true; sheriff.visibleCandidatePlayerIds = [];
      publicPush(publicTimeline, { type: "SHERIFF_ELECTED", playerId: event.payload.playerId });
    } else if (event.eventType === "SheriffElectionClosedNoBadge") {
      sheriff.badgeStatus = "NO_BADGE"; sheriff.holderPlayerId = null; sheriff.electionAttempted = true; sheriff.visibleCandidatePlayerIds = [];
      publicPush(publicTimeline, { type: "SHERIFF_NO_BADGE", reason: event.payload.reason });
    } else if (event.eventType === "SheriffTransferred") {
      sheriff.badgeStatus = "ACTIVE"; sheriff.holderPlayerId = event.payload.toPlayerId;
      publicPush(publicTimeline, { type: "SHERIFF_TRANSFERRED", fromPlayerId: event.payload.fromPlayerId, toPlayerId: event.payload.toPlayerId });
    } else if (event.eventType === "SheriffBadgeDestroyed") {
      sheriff.badgeStatus = "DESTROYED"; sheriff.holderPlayerId = null;
      publicPush(publicTimeline, { type: "SHERIFF_BADGE_DESTROYED", holderPlayerId: event.payload.holderPlayerId });
    } else if (event.eventType === "SelfExplosionCommitted") {
      publicDeadPlayerIds.add(event.payload.actorPlayerId);
      publicPush(publicTimeline, { type: "SELF_EXPLOSION", playerId: event.payload.actorPlayerId });
    } else if (event.eventType === "ReactionCommitted" && event.payload.action === "SHOOT" && event.payload.targetPlayerId !== null) {
      publicPush(publicTimeline, { type: "HUNTER_SHOT", hunterPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId });
    } else if (event.eventType === "DeathWaveResolved") {
      const kind = before?.runtime?.resolutionGroup?.kind ?? after.runtime?.resolutionGroup?.kind ?? null;
      const isPublicWave = kind !== "NIGHT" || announcedNightGroups.has(event.payload.resolutionGroupId);
      if (isPublicWave) {
        const newlyRevealed = seatSort(after, event.payload.deaths.map((death) => death.playerId).filter((playerId) => !publicDeadPlayerIds.has(playerId)));
        for (const death of event.payload.deaths) publicDeadPlayerIds.add(death.playerId);
        if (newlyRevealed.length > 0) publicPush(publicTimeline, { type: "DEATHS_REVEALED", playerIds: newlyRevealed });
      }
    } else if (event.eventType === "GameEnded") publicPush(publicTimeline, { type: "GAME_ENDED", result: event.payload.result });
    else if (event.eventType === "GameAborted") publicPush(publicTimeline, { type: "GAME_ABORTED" });

    if (event.eventType === "PrivateObservationPublished" && event.payload.observationType === "SEER_CHECK") {
      const nightNumber = before?.runtime?.nightSession.nightNumber ?? after.runtime?.nightSession.nightNumber ?? 1;
      for (const recipient of event.payload.recipientPlayerIds) privatePush(privateByPlayer, recipient, { type: "SEER_CHECK", nightNumber, targetPlayerId: event.payload.data.targetPlayerId, result: event.payload.data.result });
    }

    if (event.eventType === "ActionWindowOpened" && after.runtime?.phase?.phaseType === "NIGHT_WITCH") {
      const witchState = ability(after.runtime, "WITCH");
      const wolfState = ability(after.runtime, "WOLF_TEAM");
      for (const recipient of event.payload.session.eligibleActorsSnapshot) {
        if (witchState?.ownerPlayerId !== recipient || wolfState === null) continue;
        if (witchState.healRemaining === 0) privatePush(privateByPlayer, recipient, { type: "WITCH_KNIFE_INFO", nightNumber: after.runtime.nightSession.nightNumber, status: "UNAVAILABLE", targetPlayerId: null });
        else if (wolfState.knifeTargetPlayerId === null) privatePush(privateByPlayer, recipient, { type: "WITCH_KNIFE_INFO", nightNumber: after.runtime.nightSession.nightNumber, status: "NO_ATTACK", targetPlayerId: null });
        else privatePush(privateByPlayer, recipient, { type: "WITCH_KNIFE_INFO", nightNumber: after.runtime.nightSession.nightNumber, status: "TARGET", targetPlayerId: wolfState.knifeTargetPlayerId });
      }
    }

    if (event.eventType === "WolfTargetCommitted") {
      const session = before?.runtime?.nightSession.currentActionSession;
      if (before?.runtime?.phase?.phaseType === "NIGHT_WOLF" && session !== undefined && session !== null) {
        for (const recipient of session.eligibleActorsSnapshot) privatePush(privateByPlayer, recipient, { type: "WOLF_TARGET", nightNumber: event.payload.nightNumber, status: event.payload.targetPlayerId === null ? "NO_KILL" : "TARGET", targetPlayerId: event.payload.targetPlayerId });
      }
    }
  }

  if (state === null) throw new CoreError("GAME_NOT_FOUND", "Cannot project an empty game");
  return { state, events, publicTimeline, publicDeadPlayerIds, sheriff, privateByPlayer };
}

function stageOf(state: GameState): { kind: PublicStageKind; round: number | null } {
  if (state.status === "LOBBY") return { kind: "LOBBY", round: null };
  if (state.status === "LOCKED") return { kind: "LOCKED", round: null };
  if (state.status === "ENDED") return { kind: "ENDED", round: state.runtime?.round ?? null };
  if (state.status === "ABORTED") return { kind: "ABORTED", round: state.runtime?.round ?? null };
  const runtime = state.runtime;
  const phase = runtime?.phase?.phaseType ?? "NIGHT_GUARD";
  if (phase.startsWith("NIGHT_")) return { kind: "NIGHT", round: runtime?.round ?? null };
  if (phase.startsWith("DAWN_") || phase === "LAST_WORDS") return { kind: "DAWN", round: runtime?.round ?? null };
  if (phase.startsWith("SHERIFF_")) return { kind: "SHERIFF", round: runtime?.round ?? null };
  return { kind: "DAY", round: runtime?.round ?? null };
}

function currentTurn(state: GameState): PublicTurnView {
  const runtime = state.runtime;
  if (runtime === null || state.status !== "IN_PROGRESS" || runtime.phase?.status !== "OPEN") return { kind: "NONE" };
  const phase = runtime.phase.phaseType;
  if (runtime.speechSession !== null && runtime.speechSession.status === "OPEN" && !phase.startsWith("NIGHT_") && !phase.startsWith("DAWN_HUNTER")) {
    const session = runtime.speechSession;
    return { kind: "SPEECH", speechKind: session.kind, currentSpeakerPlayerId: session.speakerOrderSnapshot[session.completedSpeakers.length] ?? null, speakerOrderPlayerIds: cloneJson(session.speakerOrderSnapshot) };
  }
  if (runtime.voteSession !== null && runtime.voteSession.status === "OPEN") return { kind: "VOTE", voteKind: runtime.voteSession.kind, roundIndex: runtime.voteSession.roundIndex, eligibleVoterPlayerIds: cloneJson(runtime.voteSession.eligibleVotersSnapshot), eligibleTargetPlayerIds: cloneJson(runtime.voteSession.eligibleTargetsSnapshot) };
  if (phase === "SHERIFF_SIGNUP" && runtime.sheriff.signupSession?.status === "OPEN") return { kind: "SHERIFF_SIGNUP" };
  if (phase === "SHERIFF_WITHDRAWAL" && runtime.sheriff.withdrawalSession?.status === "OPEN") return { kind: "SHERIFF_WITHDRAWAL", candidatePlayerIds: cloneJson(runtime.sheriff.withdrawalSession.candidatePlayersSnapshot) };
  if (phase === "DAY_ORDER_SELECTION" && runtime.sheriff.holderPlayerId !== null) return { kind: "DAY_ORDER_SELECTION", sheriffPlayerId: runtime.sheriff.holderPlayerId };
  if (phase === "SHERIFF_BADGE_ACTION" && runtime.sheriff.holderPlayerId !== null) return { kind: "SHERIFF_BADGE_ACTION", holderPlayerId: runtime.sheriff.holderPlayerId };
  return { kind: "NONE" };
}

function publicRuleset(state: GameState) {
  const ruleset = state.manifest?.rulesetSnapshot ?? state.lobby?.rulesetDraft;
  if (ruleset === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Missing ruleset for public view");
  const names = new Map(ruleset.roleDefinitions.map((role) => [role.roleId, role.displayName]));
  return { rulesetId: ruleset.rulesetId, rulesetVersion: ruleset.rulesetVersion, roles: ruleset.roleCounts.map((entry) => ({ roleId: entry.roleId, displayName: names.get(entry.roleId) ?? entry.roleId, count: entry.count })), sheriffEnabled: ruleset.options.sheriffEnabled };
}

function buildPublicView(compiled: ProjectionCompilation): PublicGameView {
  const { state, publicDeadPlayerIds, publicTimeline } = compiled;
  const stage = stageOf(state);
  const sheriff = { ...compiled.sheriff, electionAttempted: compiled.sheriff.electionAttempted || stage.kind === "SHERIFF" };
  const seats = seatsForState(state).map((seat) => ({ playerId: seat.playerId, seatNumber: seat.seatNumber, displayName: seat.displayName, controllerType: seat.controllerType, lifeState: publicDeadPlayerIds.has(seat.playerId) ? "DEAD" as const : "ALIVE" as const, isSheriff: sheriff.badgeStatus === "ACTIVE" && sheriff.holderPlayerId === seat.playerId }));
  return PublicGameViewSchema.parse({ contractVersion: "1.0.0", gameId: state.gameId, status: state.status, stage, ruleset: publicRuleset(state), seats, sheriff, currentTurn: currentTurn(state), timeline: cloneJson(publicTimeline), outcome: state.status === "ENDED" && state.runtime?.outcome !== null && state.runtime?.outcome !== undefined ? { result: state.runtime.outcome.result } : null });
}

function identityFor(state: GameState, viewerPlayerId: string): ViewerIdentity | null {
  const assignment = state.lockedSetup?.assignments.find((entry) => entry.playerId === viewerPlayerId);
  if (assignment === undefined) return null;
  const role = roleDefinition(state, assignment.assignedRoleId);
  const known = role.initialKnowledgePolicyId === "WOLF_TEAM_WITH_SPECIAL_ROLE"
    ? (state.lockedSetup?.assignments ?? []).filter((entry) => entry.playerId !== viewerPlayerId && entry.assignedFactionId === "WOLF").map((entry) => { const teammateRole = roleDefinition(state, entry.assignedRoleId); return { playerId: entry.playerId, roleId: entry.assignedRoleId, roleDisplayName: teammateRole.displayName, factionId: entry.assignedFactionId }; })
    : [];
  return { playerId: viewerPlayerId, roleId: assignment.assignedRoleId, roleDisplayName: role.displayName, factionId: assignment.assignedFactionId, victoryBucket: assignment.victoryBucket, initiallyKnownIdentities: seatSort(state, known.map((entry) => entry.playerId)).map((playerId) => known.find((entry) => entry.playerId === playerId)!) };
}

function viewerAbilityState(state: GameState, viewerPlayerId: string, identity: ViewerIdentity | null): ViewerAbilityState {
  const runtime = state.runtime;
  if (runtime === null || identity === null) return { kind: "NONE" };
  if (identity.roleId === "WITCH") { const value = ability(runtime, "WITCH"); return value?.ownerPlayerId === viewerPlayerId ? { kind: "WITCH", healRemaining: value.healRemaining, poisonRemaining: value.poisonRemaining } : { kind: "NONE" }; }
  if (identity.roleId === "GUARD") { const value = ability(runtime, "GUARD"); return value?.ownerPlayerId === viewerPlayerId ? { kind: "GUARD", lastNightNumber: value.lastNightNumber, lastTargetPlayerId: value.lastTargetPlayerId } : { kind: "NONE" }; }
  if (identity.roleId === "WOLF_BEAUTY") { const value = ability(runtime, "BEAUTY"); const active = runtime.statusEffects.find((effect) => effect.type === "CHARMED" && effect.active && effect.sourcePlayerId === viewerPlayerId) ?? null; return value?.ownerPlayerId === viewerPlayerId ? { kind: "BEAUTY", lastCharmNight: value.lastCharmNight, activeCharmTargetPlayerId: active?.targetPlayerId ?? null } : { kind: "NONE" }; }
  if (identity.roleId === "HUNTER") { const value = ability(runtime, "HUNTER"); return value?.ownerPlayerId === viewerPlayerId ? { kind: "HUNTER", shotRemaining: value.shotRemaining, reactionStatus: value.reactionStatus } : { kind: "NONE" }; }
  if (identity.roleId === "SEER") { const value = ability(runtime, "SEER"); return value?.ownerPlayerId === viewerPlayerId ? { kind: "SEER", lastActionNight: value.lastActionNight } : { kind: "NONE" }; }
  if (identity.factionId === "WOLF") { const value = ability(runtime, "WOLF_TEAM"); return { kind: "WOLF", currentNightBallotCommitted: value?.ballots.some((ballot) => ballot.voterPlayerId === viewerPlayerId) ?? false }; }
  return { kind: "NONE" };
}

function witchKnifeInfo(runtime: RuntimeState, viewerPlayerId: string) {
  const witch = ability(runtime, "WITCH"); const wolf = ability(runtime, "WOLF_TEAM");
  if (witch === null || witch.ownerPlayerId !== viewerPlayerId || witch.healRemaining === 0 || wolf === null) return { status: "UNAVAILABLE" as const, targetPlayerId: null };
  if (wolf.knifeTargetPlayerId === null) return { status: "NO_ATTACK" as const, targetPlayerId: null };
  return { status: "TARGET" as const, targetPlayerId: wolf.knifeTargetPlayerId };
}

function availableActions(state: GameState, viewerPlayerId: string, identity: ViewerIdentity | null): PlayerActionPrompt[] {
  const runtime = state.runtime;
  if (state.status !== "IN_PROGRESS" || runtime === null || runtime.phase?.status !== "OPEN") return [];
  const phase = runtime.phase; const actions: PlayerActionPrompt[] = []; const session = runtime.nightSession.currentActionSession;
  const nightEligible = session !== null && session.status === "OPEN" && session.eligibleActorsSnapshot.includes(viewerPlayerId) && !session.committedActors.includes(viewerPlayerId);
  if (nightEligible && session !== null) {
    if (phase.phaseType === "NIGHT_GUARD") actions.push({ commandType: "CommitGuardAction", windowToken: session.sessionId, legalTargetPlayerIds: cloneJson(session.legalTargetsSnapshot), allowPass: true });
    if (phase.phaseType === "NIGHT_WOLF") actions.push({ commandType: "CommitWolfBallot", windowToken: session.sessionId, legalTargetPlayerIds: cloneJson(session.legalTargetsSnapshot), allowPass: true });
    if (phase.phaseType === "NIGHT_BEAUTY") actions.push({ commandType: "CommitBeautyAction", windowToken: session.sessionId, legalTargetPlayerIds: cloneJson(session.legalTargetsSnapshot), modes: ["CHARM", "KEEP"] });
    if (phase.phaseType === "NIGHT_WITCH") { const witch = ability(runtime, "WITCH"); const info = witchKnifeInfo(runtime, viewerPlayerId); const poisonTargets = runtime.nightSession.nightStartAlivePlayerIds.filter((playerId) => playerId !== viewerPlayerId); const healTarget = witch?.healRemaining === 1 && info.status === "TARGET" ? info.targetPlayerId : null; actions.push({ commandType: "CommitWitchAction", windowToken: session.sessionId, knifeInfo: info, healRemaining: witch?.healRemaining ?? 0, poisonRemaining: witch?.poisonRemaining ?? 0, healTargetPlayerId: healTarget, poisonTargetPlayerIds: poisonTargets, allowPass: true }); }
    if (phase.phaseType === "NIGHT_SEER") actions.push({ commandType: "CommitSeerAction", windowToken: session.sessionId, legalTargetPlayerIds: cloneJson(session.legalTargetsSnapshot), allowPass: true });
  }
  const reaction = runtime.pendingReactions.find((entry) => entry.status === "OPEN" && entry.actorPlayerId === viewerPlayerId);
  if (reaction !== undefined && (phase.phaseType === "DAWN_HUNTER_REACTION" || phase.phaseType === "DAY_HUNTER_REACTION")) actions.push({ commandType: "CommitHunterReaction", windowToken: reaction.sessionId, legalTargetPlayerIds: cloneJson(reaction.legalTargetsSnapshot), allowPass: true });
  const speech = runtime.speechSession;
  if (speech !== null && speech.status === "OPEN") {
    const expectedSpeaker = speech.speakerOrderSnapshot[speech.completedSpeakers.length];
    if (expectedSpeaker === viewerPlayerId) actions.push({ commandType: "CommitSpeech", windowToken: speech.sessionId, speechKind: speech.kind, allowPass: true });
    const truthViewer = runtime.players.find((player) => player.playerId === viewerPlayerId);
    const selfExplodePhase = ["SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"].includes(phase.phaseType);
    if (selfExplodePhase && truthViewer?.lifeState === "ALIVE" && truthViewer.effectiveFactionId === "WOLF") actions.push({ commandType: "CommitSelfExplosion", windowToken: speech.sessionId });
  }
  const signup = runtime.sheriff.signupSession;
  if (phase.phaseType === "SHERIFF_SIGNUP" && signup?.status === "OPEN" && signup.eligiblePlayersSnapshot.includes(viewerPlayerId) && !signup.committedPlayerIds.includes(viewerPlayerId)) actions.push({ commandType: "CommitSheriffSignup", windowToken: signup.sessionId, choices: ["JOIN", "PASS"] });
  const withdrawal = runtime.sheriff.withdrawalSession;
  if (phase.phaseType === "SHERIFF_WITHDRAWAL" && withdrawal?.status === "OPEN" && withdrawal.candidatePlayersSnapshot.includes(viewerPlayerId) && !withdrawal.committedPlayerIds.includes(viewerPlayerId)) actions.push({ commandType: "CommitSheriffWithdrawal", windowToken: withdrawal.sessionId, choices: ["STAY", "WITHDRAW"] });
  const vote = runtime.voteSession;
  if (vote !== null && vote.status === "OPEN" && vote.eligibleVotersSnapshot.includes(viewerPlayerId) && !vote.ballots.some((ballot) => ballot.voterPlayerId === viewerPlayerId)) actions.push({ commandType: "CommitBallot", windowToken: vote.sessionId, voteKind: vote.kind, legalTargetPlayerIds: cloneJson(vote.eligibleTargetsSnapshot), allowAbstain: true });
  if (phase.phaseType === "DAY_ORDER_SELECTION" && runtime.sheriff.badgeStatus === "ACTIVE" && runtime.sheriff.holderPlayerId === viewerPlayerId) { const legal = runtime.players.filter((player) => player.lifeState === "ALIVE" && player.playerId !== viewerPlayerId).map((player) => player.playerId); actions.push({ commandType: "ChooseDaySpeechOrder", windowToken: phase.phaseId, legalFirstSpeakerPlayerIds: seatSort(state, legal), directions: ["ASC", "DESC"] }); }
  if (phase.phaseType === "SHERIFF_BADGE_ACTION" && runtime.sheriff.badgeStatus === "ACTIVE" && runtime.sheriff.holderPlayerId === viewerPlayerId) { const legal = runtime.players.filter((player) => player.lifeState === "ALIVE").map((player) => player.playerId); actions.push({ commandType: "CommitSheriffBadgeAction", windowToken: phase.phaseId, transferTargetPlayerIds: seatSort(state, legal), allowDestroy: true }); }
  void identity;
  return actions;
}

function actionSubmitted(state: GameState, viewerPlayerId: string): boolean {
  const runtime = state.runtime; if (runtime === null || runtime.phase?.status !== "OPEN") return false;
  const session = runtime.nightSession.currentActionSession; if (session !== null && session.status === "OPEN" && session.eligibleActorsSnapshot.includes(viewerPlayerId) && session.committedActors.includes(viewerPlayerId)) return true;
  const signup = runtime.sheriff.signupSession; if (signup?.status === "OPEN" && signup.eligiblePlayersSnapshot.includes(viewerPlayerId) && signup.committedPlayerIds.includes(viewerPlayerId)) return true;
  const withdrawal = runtime.sheriff.withdrawalSession; if (withdrawal?.status === "OPEN" && withdrawal.candidatePlayersSnapshot.includes(viewerPlayerId) && withdrawal.committedPlayerIds.includes(viewerPlayerId)) return true;
  const vote = runtime.voteSession; if (vote?.status === "OPEN" && vote.eligibleVotersSnapshot.includes(viewerPlayerId) && vote.ballots.some((ballot) => ballot.voterPlayerId === viewerPlayerId)) return true;
  return false;
}

function finalReveal(compiled: ProjectionCompilation): PostGameReveal | null {
  const { state, events } = compiled; if (state.status !== "ENDED" || state.lockedSetup === null) return null;
  const order = new Map(seatsForState(state).map((seat) => [seat.playerId, seat.seatNumber]));
  const assignments = state.lockedSetup.assignments.map((entry) => { const role = roleDefinition(state, entry.assignedRoleId); return { playerId: entry.playerId, roleId: entry.assignedRoleId, roleDisplayName: role.displayName, factionId: entry.assignedFactionId, victoryBucket: entry.victoryBucket }; }).sort((a, b) => (order.get(a.playerId) ?? 999) - (order.get(b.playerId) ?? 999));
  const nightActions: PostGameReveal["nightActions"] = []; const seerChecks: PostGameReveal["seerChecks"] = []; const deaths: PostGameReveal["deaths"] = [];
  for (const event of events) {
    if (event.eventType === "NightActionCommitted") {
      if (event.payload.intentType === "GUARD") nightActions.push({ type: "GUARD", nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId });
      if (event.payload.intentType === "BEAUTY") nightActions.push({ type: "BEAUTY", nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, mode: event.payload.mode, targetPlayerId: event.payload.targetPlayerId });
      if (event.payload.intentType === "WITCH") nightActions.push({ type: "WITCH", nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, action: event.payload.action, targetPlayerId: event.payload.targetPlayerId });
      if (event.payload.intentType === "SEER") nightActions.push({ type: "SEER", nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId });
    }
    if (event.eventType === "WolfBallotCommitted") nightActions.push({ type: "WOLF_BALLOT", nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId });
    if (event.eventType === "WolfTargetCommitted") nightActions.push({ type: "WOLF_TARGET", nightNumber: event.payload.nightNumber, targetPlayerId: event.payload.targetPlayerId });
    if (event.eventType === "SeerCheckResolved") seerChecks.push({ nightNumber: event.payload.nightNumber, actorPlayerId: event.payload.actorPlayerId, targetPlayerId: event.payload.targetPlayerId, result: event.payload.result });
    if (event.eventType === "DeathWaveResolved") for (const death of event.payload.deaths) deaths.push({ round: event.payload.round, playerId: death.playerId, causes: cloneJson(death.causes) });
  }
  return { assignments, nightActions, seerChecks, deaths };
}

export function projectPublicView(rawEvents: readonly unknown[]): PublicGameView { return buildPublicView(compile(rawEvents)); }

export function projectPlayerView(rawEvents: readonly unknown[], viewerPlayerId: string): PlayerView {
  if (viewerPlayerId.trim().length === 0) throw new CoreError("UNAUTHORIZED", "viewerPlayerId is required");
  const compiled = compile(rawEvents); const state = compiled.state; const seat = seatsForState(state).find((entry) => entry.playerId === viewerPlayerId);
  if (seat === undefined) throw new CoreError("UNAUTHORIZED", "Viewer is not seated in this game");
  const publicView = buildPublicView(compiled); const publicSeat = publicView.seats.find((entry) => entry.playerId === viewerPlayerId); if (publicSeat === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Viewer public seat is missing");
  const identity = identityFor(state, viewerPlayerId); const actions = availableActions(state, viewerPlayerId, identity);
  const interactionStatus = state.status === "ENDED" || state.status === "ABORTED" ? "GAME_OVER" as const : actions.length > 0 ? "ACTION_REQUIRED" as const : actionSubmitted(state, viewerPlayerId) ? "ACTION_SUBMITTED" as const : publicSeat.lifeState === "DEAD" ? "DEAD" as const : "WAITING" as const;
  return PlayerViewSchema.parse({ contractVersion: "1.0.0", public: publicView, viewer: { playerId: seat.playerId, seatNumber: seat.seatNumber, displayName: seat.displayName, controllerType: seat.controllerType, publicLifeState: publicSeat.lifeState }, identity, abilityState: viewerAbilityState(state, viewerPlayerId, identity), privateObservations: cloneJson(compiled.privateByPlayer.get(viewerPlayerId) ?? []), availableActions: actions, interactionStatus, finalReveal: finalReveal(compiled) });
}

export class PlayerViewService {
  readonly #store: DurableGameStore;
  public constructor(store: DurableGameStore) { this.#store = store; }
  public async forPlayer(gameId: string, viewerPlayerId: string): Promise<PlayerView> { if (!(await this.#store.hasGame(gameId))) throw new CoreError("GAME_NOT_FOUND", "Game not found"); return projectPlayerView(await this.#store.loadEvents(gameId), viewerPlayerId); }
  public async publicView(gameId: string): Promise<PublicGameView> { if (!(await this.#store.hasGame(gameId))) throw new CoreError("GAME_NOT_FOUND", "Game not found"); return projectPublicView(await this.#store.loadEvents(gameId)); }
}
