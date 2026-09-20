import { CoreError } from "../domain/errors.js";
import { cloneJson, stableStringify } from "../domain/json.js";
import { replay } from "../domain/reducer.js";
import { CommandReceiptSchema, ExportBundleSchema, type CommandReceipt, type DomainEvent, type ExportBundle } from "../domain/schemas.js";
import { InMemoryGameRepository } from "../infrastructure/repository.js";

function expectedPrincipalKey(receipt: CommandReceipt): string {
  const command = receipt.canonicalRequest;
  if (command.actorPlayerId === null) {
    if (!receipt.principalKey.startsWith("HOST:")) throw new CoreError("INVALID_EVENT_STREAM", "Host command receipt must use HOST principal");
    return receipt.principalKey;
  }
  const expected = `PLAYER:${command.actorPlayerId}`;
  if (receipt.principalKey !== expected) throw new CoreError("INVALID_EVENT_STREAM", "Player command receipt principal mismatch");
  return expected;
}

function eventTypes(events: readonly DomainEvent[]): DomainEvent["eventType"][] {
  return events.map((event) => event.eventType);
}

function sameTypes(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function validateCommandBatch(receipt: CommandReceipt, events: readonly DomainEvent[]): void {
  expectedPrincipalKey(receipt);
  if (events.length === 0) throw new CoreError("INVALID_EVENT_STREAM", "Receipt event range cannot be empty");
  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined || first.sequence !== receipt.firstSequence || last.sequence !== receipt.lastSequence) {
    throw new CoreError("INVALID_EVENT_STREAM", "Receipt sequence range mismatch");
  }
  for (const event of events) {
    if (event.gameId !== receipt.gameId || event.causationCommandId !== receipt.commandId) throw new CoreError("INVALID_EVENT_STREAM", "Receipt/event causation mismatch");
  }
  const command = receipt.canonicalRequest;
  if (command.gameId !== receipt.gameId) throw new CoreError("INVALID_EVENT_STREAM", "Receipt command gameId mismatch");
  const types = eventTypes(events);

  switch (command.commandType) {
    case "CreateGame":
      if (receipt.outcomeCode !== "GAME_CREATED" || !sameTypes(types, ["GameCreated"])) throw new CoreError("INVALID_EVENT_STREAM", "CreateGame receipt batch mismatch");
      if (first.eventType !== "GameCreated" || stableStringify(command.payload.rulesetSnapshot) !== stableStringify(first.payload.rulesetDraft)) throw new CoreError("INVALID_EVENT_STREAM", "CreateGame payload mismatch");
      return;
    case "ConfigureSeats":
      if (receipt.outcomeCode !== "SEATS_CONFIGURED" || !sameTypes(types, ["SeatsConfigured"])) throw new CoreError("INVALID_EVENT_STREAM", "ConfigureSeats receipt batch mismatch");
      if (first.eventType !== "SeatsConfigured" || stableStringify(command.payload.seats) !== stableStringify(first.payload.seats)) throw new CoreError("INVALID_EVENT_STREAM", "ConfigureSeats payload mismatch");
      return;
    case "LockGame":
      if (receipt.outcomeCode !== "SETUP_LOCKED" || !sameTypes(types, ["SetupLocked"])) throw new CoreError("INVALID_EVENT_STREAM", "LockGame receipt batch mismatch");
      return;
    case "AbortGame":
      if (receipt.outcomeCode !== "GAME_ABORTED" || !sameTypes(types, ["GameAborted"])) throw new CoreError("INVALID_EVENT_STREAM", "AbortGame receipt batch mismatch");
      if (first.eventType !== "GameAborted" || first.payload.reason !== command.payload.reason) throw new CoreError("INVALID_EVENT_STREAM", "AbortGame payload mismatch");
      return;
    case "StartGame":
      if (receipt.outcomeCode !== "GAME_STARTED" || !sameTypes(types, ["GameStarted", "PhaseOpened", "ActionWindowOpened"])) throw new CoreError("INVALID_EVENT_STREAM", "StartGame receipt batch mismatch");
      return;
    case "CommitGuardAction":
      if (receipt.outcomeCode !== "GUARD_ACTION_COMMITTED" || !sameTypes(types, ["NightActionCommitted", "ActionWindowClosed", "PhaseClosed", "PhaseOpened", "ActionWindowOpened"])) throw new CoreError("INVALID_EVENT_STREAM", "Guard action receipt batch mismatch");
      if (first.eventType !== "NightActionCommitted" || first.payload.intentType !== "GUARD" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Guard action payload mismatch");
      return;
    case "CommitWolfBallot": {
      const partial = ["WolfBallotCommitted"];
      const final = ["WolfBallotCommitted", "WolfTargetCommitted", "ActionWindowClosed", "PhaseClosed", "PhaseOpened", "ActionWindowOpened"];
      if (receipt.outcomeCode !== "WOLF_BALLOT_COMMITTED" || (!sameTypes(types, partial) && !sameTypes(types, final))) throw new CoreError("INVALID_EVENT_STREAM", "Wolf ballot receipt batch mismatch");
      if (first.eventType !== "WolfBallotCommitted" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Wolf ballot payload mismatch");
      return;
    }
    case "CommitBeautyAction":
      if (receipt.outcomeCode !== "BEAUTY_ACTION_COMMITTED" || !sameTypes(types, ["NightActionCommitted", "ActionWindowClosed", "PhaseClosed", "PhaseOpened", "ActionWindowOpened"])) throw new CoreError("INVALID_EVENT_STREAM", "Beauty action receipt batch mismatch");
      if (first.eventType !== "NightActionCommitted" || first.payload.intentType !== "BEAUTY" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.mode !== command.payload.mode || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Beauty action payload mismatch");
      return;
    case "CommitWitchAction": {
      const pass = ["NightActionCommitted", "ActionWindowClosed", "PhaseClosed", "PhaseOpened", "ActionWindowOpened"];
      const spend = ["NightActionCommitted", "AbilityResourceSpent", "ActionWindowClosed", "PhaseClosed", "PhaseOpened", "ActionWindowOpened"];
      const expected = command.payload.action === "PASS" ? pass : spend;
      if (receipt.outcomeCode !== "WITCH_ACTION_COMMITTED" || !sameTypes(types, expected)) throw new CoreError("INVALID_EVENT_STREAM", "Witch action receipt batch mismatch");
      if (first.eventType !== "NightActionCommitted" || first.payload.intentType !== "WITCH" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.action !== command.payload.action || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Witch action payload mismatch");
      return;
    }
    case "CommitSeerAction":
      if (receipt.outcomeCode !== "SEER_ACTION_COMMITTED" || !sameTypes(types, ["NightActionCommitted", "ActionWindowClosed", "PhaseClosed", "PhaseOpened"])) throw new CoreError("INVALID_EVENT_STREAM", "Seer action receipt batch mismatch");
      if (first.eventType !== "NightActionCommitted" || first.payload.intentType !== "SEER" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Seer action payload mismatch");
      return;
    case "ResolveNight": {
      if (receipt.outcomeCode !== "NIGHT_RESOLVED") throw new CoreError("INVALID_EVENT_STREAM", "ResolveNight receipt outcome mismatch");
      if (types[0] !== "PhaseClosed" || types[1] !== "PhaseOpened" || !types.includes("DawnAnnouncementPublished")) throw new CoreError("INVALID_EVENT_STREAM", "ResolveNight batch shape mismatch");
      const hasReaction = types.includes("ReactionWindowOpened");
      const hasSettled = types.includes("ResolutionGroupSettled");
      if (hasReaction === hasSettled) throw new CoreError("INVALID_EVENT_STREAM", "ResolveNight must either open hunter reaction or settle immediately");
      return;
    }
    case "CommitHunterReaction": {
      if (receipt.outcomeCode !== "HUNTER_REACTION_COMMITTED" || types[0] !== "ReactionCommitted" || !types.includes("ReactionClosed") || !types.includes("ResolutionGroupSettled")) throw new CoreError("INVALID_EVENT_STREAM", "Hunter reaction receipt batch mismatch");
      if (first.eventType !== "ReactionCommitted" || first.payload.actorPlayerId !== command.actorPlayerId || first.payload.action !== command.payload.action || first.payload.targetPlayerId !== command.payload.targetPlayerId) throw new CoreError("INVALID_EVENT_STREAM", "Hunter reaction payload mismatch");
      return;
    }
  }
}

export function exportBundle(repository: InMemoryGameRepository, gameId: string): string {
  const events = repository.loadEvents(gameId);
  if (events.length === 0) throw new CoreError("GAME_NOT_FOUND", "Game not found");
  const bundle: ExportBundle = { formatVersion: "1.0.0", gameId, events, commandReceipts: repository.loadReceipts(gameId) };
  return JSON.stringify(bundle, null, 2);
}

export function importBundle(repository: InMemoryGameRepository, json: string): void {
  let raw: unknown;
  try { raw = JSON.parse(json) as unknown; } catch { throw new CoreError("INVALID_EVENT_STREAM", "Bundle is not valid JSON"); }
  const parsed = ExportBundleSchema.safeParse(raw);
  if (!parsed.success) throw new CoreError("INVALID_EVENT_STREAM", parsed.error.message);
  const bundle = cloneJson(parsed.data);
  if (bundle.events.length === 0) throw new CoreError("INVALID_EVENT_STREAM", "Bundle must contain a game event stream");
  if (repository.hasGame(bundle.gameId)) throw new CoreError("GAME_ALREADY_EXISTS", "Import will not overwrite an existing game");
  replay(bundle.events);

  const eventIds = new Set<string>();
  for (const event of bundle.events) {
    if (event.gameId !== bundle.gameId || eventIds.has(event.eventId)) throw new CoreError("INVALID_EVENT_STREAM", "Invalid or duplicate eventId/gameId");
    eventIds.add(event.eventId);
  }

  const receiptsByCommand = new Map<string, CommandReceipt>();
  for (const rawReceipt of bundle.commandReceipts) {
    const receipt = CommandReceiptSchema.parse(rawReceipt);
    if (receiptsByCommand.has(receipt.commandId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate receipt commandId");
    receiptsByCommand.set(receipt.commandId, receipt);
  }

  for (const event of bundle.events) {
    const receipt = receiptsByCommand.get(event.causationCommandId);
    if (receipt === undefined) throw new CoreError("INVALID_EVENT_STREAM", "Missing receipt for event");
    if (event.sequence < receipt.firstSequence || event.sequence > receipt.lastSequence) throw new CoreError("INVALID_EVENT_STREAM", "Event lies outside receipt range");
  }

  for (const receipt of bundle.commandReceipts) {
    const events = bundle.events.filter((event) => event.sequence >= receipt.firstSequence && event.sequence <= receipt.lastSequence);
    validateCommandBatch(receipt, events);
  }

  const coveredSequences = new Set<number>();
  for (const receipt of bundle.commandReceipts) {
    for (let sequence = receipt.firstSequence; sequence <= receipt.lastSequence; sequence += 1) {
      if (coveredSequences.has(sequence)) throw new CoreError("INVALID_EVENT_STREAM", "Receipt sequence ranges overlap");
      coveredSequences.add(sequence);
    }
  }
  if (coveredSequences.size !== bundle.events.length || bundle.events.some((event) => !coveredSequences.has(event.sequence))) {
    throw new CoreError("INVALID_EVENT_STREAM", "Receipt ranges must cover every event exactly once");
  }

  repository.importValidatedGame(bundle.gameId, bundle.events, bundle.commandReceipts);
}
