import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { computeVoteResult, reduceEvent, replay, tallyWolfTarget } from "../domain/reducer.js";
import {
  type AbilityState,
  type ActionSession,
  type Command,
  type CommandReceipt,
  type DomainEvent,
  type DeathCause,
  type GameManifest,
  type GameState,
  type LockedSetup,
  type PhaseType,
  type RuntimeState,
  type SpeechKind,
  type VoteKind,
  type TrustedPrincipal,
  parseCommand,
  parseTrustedPrincipal,
} from "../domain/schemas.js";
import { assertSupportedRuleset, validateSeats } from "../rulesets/wb12.js";
import { assertRulesetRegistryCompatible } from "../rulesets/registry.js";
import type { GameRepositoryPort } from "./repositoryPort.js";
import type { ClockPort, IdPort, RandomPort } from "./ports.js";

export interface GameServiceDependencies {
  repository: GameRepositoryPort;
  random: RandomPort;
  clock: ClockPort;
  ids: IdPort;
  engineBuildId: string;
}

const HOST_COMMANDS = new Set<Command["commandType"]>(["CreateGame", "ConfigureSeats", "LockGame", "AbortGame", "StartGame", "ResolveNight", "BeginDay"]);

function principalKey(principal: TrustedPrincipal): string {
  return principal.kind === "HOST" ? `HOST:${principal.hostId}` : `PLAYER:${principal.playerId}`;
}

function authorizePrincipal(principal: TrustedPrincipal, command: Command): void {
  if (HOST_COMMANDS.has(command.commandType)) {
    if (principal.kind !== "HOST" || command.actorPlayerId !== null) throw new CoreError("UNAUTHORIZED", `${command.commandType} requires HOST principal`);
    return;
  }
  if (principal.kind !== "PLAYER" || command.actorPlayerId === null || principal.playerId !== command.actorPlayerId) {
    throw new CoreError("UNAUTHORIZED", `${command.commandType} requires matching PLAYER principal`);
  }
}

function canonicalizeCommand(command: Command): Command {
  switch (command.commandType) {
    case "CreateGame": {
      const ruleset = assertSupportedRuleset(command.payload.rulesetSnapshot);
      assertRulesetRegistryCompatible(ruleset);
      return { ...cloneJson(command), payload: { rulesetSnapshot: ruleset } };
    }
    case "ConfigureSeats":
      return { ...cloneJson(command), payload: { seats: validateSeats(command.payload.seats) } };
    default:
      return cloneJson(command);
  }
}

function makeEventBase(
  deps: GameServiceDependencies,
  command: Command,
  sequence: number,
  transactionId: string,
  phaseId: string | null,
) {
  return {
    eventId: deps.ids.nextId(),
    gameId: command.gameId,
    sequence,
    eventVersion: "1.0.0" as const,
    transactionId,
    causationCommandId: command.commandId,
    causedByEventIds: [] as string[],
    phaseId,
    recordedAtIso: deps.clock.nowIso(),
    audience: { kind: "SYSTEM_TRUTH" as const },
  };
}

function shuffleRoles(roleIds: string[], random: RandomPort): string[] {
  const result = [...roleIds];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const value = random.randomInt(index + 1);
    if (!Number.isInteger(value) || value < 0 || value >= index + 1) throw new CoreError("INVALID_RANDOM_SOURCE", `RNG returned invalid value ${String(value)} for bound ${index + 1}`);
    const current = result[index];
    const replacement = result[value];
    if (current === undefined || replacement === undefined) throw new CoreError("INVALID_RANDOM_SOURCE", "Shuffle index failure");
    result[index] = replacement;
    result[value] = current;
  }
  return result;
}

function buildLockedSetup(command: Extract<Command, { commandType: "LockGame" }>, sequence: number, deps: GameServiceDependencies, state: NonNullable<ReturnType<typeof replay>>): { manifest: GameManifest; lockedSetup: LockedSetup } {
  if (state.status !== "LOBBY" || state.lobby === null) throw new CoreError("INVALID_PHASE", "LockGame requires LOBBY");
  const seats = validateSeats(state.lobby.seats);
  const ruleset = assertSupportedRuleset(state.lobby.rulesetDraft);
  assertRulesetRegistryCompatible(ruleset);
  const roleIds = ruleset.roleCounts.flatMap(({ roleId, count }) => Array.from({ length: count }, () => roleId));
  if (roleIds.length !== 12) throw new CoreError("UNSUPPORTED_RULESET", "Ruleset role count must total 12");
  const shuffled = shuffleRoles(roleIds, deps.random);
  const roleMap = new Map(ruleset.roleDefinitions.map((role) => [role.roleId, role]));
  const assignments = seats.map((seat, index) => {
    const roleId = shuffled[index];
    const role = roleId === undefined ? undefined : roleMap.get(roleId);
    if (role === undefined) throw new CoreError("UNSUPPORTED_RULESET", "Unknown role in roleCounts");
    return { playerId: seat.playerId, assignedRoleId: role.roleId, assignedFactionId: role.factionId, victoryBucket: role.victoryBucket, assignedAtSequence: sequence };
  });
  const lockedAtIso = deps.clock.nowIso();
  const manifest: GameManifest = {
    gameId: command.gameId,
    dataSchemaVersion: "1.0.0",
    engineContractVersion: "1.0.0",
    engineBuildId: deps.engineBuildId,
    createdAtIso: state.createdAtIso,
    lockedAtIso,
    seatsSnapshot: cloneJson(seats),
    rulesetSnapshot: cloneJson(ruleset),
  };
  const lockedSetup: LockedSetup = {
    assignments,
    assignmentAudit: { randomAlgorithmId: deps.random.algorithmId, privateSeed: deps.random.privateSeed },
  };
  return { manifest, lockedSetup };
}

function requireInProgress(state: GameState | null): { state: GameState; runtime: RuntimeState } {
  if (state === null) throw new CoreError("GAME_NOT_FOUND", "Game not found");
  if (state.status === "ABORTED") throw new CoreError("GAME_ABORTED", "Game is aborted");
  if (state.status !== "IN_PROGRESS" || state.runtime === null) throw new CoreError("INVALID_PHASE", "Game is not in progress");
  return { state, runtime: state.runtime };
}

function abilityState<K extends AbilityState["kind"]>(runtime: RuntimeState, kind: K): Extract<AbilityState, { kind: K }> {
  const found = runtime.abilityStates.find((entry): entry is Extract<AbilityState, { kind: K }> => entry.kind === kind);
  if (found === undefined) throw new CoreError("INVALID_PHASE", `Missing ability state ${kind}`);
  return found;
}

function requirePlayerWindow(
  state: GameState | null,
  command: Exclude<Command, { actorPlayerId: null }>,
  expectedPhase: PhaseType,
): { runtime: RuntimeState; session: ActionSession; actorPlayerId: string } {
  const { runtime } = requireInProgress(state);
  if (runtime.phase?.status !== "OPEN" || runtime.phase.phaseType !== expectedPhase) throw new CoreError("INVALID_PHASE", `Expected phase ${expectedPhase}`);
  const session = runtime.nightSession.currentActionSession;
  if (session === null || session.status !== "OPEN" || session.phaseId !== runtime.phase.phaseId) throw new CoreError("INVALID_PHASE", "No open action session");
  if (command.windowToken !== session.sessionId) throw new CoreError("INVALID_WINDOW_TOKEN", "windowToken does not match current action session");
  const actorPlayerId = command.actorPlayerId;
  if (!session.eligibleActorsSnapshot.includes(actorPlayerId)) throw new CoreError("INELIGIBLE_ACTOR", "Actor is not eligible for this action window");
  if (session.committedActors.includes(actorPlayerId)) throw new CoreError("ACTION_ALREADY_COMMITTED", "Actor already committed in this action window");
  return { runtime, session, actorPlayerId };
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

class EventBatchPlanner {
  readonly #deps: GameServiceDependencies;
  readonly #command: Command;
  readonly #transactionId: string;
  readonly #events: DomainEvent[] = [];
  #state: GameState | null;
  readonly #baseSequence: number;

  public constructor(deps: GameServiceDependencies, command: Command, state: GameState | null, expectedSequence: number) {
    this.#deps = deps;
    this.#command = command;
    this.#state = state === null ? null : cloneJson(state);
    this.#baseSequence = expectedSequence;
    this.#transactionId = deps.ids.nextId();
  }

  public get state(): GameState | null {
    return this.#state === null ? null : cloneJson(this.#state);
  }

  public get events(): DomainEvent[] {
    return cloneJson(this.#events);
  }

  public append(event: Omit<DomainEvent, keyof ReturnType<typeof makeEventBase>> & { eventType: DomainEvent["eventType"] }, phaseId: string | null, audience?: DomainEvent["audience"]): void {
    const sequence = this.#baseSequence + this.#events.length + 1;
    const raw = { ...makeEventBase(this.#deps, this.#command, sequence, this.#transactionId, phaseId), ...(audience === undefined ? {} : { audience }), ...event } as DomainEvent;
    this.#state = reduceEvent(this.#state, raw);
    this.#events.push(raw);
  }
}

function nextNightActionPhase(phaseType: Extract<PhaseType, "NIGHT_GUARD" | "NIGHT_WOLF" | "NIGHT_BEAUTY" | "NIGHT_WITCH" | "NIGHT_SEER">): Extract<PhaseType, "NIGHT_WOLF" | "NIGHT_BEAUTY" | "NIGHT_WITCH" | "NIGHT_SEER" | "NIGHT_READY_FOR_RESOLUTION"> {
  switch (phaseType) {
    case "NIGHT_GUARD": return "NIGHT_WOLF";
    case "NIGHT_WOLF": return "NIGHT_BEAUTY";
    case "NIGHT_BEAUTY": return "NIGHT_WITCH";
    case "NIGHT_WITCH": return "NIGHT_SEER";
    case "NIGHT_SEER": return "NIGHT_READY_FOR_RESOLUTION";
  }
}

function openNightPhaseFrom(planner: EventBatchPlanner, deps: GameServiceDependencies, startPhase: Extract<PhaseType, "NIGHT_GUARD" | "NIGHT_WOLF" | "NIGHT_BEAUTY" | "NIGHT_WITCH" | "NIGHT_SEER">): void {
  let phaseType = startPhase;
  while (true) {
    const stateBefore = planner.state;
    if (stateBefore?.runtime === null || stateBefore?.runtime === undefined) throw new CoreError("INVALID_PHASE", "Cannot open phase without runtime");
    const phaseId = deps.ids.nextId();
    planner.append({ eventType: "PhaseOpened", payload: { phaseId, phaseType, roundNumber: stateBefore.runtime.round, continuation: null } }, phaseId);
    const runtime = planner.state?.runtime;
    if (runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime after phase open");
    const snapshot = expectedWindow(runtime, phaseType);
    if (snapshot.actors.length > 0) {
      const sessionId = deps.ids.nextId();
      planner.append({ eventType: "ActionWindowOpened", payload: { session: { sessionId, phaseId, eligibleActorsSnapshot: snapshot.actors, legalTargetsSnapshot: snapshot.targets, committedActors: [], status: "OPEN" } } }, phaseId);
      return;
    }
    planner.append({ eventType: "PhaseClosed", payload: { phaseId } }, phaseId);
    const next = nextNightActionPhase(phaseType);
    if (next === "NIGHT_READY_FOR_RESOLUTION") {
      const readyId = deps.ids.nextId();
      planner.append({ eventType: "PhaseOpened", payload: { phaseId: readyId, phaseType: "NIGHT_READY_FOR_RESOLUTION", roundNumber: runtime.round, continuation: null } }, readyId);
      return;
    }
    phaseType = next;
  }
}

function closeCurrentAndAdvance(planner: EventBatchPlanner, deps: GameServiceDependencies, nextPhase: PhaseType): void {
  const state = planner.state;
  const runtime = state?.runtime;
  const phase = runtime?.phase;
  const session = runtime?.nightSession.currentActionSession;
  if (runtime === null || runtime === undefined || phase === null || phase === undefined || session === null || session === undefined) throw new CoreError("INVALID_PHASE", "Cannot advance without active phase/session");
  planner.append({ eventType: "ActionWindowClosed", payload: { sessionId: session.sessionId } }, phase.phaseId);
  planner.append({ eventType: "PhaseClosed", payload: { phaseId: phase.phaseId } }, phase.phaseId);
  if (nextPhase === "NIGHT_READY_FOR_RESOLUTION") {
    const phaseId = deps.ids.nextId();
    planner.append({ eventType: "PhaseOpened", payload: { phaseId, phaseType: nextPhase, roundNumber: runtime.round, continuation: null } }, phaseId);
  } else if (["NIGHT_GUARD", "NIGHT_WOLF", "NIGHT_BEAUTY", "NIGHT_WITCH", "NIGHT_SEER"].includes(nextPhase)) {
    openNightPhaseFrom(planner, deps, nextPhase as Extract<PhaseType, "NIGHT_GUARD" | "NIGHT_WOLF" | "NIGHT_BEAUTY" | "NIGHT_WITCH" | "NIGHT_SEER">);
  } else {
    throw new CoreError("INVALID_PHASE", `Invalid night advance target ${nextPhase}`);
  }
}


function openSimplePhase(planner: EventBatchPlanner, deps: GameServiceDependencies, phaseType: PhaseType, continuation: "NEXT_NIGHT" | "DAY_DISCUSSION" | "SHERIFF_ELECTION" | null = null): string {
  const runtime = planner.state?.runtime;
  if (runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Cannot open phase without runtime");
  const phaseId = deps.ids.nextId();
  planner.append({ eventType: "PhaseOpened", payload: { phaseId, phaseType, roundNumber: runtime.round, continuation } }, phaseId);
  return phaseId;
}

function closeSimplePhase(planner: EventBatchPlanner): void {
  const phase = planner.state?.runtime?.phase;
  if (phase === null || phase === undefined || phase.status !== "OPEN") throw new CoreError("INVALID_PHASE", "No open phase to close");
  planner.append({ eventType: "PhaseClosed", payload: { phaseId: phase.phaseId } }, phase.phaseId);
}

function intentOf<K extends RuntimeState["nightSession"]["intents"][number]["intentType"]>(runtime: RuntimeState, kind: K): Extract<RuntimeState["nightSession"]["intents"][number], { intentType: K }> | null {
  const found = runtime.nightSession.intents.find((intent): intent is Extract<RuntimeState["nightSession"]["intents"][number], { intentType: K }> => intent.intentType === kind);
  return found ?? null;
}

function activeCharm(runtime: RuntimeState) {
  return runtime.statusEffects.find((effect) => effect.type === "CHARMED" && effect.active) ?? null;
}

function victoryResult(state: GameState): "GOOD" | "WOLF" | "DRAW" | null {
  if (state.runtime === null || state.lockedSetup === null) return null;
  const assignmentByPlayer = new Map(state.lockedSetup.assignments.map((entry) => [entry.playerId, entry]));
  let wolves = 0;
  let gods = 0;
  let villagers = 0;
  for (const player of state.runtime.players) {
    if (player.lifeState !== "ALIVE") continue;
    const assignment = assignmentByPlayer.get(player.playerId);
    if (assignment?.victoryBucket === "WOLF") wolves += 1;
    else if (assignment?.victoryBucket === "GOD") gods += 1;
    else if (assignment?.victoryBucket === "VILLAGER") villagers += 1;
  }
  const goodWins = wolves === 0;
  const wolfWins = gods === 0 || villagers === 0;
  if (goodWins && wolfWins) return "DRAW";
  if (goodWins) return "GOOD";
  if (wolfWins) return "WOLF";
  return null;
}

function hunterReactionEligible(runtime: RuntimeState, playerId: string): { deathId: string } | null {
  const hunter = abilityState(runtime, "HUNTER");
  if (hunter.ownerPlayerId !== playerId || hunter.shotRemaining !== 1) return null;
  const death = runtime.resolutionGroup?.deathRecords.find((record) => record.playerId === playerId);
  if (death === undefined || death.causes.includes("WITCH_POISON") || death.causes.includes("WOLF_BEAUTY_LINK")) return null;
  return { deathId: death.deathId };
}

function appendDeathWaveWithBeautyClosure(
  planner: EventBatchPlanner,
  deps: GameServiceDependencies,
  resolutionGroupId: string,
  direct: Map<string, { causes: Set<DeathCause>; effectIds: Set<string> }>,
): string[] {
  const before = planner.state?.runtime;
  if (before === null || before === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime for death wave");
  const aliveAtWaveStart = new Set(before.players.filter((player) => player.lifeState === "ALIVE").map((player) => player.playerId));
  const charm = activeCharm(before);
  const beauty = abilityState(before, "BEAUTY");
  let changed = true;
  while (changed) {
    changed = false;
    if (direct.has(beauty.ownerPlayerId) && charm !== null && aliveAtWaveStart.has(charm.targetPlayerId)) {
      const entry = direct.get(charm.targetPlayerId) ?? { causes: new Set(), effectIds: new Set() };
      if (!entry.causes.has("WOLF_BEAUTY_LINK")) {
        const effectId = deps.ids.nextId();
        planner.append({ eventType: "EffectResolved", payload: { effectId, effectType: "WOLF_BEAUTY_LINK", sourcePlayerId: beauty.ownerPlayerId, targetPlayerId: charm.targetPlayerId, resolutionGroupId, outcome: "APPLIED" } }, planner.state?.runtime?.phase?.phaseId ?? null);
        entry.causes.add("WOLF_BEAUTY_LINK");
        entry.effectIds.add(effectId);
        direct.set(charm.targetPlayerId, entry);
        changed = true;
      }
    }
  }
  const deaths = [...direct.entries()].filter(([playerId]) => aliveAtWaveStart.has(playerId));
  if (deaths.length === 0) return [];
  const waveId = deps.ids.nextId();
  planner.append({ eventType: "DeathWaveResolved", payload: { resolutionGroupId, waveId, round: before.round, deaths: deaths.map(([playerId, value]) => ({ playerId, causes: [...value.causes], sourceEffectIds: [...value.effectIds] })) } }, planner.state?.runtime?.phase?.phaseId ?? null);
  return deaths.map(([playerId]) => playerId);
}

function expireDeathSensitiveCharm(planner: EventBatchPlanner): void {
  const runtime = planner.state?.runtime;
  if (runtime === null || runtime === undefined) return;
  const charm = activeCharm(runtime);
  if (charm === null) return;
  const sourceDead = runtime.players.find((p) => p.playerId === charm.sourcePlayerId)?.lifeState === "DEAD";
  const targetDead = runtime.players.find((p) => p.playerId === charm.targetPlayerId)?.lifeState === "DEAD";
  if (sourceDead || targetDead) planner.append({ eventType: "StatusExpired", payload: { statusId: charm.statusId, reason: sourceDead ? "SOURCE_DIED" : "TARGET_DIED" } }, runtime.phase?.phaseId ?? null);
}

function settleOrOpenHunter(planner: EventBatchPlanner, deps: GameServiceDependencies, commandPhaseId: string): void {
  const runtime = planner.state?.runtime;
  if (runtime === null || runtime === undefined || runtime.resolutionGroup === null) throw new CoreError("INVALID_PHASE", "Missing resolution group");
  const hunter = abilityState(runtime, "HUNTER");
  const eligible = hunterReactionEligible(runtime, hunter.ownerPlayerId);
  if (eligible !== null) {
    const legalTargets = runtime.players.filter((player) => player.lifeState === "ALIVE" && player.playerId !== hunter.ownerPlayerId).map((player) => player.playerId);
    const reactionId = deps.ids.nextId();
    const sessionId = deps.ids.nextId();
    planner.append({ eventType: "ReactionWindowOpened", payload: { reaction: { reactionId, kind: "HUNTER_SHOT", actorPlayerId: hunter.ownerPlayerId, triggerDeathId: eligible.deathId, legalTargetsSnapshot: legalTargets, sessionId, status: "OPEN" } } }, commandPhaseId);
    closeSimplePhase(planner);
    openSimplePhase(planner, deps, "DAWN_HUNTER_REACTION");
    return;
  }
  planner.append({ eventType: "ResolutionGroupSettled", payload: { resolutionGroupId: runtime.resolutionGroup.resolutionGroupId } }, commandPhaseId);
  const after = planner.state;
  if (after === null) throw new CoreError("INVALID_PHASE", "Missing state after settlement");
  const result = victoryResult(after);
  if (result !== null) {
    planner.append({ eventType: "GameEnded", payload: { result, reason: "ELIMINATE_SIDE", endedAtIso: deps.clock.nowIso() } }, commandPhaseId);
  } else {
    closeSimplePhase(planner);
    openSimplePhase(planner, deps, "DAWN_READY_FOR_DAY");
  }
}

function seatOrdered(state: GameState, playerIds: readonly string[], direction: "ASC" | "DESC" = "ASC"): string[] {
  if (state.manifest === null) throw new CoreError("INVALID_PHASE", "Missing manifest");
  const seat = new Map(state.manifest.seatsSnapshot.map((entry) => [entry.playerId, entry.seatNumber]));
  return [...playerIds].sort((a, b) => direction === "ASC" ? (seat.get(a) ?? 999) - (seat.get(b) ?? 999) : (seat.get(b) ?? -1) - (seat.get(a) ?? -1));
}

function alivePlayerIds(state: GameState): string[] {
  if (state.runtime === null) throw new CoreError("INVALID_PHASE", "Missing runtime");
  return state.runtime.players.filter((p) => p.lifeState === "ALIVE").map((p) => p.playerId);
}

function openSpeechPhase(planner: EventBatchPlanner, deps: GameServiceDependencies, phaseType: Extract<PhaseType, "LAST_WORDS" | "SHERIFF_SPEECH" | "SHERIFF_PK_SPEECH" | "DAY_DISCUSSION" | "DAY_PK_SPEECH">, kind: SpeechKind, speakers: readonly string[], continuation: "NEXT_NIGHT" | "DAY_DISCUSSION" | "SHERIFF_ELECTION" | null = null): void {
  if (speakers.length === 0) throw new CoreError("INVALID_PHASE", `Cannot open empty ${kind} speech session`);
  const phaseId = openSimplePhase(planner, deps, phaseType, continuation);
  const sessionId = deps.ids.nextId();
  planner.append({ eventType: "SpeechSessionOpened", payload: { session: { sessionId, phaseId, kind, speakerOrderSnapshot: [...speakers], completedSpeakers: [], status: "OPEN" } } }, phaseId);
}

function openSheriffSignup(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; if (state?.runtime === null || state?.runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const phaseId = openSimplePhase(planner, deps, "SHERIFF_SIGNUP", "SHERIFF_ELECTION");
  const sessionId = deps.ids.nextId();
  planner.append({ eventType: "SheriffSignupSessionOpened", payload: { session: { sessionId, eligiblePlayersSnapshot: seatOrdered(state, alivePlayerIds(state)), committedPlayerIds: [], joinedPlayerIds: [], status: "OPEN" } } }, phaseId);
}

function openSheriffWithdrawal(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const phaseId = openSimplePhase(planner, deps, "SHERIFF_WITHDRAWAL", "SHERIFF_ELECTION");
  const sessionId = deps.ids.nextId();
  planner.append({ eventType: "SheriffWithdrawalSessionOpened", payload: { session: { sessionId, candidatePlayersSnapshot: seatOrdered(state, runtime.sheriff.candidatePlayerIds), committedPlayerIds: [], withdrawnPlayerIds: [], status: "OPEN" } } }, phaseId);
}

function voteWeights(state: GameState, voters: readonly string[], sheriffElection: boolean): Record<string, number> {
  const runtime = state.runtime;
  const options = state.manifest?.rulesetSnapshot.options;
  if (runtime === null || options === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime/ruleset vote configuration");
  const result: Record<string, number> = {};
  for (const voter of voters) {
    result[voter] = sheriffElection
      ? options.ordinaryVoteUnits
      : (runtime.sheriff.badgeStatus === "ACTIVE" && runtime.sheriff.holderPlayerId === voter
          ? options.sheriffDayVoteUnits
          : options.ordinaryVoteUnits);
  }
  return result;
}

function openVotePhase(planner: EventBatchPlanner, deps: GameServiceDependencies, phaseType: Extract<PhaseType, "SHERIFF_VOTE" | "SHERIFF_PK_VOTE" | "DAY_VOTE" | "DAY_PK_VOTE">, kind: VoteKind, roundIndex: 1 | 2, voters: readonly string[], targets: readonly string[]): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const phaseId = openSimplePhase(planner, deps, phaseType, kind.startsWith("SHERIFF") ? "SHERIFF_ELECTION" : "NEXT_NIGHT");
  const sessionId = deps.ids.nextId();
  planner.append({ eventType: "VoteSessionOpened", payload: { session: { sessionId, phaseId, kind, roundIndex, eligibleVotersSnapshot: [...voters], eligibleTargetsSnapshot: [...targets], weightUnitsByVoter: voteWeights(state, voters, kind === "SHERIFF" || kind === "SHERIFF_PK"), ballots: [], status: "OPEN", result: null } } }, phaseId);
}

function openDayDiscussionFlow(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const holder = runtime.sheriff.badgeStatus === "ACTIVE" ? runtime.sheriff.holderPlayerId : null;
  if (holder !== null && runtime.players.find((p) => p.playerId === holder)?.lifeState === "ALIVE") {
    openSimplePhase(planner, deps, "DAY_ORDER_SELECTION", "DAY_DISCUSSION");
    return;
  }
  openSpeechPhase(planner, deps, "DAY_DISCUSSION", "DAY_DISCUSSION", seatOrdered(state, alivePlayerIds(state)), "DAY_DISCUSSION");
}

function firstNightLastWords(state: GameState): string[] {
  const runtime = state.runtime; if (runtime === null || runtime.resolutionGroup?.kind !== "NIGHT" || runtime.round !== 1) return [];
  const eligible = runtime.resolutionGroup.deathRecords.filter((record) => record.round === 1 && !record.causes.includes("HUNTER_SHOT") && !record.causes.includes("WOLF_BEAUTY_LINK") && !record.causes.includes("SELF_EXPLOSION")).map((record) => record.playerId);
  return seatOrdered(state, eligible);
}

function executionLastWords(state: GameState): string[] {
  const runtime = state.runtime; if (runtime === null || runtime.resolutionGroup?.kind !== "VOTE_EXECUTION") return [];
  const eligible = runtime.resolutionGroup.deathRecords.filter((record) => record.causes.includes("VOTE_EXECUTION") && !record.causes.includes("HUNTER_SHOT") && !record.causes.includes("WOLF_BEAUTY_LINK") && !record.causes.includes("SELF_EXPLOSION")).map((record) => record.playerId);
  return seatOrdered(state, eligible);
}

function sheriffNeedsBadgeAction(runtime: RuntimeState): boolean {
  if (runtime.sheriff.badgeStatus !== "ACTIVE" || runtime.sheriff.holderPlayerId === null) return false;
  return runtime.players.find((p) => p.playerId === runtime.sheriff.holderPlayerId)?.lifeState === "DEAD";
}

function openBadgeAction(planner: EventBatchPlanner, deps: GameServiceDependencies, continuation: "NEXT_NIGHT" | "DAY_DISCUSSION"): void {
  openSimplePhase(planner, deps, "SHERIFF_BADGE_ACTION", continuation);
}

function startNextNight(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  if (runtime.phase?.status === "OPEN") closeSimplePhase(planner);
  const afterClose = planner.state; if (afterClose?.runtime === null || afterClose?.runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime after phase close");
  const nextNight = afterClose.runtime.round + 1;
  const alive = afterClose.runtime.players.filter((p) => p.lifeState === "ALIVE").map((p) => p.playerId);
  planner.append({ eventType: "NightStarted", payload: { nightNumber: nextNight, alivePlayerIds: alive } }, afterClose.runtime.phase?.phaseId ?? null, { kind: "PUBLIC" });
  openNightPhaseFrom(planner, deps, "NIGHT_GUARD");
}

function postDayResolution(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined || runtime.resolutionGroup === null || runtime.resolutionGroup.status !== "SETTLED") throw new CoreError("INVALID_PHASE", "Day resolution not settled");
  const result = victoryResult(state);
  const phaseId = runtime.phase?.phaseId ?? null;
  if (result !== null) { planner.append({ eventType: "GameEnded", payload: { result, reason: "ELIMINATE_SIDE", endedAtIso: deps.clock.nowIso() } }, phaseId); return; }
  if (runtime.resolutionGroup.kind === "VOTE_EXECUTION") {
    const words = executionLastWords(state);
    if (words.length > 0) { if (runtime.phase?.status === "OPEN") closeSimplePhase(planner); openSpeechPhase(planner, deps, "LAST_WORDS", "LAST_WORDS", words, "NEXT_NIGHT"); return; }
  }
  if (sheriffNeedsBadgeAction(runtime)) { if (runtime.phase?.status === "OPEN") closeSimplePhase(planner); openBadgeAction(planner, deps, "NEXT_NIGHT"); return; }
  startNextNight(planner, deps);
}

function settleOrOpenDayHunter(planner: EventBatchPlanner, deps: GameServiceDependencies, commandPhaseId: string): void {
  const runtime = planner.state?.runtime; if (runtime === null || runtime === undefined || runtime.resolutionGroup === null) throw new CoreError("INVALID_PHASE", "Missing day resolution group");
  const hunter = abilityState(runtime, "HUNTER"); const eligible = hunterReactionEligible(runtime, hunter.ownerPlayerId);
  if (eligible !== null) {
    const legalTargets = runtime.players.filter((p) => p.lifeState === "ALIVE" && p.playerId !== hunter.ownerPlayerId).map((p) => p.playerId);
    const reactionId = deps.ids.nextId(); const sessionId = deps.ids.nextId();
    planner.append({ eventType: "ReactionWindowOpened", payload: { reaction: { reactionId, kind: "HUNTER_SHOT", actorPlayerId: hunter.ownerPlayerId, triggerDeathId: eligible.deathId, legalTargetsSnapshot: legalTargets, sessionId, status: "OPEN" } } }, commandPhaseId);
    closeSimplePhase(planner); openSimplePhase(planner, deps, "DAY_HUNTER_REACTION", "NEXT_NIGHT"); return;
  }
  planner.append({ eventType: "ResolutionGroupSettled", payload: { resolutionGroupId: runtime.resolutionGroup.resolutionGroupId } }, commandPhaseId);
  postDayResolution(planner, deps);
}

function beginDayDeathResolution(planner: EventBatchPlanner, deps: GameServiceDependencies, kind: "VOTE_EXECUTION" | "SELF_EXPLOSION", targetPlayerId: string): void {
  const runtime = planner.state?.runtime; if (runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const phaseId = openSimplePhase(planner, deps, "DAY_RESOLUTION", "NEXT_NIGHT");
  const resolutionGroupId = deps.ids.nextId();
  planner.append({ eventType: "ResolutionGroupOpened", payload: { resolutionGroupId, kind, round: runtime.round } }, phaseId);
  const effectId = deps.ids.nextId();
  planner.append({ eventType: "EffectResolved", payload: { effectId, effectType: kind, sourcePlayerId: kind === "SELF_EXPLOSION" ? targetPlayerId : null, targetPlayerId, resolutionGroupId, outcome: "APPLIED" } }, phaseId);
  const direct = new Map<string, { causes: Set<DeathCause>; effectIds: Set<string> }>();
  direct.set(targetPlayerId, { causes: new Set([kind]), effectIds: new Set([effectId]) });
  appendDeathWaveWithBeautyClosure(planner, deps, resolutionGroupId, direct); expireDeathSensitiveCharm(planner); settleOrOpenDayHunter(planner, deps, phaseId);
}

function resolveSheriffElectionAfterCandidates(planner: EventBatchPlanner, deps: GameServiceDependencies): void {
  const state = planner.state; const runtime = state?.runtime; if (state === null || runtime === null || runtime === undefined) throw new CoreError("INVALID_PHASE", "Missing runtime");
  const candidates = seatOrdered(state, runtime.sheriff.candidatePlayerIds.filter((id) => runtime.players.find((p) => p.playerId === id)?.lifeState === "ALIVE"));
  if (candidates.length === 0) { planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "NO_CANDIDATE" } }, runtime.phase?.phaseId ?? null, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, deps); return; }
  if (candidates.length === 1) { planner.append({ eventType: "SheriffElected", payload: { playerId: candidates[0]! } }, runtime.phase?.phaseId ?? null, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, deps); return; }
  const voters = runtime.sheriff.originalVoterPlayerIds.filter((id) => runtime.players.find((p) => p.playerId === id)?.lifeState === "ALIVE");
  if (voters.length === 0) { planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "NO_VOTER" } }, runtime.phase?.phaseId ?? null, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, deps); return; }
  closeSimplePhase(planner); openVotePhase(planner, deps, "SHERIFF_VOTE", "SHERIFF", 1, voters, candidates);
}

export class GameService {
  readonly #deps: GameServiceDependencies;
  public constructor(deps: GameServiceDependencies) {
    this.#deps = deps;
  }

  handle(rawPrincipal: unknown, rawCommand: unknown): CommandReceipt {
    const principal = parseTrustedPrincipal(rawPrincipal);
    const command = canonicalizeCommand(parseCommand(rawCommand));
    const pKey = principalKey(principal);
    const canonicalRequest = cloneJson(command);

    const existingReceipt = this.#deps.repository.findReceiptByCommandId(command.commandId);
    if (existingReceipt !== null) {
      if (existingReceipt.principalKey !== pKey || stableStringify(existingReceipt.canonicalRequest) !== stableStringify(canonicalRequest)) {
        throw new CoreError("COMMAND_ID_REUSED", "commandId was already used with different request or principal");
      }
      authorizePrincipal(principal, command);
      return cloneJson(existingReceipt);
    }

    authorizePrincipal(principal, command);
    const state = this.#deps.repository.loadState(command.gameId);
    const expectedSequence = state?.lastSequence ?? 0;
    const planner = new EventBatchPlanner(this.#deps, command, state, expectedSequence);
    let outcomeCode: CommandReceipt["outcomeCode"];

    switch (command.commandType) {
      case "CreateGame": {
        if (state !== null || this.#deps.repository.hasGame(command.gameId)) throw new CoreError("GAME_ALREADY_EXISTS", "gameId already exists");
        const ruleset = assertSupportedRuleset(command.payload.rulesetSnapshot);
        assertRulesetRegistryCompatible(ruleset);
        planner.append({ eventType: "GameCreated", payload: { createdAtIso: this.#deps.clock.nowIso(), rulesetDraft: ruleset } }, null);
        outcomeCode = "GAME_CREATED";
        break;
      }
      case "ConfigureSeats": {
        if (state === null) throw new CoreError("GAME_NOT_FOUND", "Game not found");
        if (state.status === "ABORTED") throw new CoreError("GAME_ABORTED", "Game is aborted");
        if (state.status !== "LOBBY") throw new CoreError("GAME_ALREADY_LOCKED", "Game is already locked or started");
        planner.append({ eventType: "SeatsConfigured", payload: { seats: validateSeats(command.payload.seats) } }, null);
        outcomeCode = "SEATS_CONFIGURED";
        break;
      }
      case "LockGame": {
        if (state === null) throw new CoreError("GAME_NOT_FOUND", "Game not found");
        if (state.status === "ABORTED") throw new CoreError("GAME_ABORTED", "Game is aborted");
        if (state.status !== "LOBBY") throw new CoreError("GAME_ALREADY_LOCKED", "Game is already locked or started");
        if (state.lobby === null || state.lobby.seats.length !== 12) throw new CoreError("INVALID_SEATS", "Configure 12 seats before LockGame");
        const sequence = expectedSequence + 1;
        const payload = buildLockedSetup(command, sequence, this.#deps, state);
        planner.append({ eventType: "SetupLocked", payload }, null);
        outcomeCode = "SETUP_LOCKED";
        break;
      }
      case "StartGame": {
        if (state === null) throw new CoreError("GAME_NOT_FOUND", "Game not found");
        if (state.status === "ABORTED") throw new CoreError("GAME_ABORTED", "Game is aborted");
        if (state.status === "IN_PROGRESS" || state.status === "ENDED") throw new CoreError("GAME_ALREADY_STARTED", "Game already started");
        if (state.status !== "LOCKED") throw new CoreError("GAME_NOT_LOCKED", "StartGame requires LOCKED game");
        planner.append({ eventType: "GameStarted", payload: { startedAtIso: this.#deps.clock.nowIso() } }, null);
        openNightPhaseFrom(planner, this.#deps, "NIGHT_GUARD");
        outcomeCode = "GAME_STARTED";
        break;
      }
      case "CommitGuardAction": {
        const { runtime, session, actorPlayerId } = requirePlayerWindow(state, command, "NIGHT_GUARD");
        if (runtime.players.find((player) => player.playerId === actorPlayerId)?.effectiveRoleId !== "GUARD") throw new CoreError("INELIGIBLE_ACTOR", "Only guard may commit guard action");
        if (command.payload.targetPlayerId !== null && !session.legalTargetsSnapshot.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal guard target");
        const guard = abilityState(runtime, "GUARD");
        if (command.payload.targetPlayerId !== null && guard.lastNightNumber === runtime.nightSession.nightNumber - 1 && guard.lastTargetPlayerId === command.payload.targetPlayerId) {
          throw new CoreError("INVALID_TARGET", "Guard cannot protect the same target on consecutive nights");
        }
        planner.append({ eventType: "NightActionCommitted", payload: { intentType: "GUARD", actorPlayerId, targetPlayerId: command.payload.targetPlayerId, nightNumber: runtime.nightSession.nightNumber } }, runtime.phase?.phaseId ?? null);
        closeCurrentAndAdvance(planner, this.#deps, "NIGHT_WOLF");
        outcomeCode = "GUARD_ACTION_COMMITTED";
        break;
      }
      case "CommitWolfBallot": {
        const { runtime, session, actorPlayerId } = requirePlayerWindow(state, command, "NIGHT_WOLF");
        if (runtime.players.find((player) => player.playerId === actorPlayerId)?.effectiveFactionId !== "WOLF") throw new CoreError("INELIGIBLE_ACTOR", "Only eligible wolf may submit knife ballot");
        if (command.payload.targetPlayerId !== null && !session.legalTargetsSnapshot.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal wolf ballot target");
        const phaseId = runtime.phase?.phaseId ?? null;
        planner.append({ eventType: "WolfBallotCommitted", payload: { actorPlayerId, targetPlayerId: command.payload.targetPlayerId, nightNumber: runtime.nightSession.nightNumber } }, phaseId);
        const afterBallot = planner.state?.runtime;
        const afterSession = afterBallot?.nightSession.currentActionSession;
        if (afterBallot === null || afterBallot === undefined || afterSession === null || afterSession === undefined) throw new CoreError("INVALID_PHASE", "Wolf ballot did not preserve session");
        if (afterSession.committedActors.length === afterSession.eligibleActorsSnapshot.length) {
          const team = abilityState(afterBallot, "WOLF_TEAM");
          const targetPlayerId = tallyWolfTarget(team.ballots);
          planner.append({ eventType: "WolfTargetCommitted", payload: { targetPlayerId, nightNumber: afterBallot.nightSession.nightNumber } }, phaseId);
          closeCurrentAndAdvance(planner, this.#deps, "NIGHT_BEAUTY");
        }
        outcomeCode = "WOLF_BALLOT_COMMITTED";
        break;
      }
      case "CommitBeautyAction": {
        const { runtime, session, actorPlayerId } = requirePlayerWindow(state, command, "NIGHT_BEAUTY");
        if (runtime.players.find((player) => player.playerId === actorPlayerId)?.effectiveRoleId !== "WOLF_BEAUTY") throw new CoreError("INELIGIBLE_ACTOR", "Only wolf beauty may commit charm action");
        if (command.payload.mode === "CHARM") {
          if (command.payload.targetPlayerId === actorPlayerId || !session.legalTargetsSnapshot.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal charm target");
        }
        planner.append({ eventType: "NightActionCommitted", payload: { intentType: "BEAUTY", actorPlayerId, mode: command.payload.mode, targetPlayerId: command.payload.targetPlayerId, nightNumber: runtime.nightSession.nightNumber } }, runtime.phase?.phaseId ?? null);
        closeCurrentAndAdvance(planner, this.#deps, "NIGHT_WITCH");
        outcomeCode = "BEAUTY_ACTION_COMMITTED";
        break;
      }
      case "CommitWitchAction": {
        const { runtime, actorPlayerId } = requirePlayerWindow(state, command, "NIGHT_WITCH");
        if (runtime.players.find((player) => player.playerId === actorPlayerId)?.effectiveRoleId !== "WITCH") throw new CoreError("INELIGIBLE_ACTOR", "Only witch may commit witch action");
        const witch = abilityState(runtime, "WITCH");
        const wolfTeam = abilityState(runtime, "WOLF_TEAM");
        if (wolfTeam.knifeTargetStatus !== "LOCKED") throw new CoreError("INVALID_PHASE", "Wolf target must be locked before witch action");
        if (command.payload.action === "HEAL") {
          if (witch.healRemaining !== 1) throw new CoreError("ABILITY_RESOURCE_UNAVAILABLE", "Witch heal is already spent");
          if (wolfTeam.knifeTargetPlayerId === null || command.payload.targetPlayerId !== wolfTeam.knifeTargetPlayerId) throw new CoreError("INVALID_TARGET", "Heal may target only actual wolf knife target");
          if (runtime.nightSession.nightNumber > 1 && command.payload.targetPlayerId === actorPlayerId) throw new CoreError("INVALID_TARGET", "Witch may self-heal only on first night");
        }
        if (command.payload.action === "POISON") {
          if (witch.poisonRemaining !== 1) throw new CoreError("ABILITY_RESOURCE_UNAVAILABLE", "Witch poison is already spent");
          if (command.payload.targetPlayerId === actorPlayerId || !runtime.nightSession.nightStartAlivePlayerIds.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Witch poison must target another night-start alive player");
        }
        const phaseId = runtime.phase?.phaseId ?? null;
        planner.append({ eventType: "NightActionCommitted", payload: { intentType: "WITCH", actorPlayerId, action: command.payload.action, targetPlayerId: command.payload.targetPlayerId, nightNumber: runtime.nightSession.nightNumber } }, phaseId);
        if (command.payload.action === "HEAL") {
          planner.append({ eventType: "AbilityResourceSpent", payload: { actorPlayerId, abilityId: "WITCH_HEAL", resource: "HEAL", remaining: 0, nightNumber: runtime.nightSession.nightNumber } }, phaseId);
        } else if (command.payload.action === "POISON") {
          planner.append({ eventType: "AbilityResourceSpent", payload: { actorPlayerId, abilityId: "WITCH_POISON", resource: "POISON", remaining: 0, nightNumber: runtime.nightSession.nightNumber } }, phaseId);
        }
        closeCurrentAndAdvance(planner, this.#deps, "NIGHT_SEER");
        outcomeCode = "WITCH_ACTION_COMMITTED";
        break;
      }
      case "CommitSeerAction": {
        const { runtime, session, actorPlayerId } = requirePlayerWindow(state, command, "NIGHT_SEER");
        if (runtime.players.find((player) => player.playerId === actorPlayerId)?.effectiveRoleId !== "SEER") throw new CoreError("INELIGIBLE_ACTOR", "Only seer may commit seer action");
        if (command.payload.targetPlayerId !== null && (command.payload.targetPlayerId === actorPlayerId || !session.legalTargetsSnapshot.includes(command.payload.targetPlayerId))) throw new CoreError("INVALID_TARGET", "Illegal seer target");
        planner.append({ eventType: "NightActionCommitted", payload: { intentType: "SEER", actorPlayerId, targetPlayerId: command.payload.targetPlayerId, nightNumber: runtime.nightSession.nightNumber } }, runtime.phase?.phaseId ?? null);
        closeCurrentAndAdvance(planner, this.#deps, "NIGHT_READY_FOR_RESOLUTION");
        outcomeCode = "SEER_ACTION_COMMITTED";
        break;
      }
      case "ResolveNight": {
        const { runtime } = requireInProgress(state);
        if (runtime.phase?.phaseType !== "NIGHT_READY_FOR_RESOLUTION" || runtime.phase.status !== "OPEN" || runtime.nightSession.status !== "READY_FOR_RESOLUTION") throw new CoreError("INVALID_PHASE", "ResolveNight requires ready-for-resolution phase");
        closeSimplePhase(planner);
        const phaseId = openSimplePhase(planner, this.#deps, "NIGHT_RESOLUTION");
        const current = planner.state?.runtime;
        if (current === null || current === undefined || current.resolutionGroup === null) throw new CoreError("INVALID_PHASE", "Resolution group not initialized");
        const resolutionGroupId = current.resolutionGroup.resolutionGroupId;

        const guardIntent = intentOf(current, "GUARD");
        if (guardIntent?.targetPlayerId !== null && guardIntent?.targetPlayerId !== undefined) {
          const statusId = this.#deps.ids.nextId();
          planner.append({ eventType: "StatusApplied", payload: { status: { statusId, type: "PROTECTED", sourcePlayerId: guardIntent.actorPlayerId, targetPlayerId: guardIntent.targetPlayerId, appliedAtSequence: (planner.state?.lastSequence ?? 0) + 1, scope: "NIGHT", expirationPolicy: "AT_NIGHT_END", active: true } } }, phaseId);
        }

        const beautyIntent = intentOf(planner.state?.runtime as RuntimeState, "BEAUTY");
        if (beautyIntent?.mode === "CHARM" && beautyIntent.targetPlayerId !== null) {
          const oldCharm = activeCharm(planner.state?.runtime as RuntimeState);
          if (oldCharm !== null) planner.append({ eventType: "StatusExpired", payload: { statusId: oldCharm.statusId, reason: "REPLACED" } }, phaseId);
          const statusId = this.#deps.ids.nextId();
          planner.append({ eventType: "StatusApplied", payload: { status: { statusId, type: "CHARMED", sourcePlayerId: beautyIntent.actorPlayerId, targetPlayerId: beautyIntent.targetPlayerId, appliedAtSequence: (planner.state?.lastSequence ?? 0) + 1, scope: "PERSISTENT", expirationPolicy: "UNTIL_REPLACED", active: true } } }, phaseId);
        }

        const seerIntent = intentOf(planner.state?.runtime as RuntimeState, "SEER");
        if (seerIntent?.targetPlayerId !== null && seerIntent?.targetPlayerId !== undefined) {
          const target = (planner.state?.runtime as RuntimeState).players.find((p) => p.playerId === seerIntent.targetPlayerId);
          if (target === undefined) throw new CoreError("INVALID_TARGET", "Missing seer target");
          const result = target.effectiveFactionId === "WOLF" ? "WOLF" as const : "GOOD" as const;
          planner.append({ eventType: "SeerCheckResolved", payload: { actorPlayerId: seerIntent.actorPlayerId, targetPlayerId: seerIntent.targetPlayerId, result, nightNumber: current.nightSession.nightNumber } }, phaseId);
          planner.append({ eventType: "PrivateObservationPublished", payload: { recipientPlayerIds: [seerIntent.actorPlayerId], observationType: "SEER_CHECK", data: { targetPlayerId: seerIntent.targetPlayerId, result } } }, phaseId, { kind: "PRIVATE_RECIPIENTS", playerIds: [seerIntent.actorPlayerId] });
        }

        const resolvedRuntime = planner.state?.runtime as RuntimeState;
        const wolfTeam = abilityState(resolvedRuntime, "WOLF_TEAM");
        const witchIntent = intentOf(resolvedRuntime, "WITCH");
        const protectedTarget = resolvedRuntime.statusEffects.find((effect) => effect.type === "PROTECTED" && effect.active)?.targetPlayerId ?? null;
        const direct = new Map<string, { causes: Set<DeathCause>; effectIds: Set<string> }>();
        const add = (playerId: string, cause: "WEREWOLF_ATTACK" | "WITCH_POISON" | "HUNTER_SHOT" | "WOLF_BEAUTY_LINK" | "GUARD_HEAL_COLLISION", effectId: string) => {
          const entry = direct.get(playerId) ?? { causes: new Set(), effectIds: new Set() };
          entry.causes.add(cause); entry.effectIds.add(effectId); direct.set(playerId, entry);
        };
        const knife = wolfTeam.knifeTargetPlayerId;
        if (knife !== null) {
          const attackEffectId = this.#deps.ids.nextId();
          const healed = witchIntent?.intentType === "WITCH" && witchIntent.action === "HEAL" && witchIntent.targetPlayerId === knife;
          const guarded = protectedTarget === knife;
          if (guarded && healed) {
            planner.append({ eventType: "EffectResolved", payload: { effectId: attackEffectId, effectType: "WOLF_ATTACK", sourcePlayerId: null, targetPlayerId: knife, resolutionGroupId, outcome: "APPLIED" } }, phaseId);
            const collisionId = this.#deps.ids.nextId();
            planner.append({ eventType: "EffectResolved", payload: { effectId: collisionId, effectType: "GUARD_HEAL_COLLISION", sourcePlayerId: null, targetPlayerId: knife, resolutionGroupId, outcome: "APPLIED" } }, phaseId);
            add(knife, "WEREWOLF_ATTACK", attackEffectId); add(knife, "GUARD_HEAL_COLLISION", collisionId);
          } else if (guarded || healed) {
            planner.append({ eventType: "EffectResolved", payload: { effectId: attackEffectId, effectType: "WOLF_ATTACK", sourcePlayerId: null, targetPlayerId: knife, resolutionGroupId, outcome: "PREVENTED" } }, phaseId);
          } else {
            planner.append({ eventType: "EffectResolved", payload: { effectId: attackEffectId, effectType: "WOLF_ATTACK", sourcePlayerId: null, targetPlayerId: knife, resolutionGroupId, outcome: "APPLIED" } }, phaseId);
            add(knife, "WEREWOLF_ATTACK", attackEffectId);
          }
        }
        if (witchIntent?.intentType === "WITCH" && witchIntent.action === "POISON" && witchIntent.targetPlayerId !== null) {
          const effectId = this.#deps.ids.nextId();
          planner.append({ eventType: "EffectResolved", payload: { effectId, effectType: "WITCH_POISON", sourcePlayerId: witchIntent.actorPlayerId, targetPlayerId: witchIntent.targetPlayerId, resolutionGroupId, outcome: "APPLIED" } }, phaseId);
          add(witchIntent.targetPlayerId, "WITCH_POISON", effectId);
        }
        appendDeathWaveWithBeautyClosure(planner, this.#deps, resolutionGroupId, direct);
        expireDeathSensitiveCharm(planner);
        const protectedEffect = (planner.state?.runtime as RuntimeState).statusEffects.find((effect) => effect.type === "PROTECTED" && effect.active);
        if (protectedEffect !== undefined) planner.append({ eventType: "StatusExpired", payload: { statusId: protectedEffect.statusId, reason: "NIGHT_ENDED" } }, phaseId);
        const deadPlayerIds = (planner.state?.runtime as RuntimeState).resolutionGroup?.deathRecords.map((record) => record.playerId).sort() ?? [];
        planner.append({ eventType: "DawnAnnouncementPublished", payload: { round: current.round, deadPlayerIds } }, phaseId, { kind: "PUBLIC" });
        settleOrOpenHunter(planner, this.#deps, phaseId);
        outcomeCode = "NIGHT_RESOLVED";
        break;
      }
      case "CommitHunterReaction": {
        const { runtime } = requireInProgress(state);
        if (runtime.phase === null || !["DAWN_HUNTER_REACTION", "DAY_HUNTER_REACTION"].includes(runtime.phase.phaseType) || runtime.phase.status !== "OPEN") throw new CoreError("INVALID_PHASE", "Hunter reaction is not open");
        const reactionPhaseType = runtime.phase.phaseType;
        const reaction = runtime.pendingReactions.find((entry) => entry.status === "OPEN");
        if (reaction === undefined || command.actorPlayerId !== reaction.actorPlayerId || command.windowToken !== reaction.sessionId) throw new CoreError("INVALID_WINDOW_TOKEN", "Hunter reaction token/actor mismatch");
        if (command.payload.action === "SHOOT" && !reaction.legalTargetsSnapshot.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal hunter target");
        const phaseId = runtime.phase.phaseId;
        planner.append({ eventType: "ReactionCommitted", payload: { reactionId: reaction.reactionId, actorPlayerId: reaction.actorPlayerId, action: command.payload.action, targetPlayerId: command.payload.targetPlayerId } }, phaseId);
        if (command.payload.action === "SHOOT") {
          const current = planner.state?.runtime;
          if (current === null || current === undefined || current.resolutionGroup === null) throw new CoreError("INVALID_PHASE", "Missing resolution group");
          const effectId = this.#deps.ids.nextId();
          planner.append({ eventType: "EffectResolved", payload: { effectId, effectType: "HUNTER_SHOT", sourcePlayerId: reaction.actorPlayerId, targetPlayerId: command.payload.targetPlayerId, resolutionGroupId: current.resolutionGroup.resolutionGroupId, outcome: "APPLIED" } }, phaseId);
          const direct = new Map<string, { causes: Set<DeathCause>; effectIds: Set<string> }>();
          direct.set(command.payload.targetPlayerId, { causes: new Set(["HUNTER_SHOT"]), effectIds: new Set([effectId]) });
          appendDeathWaveWithBeautyClosure(planner, this.#deps, current.resolutionGroup.resolutionGroupId, direct);
          expireDeathSensitiveCharm(planner);
        }
        planner.append({ eventType: "ReactionClosed", payload: { reactionId: reaction.reactionId } }, phaseId);
        const afterReaction = planner.state?.runtime;
        if (afterReaction === null || afterReaction === undefined || afterReaction.resolutionGroup === null) throw new CoreError("INVALID_PHASE", "Missing resolution group after hunter reaction");
        planner.append({ eventType: "ResolutionGroupSettled", payload: { resolutionGroupId: afterReaction.resolutionGroup.resolutionGroupId } }, phaseId);
        const after = planner.state;
        if (after === null) throw new CoreError("INVALID_PHASE", "Missing state after settlement");
        if (reactionPhaseType === "DAWN_HUNTER_REACTION") {
          const result = victoryResult(after);
          if (result !== null) planner.append({ eventType: "GameEnded", payload: { result, reason: "ELIMINATE_SIDE", endedAtIso: this.#deps.clock.nowIso() } }, phaseId);
          else { closeSimplePhase(planner); openSimplePhase(planner, this.#deps, "DAWN_READY_FOR_DAY"); }
        } else {
          postDayResolution(planner, this.#deps);
        }
        outcomeCode = "HUNTER_REACTION_COMMITTED";
        break;
      }
      case "BeginDay": {
        const { state: currentState, runtime } = requireInProgress(state);
        if (runtime.phase?.phaseType !== "DAWN_READY_FOR_DAY" || runtime.phase.status !== "OPEN" || runtime.resolutionGroup?.status !== "SETTLED") throw new CoreError("INVALID_PHASE", "BeginDay requires settled dawn state");
        closeSimplePhase(planner);
        const words = firstNightLastWords(currentState);
        if (words.length > 0) openSpeechPhase(planner, this.#deps, "LAST_WORDS", "LAST_WORDS", words, "SHERIFF_ELECTION");
        else if (sheriffNeedsBadgeAction(runtime)) openBadgeAction(planner, this.#deps, "DAY_DISCUSSION");
        else if (runtime.round === 1 && runtime.sheriff.enabled && !runtime.sheriff.electionAttempted) openSheriffSignup(planner, this.#deps);
        else openDayDiscussionFlow(planner, this.#deps);
        outcomeCode = "DAY_BEGUN";
        break;
      }
      case "CommitSpeech": {
        const { runtime } = requireInProgress(state); const session = runtime.speechSession;
        if (runtime.phase === null || runtime.phase.status !== "OPEN" || session === null || session.status !== "OPEN" || command.windowToken !== session.sessionId) throw new CoreError("INVALID_WINDOW_TOKEN", "Speech window is not open");
        const expectedSpeaker = session.speakerOrderSnapshot[session.completedSpeakers.length];
        if (expectedSpeaker !== command.actorPlayerId) throw new CoreError("INELIGIBLE_ACTOR", "It is not this player's speech turn");
        const actor = runtime.players.find((p) => p.playerId === command.actorPlayerId);
        if (actor === undefined || (session.kind !== "LAST_WORDS" && actor.lifeState !== "ALIVE")) throw new CoreError("INELIGIBLE_ACTOR", "Speaker is not eligible");
        const phaseId = runtime.phase.phaseId;
        if (command.payload.mode === "SPEAK") planner.append({ eventType: "SpeechPublished", payload: { speakerPlayerId: command.actorPlayerId, sessionId: session.sessionId, text: command.payload.text, source: command.payload.source, publishedAtSequence: (planner.state?.lastSequence ?? 0) + 1 } }, phaseId, { kind: "PUBLIC" });
        planner.append({ eventType: "SpeechFinished", payload: { speakerPlayerId: command.actorPlayerId, sessionId: session.sessionId } }, phaseId, { kind: "PUBLIC" });
        const afterSpeech = planner.state; const afterRuntime = afterSpeech?.runtime; const afterSession = afterRuntime?.speechSession;
        if (afterSpeech === null || afterRuntime === null || afterRuntime === undefined || afterSession == null) throw new CoreError("INVALID_PHASE", "Missing speech state");
        if (afterSession.status === "CLOSED") {
          const kind = afterSession.kind;
          closeSimplePhase(planner);
          if (kind === "LAST_WORDS") {
            const post = planner.state; const postRuntime = post?.runtime; if (post === null || postRuntime === null || postRuntime === undefined) throw new CoreError("INVALID_PHASE", "Missing post-last-words state");
            if (postRuntime.resolutionGroup?.kind === "NIGHT" && postRuntime.round === 1 && postRuntime.sheriff.enabled && !postRuntime.sheriff.electionAttempted) openSheriffSignup(planner, this.#deps);
            else if (sheriffNeedsBadgeAction(postRuntime)) openBadgeAction(planner, this.#deps, "NEXT_NIGHT");
            else startNextNight(planner, this.#deps);
          } else if (kind === "SHERIFF_SPEECH") {
            openSheriffWithdrawal(planner, this.#deps);
          } else if (kind === "SHERIFF_PK_SPEECH") {
            const post = planner.state; const postRuntime = post?.runtime; const tied = postRuntime?.voteSession?.result?.tiedPlayerIds ?? [];
            if (post === null || postRuntime === null || postRuntime === undefined || tied.length < 2) throw new CoreError("INVALID_PHASE", "Missing sheriff PK targets");
            const voters = postRuntime.sheriff.originalVoterPlayerIds.filter((id) => postRuntime.players.find((p) => p.playerId === id)?.lifeState === "ALIVE");
            if (voters.length === 0) { planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "NO_VOTER" } }, postRuntime.phase?.phaseId ?? null, { kind: "PUBLIC" }); openDayDiscussionFlow(planner, this.#deps); }
            else openVotePhase(planner, this.#deps, "SHERIFF_PK_VOTE", "SHERIFF_PK", 2, voters, tied);
          } else if (kind === "DAY_DISCUSSION") {
            const post = planner.state; const postRuntime = post?.runtime; if (post === null || postRuntime === null || postRuntime === undefined) throw new CoreError("INVALID_PHASE", "Missing day state");
            const alive = seatOrdered(post, alivePlayerIds(post)); openVotePhase(planner, this.#deps, "DAY_VOTE", "DAY", 1, alive, alive);
          } else if (kind === "DAY_PK_SPEECH") {
            const post = planner.state; const postRuntime = post?.runtime; const tied = postRuntime?.voteSession?.result?.tiedPlayerIds ?? [];
            if (post === null || postRuntime === null || postRuntime === undefined || tied.length < 2) throw new CoreError("INVALID_PHASE", "Missing day PK targets");
            const voters = seatOrdered(post, alivePlayerIds(post).filter((id) => !tied.includes(id)));
            if (voters.length === 0) startNextNight(planner, this.#deps); else openVotePhase(planner, this.#deps, "DAY_PK_VOTE", "DAY_PK", 2, voters, tied);
          }
        }
        outcomeCode = "SPEECH_COMMITTED";
        break;
      }
      case "CommitSheriffSignup": {
        const { state: currentState, runtime } = requireInProgress(state); const session = runtime.sheriff.signupSession;
        if (runtime.phase?.phaseType !== "SHERIFF_SIGNUP" || runtime.phase.status !== "OPEN" || session === null || session.status !== "OPEN" || command.windowToken !== session.sessionId || !session.eligiblePlayersSnapshot.includes(command.actorPlayerId) || session.committedPlayerIds.includes(command.actorPlayerId)) throw new CoreError("INVALID_WINDOW_TOKEN", "Sheriff signup window mismatch");
        if (runtime.players.find((p) => p.playerId === command.actorPlayerId)?.lifeState !== "ALIVE") throw new CoreError("INELIGIBLE_ACTOR", "Dead player cannot sign up");
        const phaseId = runtime.phase.phaseId;
        planner.append({ eventType: "SheriffSignupCommitted", payload: { actorPlayerId: command.actorPlayerId, join: command.payload.join, sessionId: session.sessionId } }, phaseId);
        const after = planner.state; const afterRuntime = after?.runtime; const afterSession = afterRuntime?.sheriff.signupSession;
        if (after === null || afterRuntime === null || afterRuntime === undefined || afterSession == null) throw new CoreError("INVALID_PHASE", "Missing signup state");
        if (afterSession.committedPlayerIds.length === afterSession.eligiblePlayersSnapshot.length) {
          const candidates = seatOrdered(after, afterSession.joinedPlayerIds);
          const voters = seatOrdered(after, afterSession.eligiblePlayersSnapshot.filter((id) => !candidates.includes(id)));
          planner.append({ eventType: "SheriffSignupSessionClosed", payload: { sessionId: afterSession.sessionId, candidatePlayerIds: candidates, originalVoterPlayerIds: voters } }, phaseId);
          if (candidates.length === 0) { planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "NO_CANDIDATE" } }, phaseId, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, this.#deps); }
          else if (candidates.length === 1) { planner.append({ eventType: "SheriffElected", payload: { playerId: candidates[0]! } }, phaseId, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, this.#deps); }
          else { closeSimplePhase(planner); openSpeechPhase(planner, this.#deps, "SHERIFF_SPEECH", "SHERIFF_SPEECH", candidates, "SHERIFF_ELECTION"); }
        }
        void currentState;
        outcomeCode = "SHERIFF_SIGNUP_COMMITTED";
        break;
      }
      case "CommitSheriffWithdrawal": {
        const { runtime } = requireInProgress(state); const session = runtime.sheriff.withdrawalSession;
        if (runtime.phase?.phaseType !== "SHERIFF_WITHDRAWAL" || runtime.phase.status !== "OPEN" || session === null || session.status !== "OPEN" || command.windowToken !== session.sessionId || !session.candidatePlayersSnapshot.includes(command.actorPlayerId) || session.committedPlayerIds.includes(command.actorPlayerId)) throw new CoreError("INVALID_WINDOW_TOKEN", "Sheriff withdrawal window mismatch");
        const phaseId = runtime.phase.phaseId;
        planner.append({ eventType: "SheriffWithdrawalCommitted", payload: { actorPlayerId: command.actorPlayerId, withdraw: command.payload.withdraw, sessionId: session.sessionId } }, phaseId);
        const after = planner.state; const afterRuntime = after?.runtime; const afterSession = afterRuntime?.sheriff.withdrawalSession;
        if (after === null || afterRuntime === null || afterRuntime === undefined || afterSession == null) throw new CoreError("INVALID_PHASE", "Missing withdrawal state");
        if (afterSession.committedPlayerIds.length === afterSession.candidatePlayersSnapshot.length) {
          const remaining = seatOrdered(after, afterSession.candidatePlayersSnapshot.filter((id) => !afterSession.withdrawnPlayerIds.includes(id)));
          planner.append({ eventType: "SheriffWithdrawalSessionClosed", payload: { sessionId: afterSession.sessionId, remainingCandidatePlayerIds: remaining } }, phaseId);
          resolveSheriffElectionAfterCandidates(planner, this.#deps);
        }
        outcomeCode = "SHERIFF_WITHDRAWAL_COMMITTED";
        break;
      }
      case "CommitBallot": {
        const { runtime } = requireInProgress(state); const session = runtime.voteSession;
        if (runtime.phase === null || runtime.phase.status !== "OPEN" || session === null || session.status !== "OPEN" || command.windowToken !== session.sessionId || !session.eligibleVotersSnapshot.includes(command.actorPlayerId) || session.ballots.some((b) => b.voterPlayerId === command.actorPlayerId)) throw new CoreError("INVALID_WINDOW_TOKEN", "Vote window mismatch");
        if (command.payload.targetPlayerId !== null && !session.eligibleTargetsSnapshot.includes(command.payload.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal ballot target");
        const phaseId = runtime.phase.phaseId;
        planner.append({ eventType: "BallotCommitted", payload: { voterPlayerId: command.actorPlayerId, targetPlayerId: command.payload.targetPlayerId, sessionId: session.sessionId } }, phaseId);
        const after = planner.state; const afterRuntime = after?.runtime; const afterSession = afterRuntime?.voteSession;
        if (after === null || afterRuntime === null || afterRuntime === undefined || afterSession == null) throw new CoreError("INVALID_PHASE", "Missing vote state");
        if (afterSession.ballots.length === afterSession.eligibleVotersSnapshot.length) {
          const result = computeVoteResult(afterSession.eligibleTargetsSnapshot, afterSession.weightUnitsByVoter, afterSession.ballots);
          planner.append({ eventType: "VoteSessionResolved", payload: { sessionId: afterSession.sessionId, result, ballots: afterSession.ballots } }, phaseId, { kind: "PUBLIC" });
          const kind = afterSession.kind;
          if (kind === "SHERIFF") {
            if (result.resolutionKind === "WINNER" && result.winningTargetId !== null) { planner.append({ eventType: "SheriffElected", payload: { playerId: result.winningTargetId } }, phaseId, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, this.#deps); }
            else if (result.resolutionKind === "TIE") { closeSimplePhase(planner); openSpeechPhase(planner, this.#deps, "SHERIFF_PK_SPEECH", "SHERIFF_PK_SPEECH", seatOrdered(after, result.tiedPlayerIds), "SHERIFF_ELECTION"); }
            else { planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "ALL_ABSTAIN" } }, phaseId, { kind: "PUBLIC" }); closeSimplePhase(planner); openDayDiscussionFlow(planner, this.#deps); }
          } else if (kind === "SHERIFF_PK") {
            if (result.resolutionKind === "WINNER" && result.winningTargetId !== null) planner.append({ eventType: "SheriffElected", payload: { playerId: result.winningTargetId } }, phaseId, { kind: "PUBLIC" });
            else planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: result.resolutionKind === "TIE" ? "TIE" : "ALL_ABSTAIN" } }, phaseId, { kind: "PUBLIC" });
            closeSimplePhase(planner); openDayDiscussionFlow(planner, this.#deps);
          } else if (kind === "DAY") {
            if (result.resolutionKind === "WINNER" && result.winningTargetId !== null) { closeSimplePhase(planner); beginDayDeathResolution(planner, this.#deps, "VOTE_EXECUTION", result.winningTargetId); }
            else if (result.resolutionKind === "TIE") { closeSimplePhase(planner); openSpeechPhase(planner, this.#deps, "DAY_PK_SPEECH", "DAY_PK_SPEECH", seatOrdered(after, result.tiedPlayerIds), "NEXT_NIGHT"); }
            else { closeSimplePhase(planner); startNextNight(planner, this.#deps); }
          } else {
            if (result.resolutionKind === "WINNER" && result.winningTargetId !== null) { closeSimplePhase(planner); beginDayDeathResolution(planner, this.#deps, "VOTE_EXECUTION", result.winningTargetId); }
            else { closeSimplePhase(planner); startNextNight(planner, this.#deps); }
          }
        }
        outcomeCode = "BALLOT_COMMITTED";
        break;
      }
      case "ChooseDaySpeechOrder": {
        const { state: currentState, runtime } = requireInProgress(state);
        if (runtime.phase?.phaseType !== "DAY_ORDER_SELECTION" || runtime.phase.status !== "OPEN" || command.windowToken !== runtime.phase.phaseId || runtime.sheriff.badgeStatus !== "ACTIVE" || runtime.sheriff.holderPlayerId !== command.actorPlayerId) throw new CoreError("INVALID_WINDOW_TOKEN", "Only active sheriff may choose speaking order");
        const alive = alivePlayerIds(currentState); if (!alive.includes(command.payload.firstSpeakerPlayerId) || command.payload.firstSpeakerPlayerId === command.actorPlayerId) throw new CoreError("INVALID_TARGET", "First speaker must be a living non-sheriff player");
        const nonSheriff = alive.filter((id) => id !== command.actorPlayerId);
        const directional = seatOrdered(currentState, nonSheriff, command.payload.direction); const index = directional.indexOf(command.payload.firstSpeakerPlayerId);
        if (index < 0) throw new CoreError("INVALID_TARGET", "First speaker missing from order");
        const rotated = [...directional.slice(index), ...directional.slice(0, index), command.actorPlayerId];
        closeSimplePhase(planner); openSpeechPhase(planner, this.#deps, "DAY_DISCUSSION", "DAY_DISCUSSION", rotated, "DAY_DISCUSSION");
        outcomeCode = "DAY_SPEECH_ORDER_CHOSEN";
        break;
      }
      case "CommitSelfExplosion": {
        const { runtime } = requireInProgress(state); const session = runtime.speechSession;
        const allowed = ["SHERIFF_SPEECH", "SHERIFF_PK_SPEECH", "DAY_DISCUSSION", "DAY_PK_SPEECH"] as const;
        const actor = runtime.players.find((p) => p.playerId === command.actorPlayerId);
        if (runtime.phase === null || runtime.phase.status !== "OPEN" || !allowed.includes(runtime.phase.phaseType as typeof allowed[number]) || session === null || session.status !== "OPEN" || command.windowToken !== session.sessionId || actor?.lifeState !== "ALIVE" || actor.effectiveFactionId !== "WOLF") throw new CoreError("INVALID_PHASE", "Self explosion is not legal now");
        const phaseId = runtime.phase.phaseId; const wasSheriffElection = runtime.phase.phaseType === "SHERIFF_SPEECH" || runtime.phase.phaseType === "SHERIFF_PK_SPEECH";
        planner.append({ eventType: "SelfExplosionCommitted", payload: { actorPlayerId: command.actorPlayerId } }, phaseId, { kind: "PUBLIC" });
        if (wasSheriffElection) planner.append({ eventType: "SheriffElectionClosedNoBadge", payload: { reason: "SELF_EXPLOSION" } }, phaseId, { kind: "PUBLIC" });
        closeSimplePhase(planner); beginDayDeathResolution(planner, this.#deps, "SELF_EXPLOSION", command.actorPlayerId);
        outcomeCode = "SELF_EXPLOSION_COMMITTED";
        break;
      }
      case "CommitSheriffBadgeAction": {
        const { runtime } = requireInProgress(state); const phase = runtime.phase;
        if (phase?.phaseType !== "SHERIFF_BADGE_ACTION" || phase.status !== "OPEN" || command.windowToken !== phase.phaseId || runtime.sheriff.badgeStatus !== "ACTIVE" || runtime.sheriff.holderPlayerId !== command.actorPlayerId || runtime.players.find((p) => p.playerId === command.actorPlayerId)?.lifeState !== "DEAD") throw new CoreError("INVALID_WINDOW_TOKEN", "Sheriff badge action not available");
        const continuation = phase.continuation;
        if (command.payload.action === "TRANSFER") {
          if (runtime.players.find((p) => p.playerId === command.payload.targetPlayerId)?.lifeState !== "ALIVE") throw new CoreError("INVALID_TARGET", "Badge transfer target must be alive");
          planner.append({ eventType: "SheriffTransferred", payload: { fromPlayerId: command.actorPlayerId, toPlayerId: command.payload.targetPlayerId } }, phase.phaseId, { kind: "PUBLIC" });
        } else planner.append({ eventType: "SheriffBadgeDestroyed", payload: { holderPlayerId: command.actorPlayerId } }, phase.phaseId, { kind: "PUBLIC" });
        closeSimplePhase(planner);
        if (continuation === "DAY_DISCUSSION") openDayDiscussionFlow(planner, this.#deps); else startNextNight(planner, this.#deps);
        outcomeCode = "SHERIFF_BADGE_ACTION_COMMITTED";
        break;
      }
      case "AbortGame": {
        if (state === null) throw new CoreError("GAME_NOT_FOUND", "Game not found");
        if (state.status === "ABORTED") throw new CoreError("GAME_ABORTED", "Game is already aborted");
        if (state.status === "ENDED") throw new CoreError("INVALID_PHASE", "Ended game cannot be aborted");
        planner.append({ eventType: "GameAborted", payload: { reason: command.payload.reason } }, null);
        outcomeCode = "GAME_ABORTED";
        break;
      }
    }

    const plannedEvents = planner.events;
    if (plannedEvents.length === 0) throw new CoreError("INVALID_INPUT", "Successful command must emit at least one event");
    const firstSequence = plannedEvents[0]?.sequence;
    const lastSequence = plannedEvents.at(-1)?.sequence;
    if (firstSequence === undefined || lastSequence === undefined) throw new CoreError("INVALID_INPUT", "Invalid event batch");
    const receipt: CommandReceipt = {
      commandId: command.commandId,
      gameId: command.gameId,
      principalKey: pKey,
      canonicalRequest,
      firstSequence,
      lastSequence,
      outcomeCode,
    };
    this.#deps.repository.append(command.gameId, expectedSequence, plannedEvents, receipt);
    return cloneJson(receipt);
  }
}
