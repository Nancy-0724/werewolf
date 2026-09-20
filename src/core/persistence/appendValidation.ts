import { CoreError } from "../domain/errors.js";
import { replayFromState } from "../domain/reducer.js";
import { CommandReceiptSchema, type CommandReceipt, type DomainEvent, type GameState, parseEvent } from "../domain/schemas.js";

export interface ValidatedAppendBatch {
  events: DomainEvent[];
  receipt: CommandReceipt;
  resultingState: GameState;
}

export function validateAppendBatch(
  gameId: string,
  expectedSequence: number,
  currentState: GameState | null,
  rawEvents: readonly unknown[],
  rawReceipt: unknown,
): ValidatedAppendBatch {
  const currentSequence = currentState?.lastSequence ?? 0;
  if (currentSequence !== expectedSequence) throw new CoreError("CONCURRENCY_CONFLICT", `Expected ${expectedSequence}, current ${currentSequence}`);
  if (rawEvents.length === 0) throw new CoreError("INVALID_EVENT_STREAM", "Append batch must contain at least one event");

  const events = rawEvents.map(parseEvent);
  const parsedReceipt = CommandReceiptSchema.safeParse(rawReceipt);
  if (!parsedReceipt.success) throw new CoreError("INVALID_EVENT_STREAM", parsedReceipt.error.message);
  const receipt = parsedReceipt.data;
  if (receipt.gameId !== gameId || receipt.canonicalRequest.gameId !== gameId) throw new CoreError("INVALID_EVENT_STREAM", "Receipt gameId mismatch");

  const first = events[0];
  const last = events.at(-1);
  if (first === undefined || last === undefined || first.sequence !== expectedSequence + 1) throw new CoreError("INVALID_EVENT_STREAM", "Append batch does not start at expected next sequence");
  if (receipt.firstSequence !== first.sequence || receipt.lastSequence !== last.sequence) throw new CoreError("INVALID_EVENT_STREAM", "Receipt sequence range does not match append batch");

  let expected = expectedSequence + 1;
  const ids = new Set<string>();
  for (const event of events) {
    if (event.sequence !== expected) throw new CoreError("INVALID_EVENT_STREAM", "Append batch sequence must be contiguous");
    expected += 1;
    if (event.gameId !== gameId || event.causationCommandId !== receipt.commandId) throw new CoreError("INVALID_EVENT_STREAM", "Event/receipt causation mismatch");
    if (ids.has(event.eventId)) throw new CoreError("INVALID_EVENT_STREAM", "Duplicate eventId inside append batch");
    ids.add(event.eventId);
  }

  const resultingState = replayFromState(currentState, events);
  if (resultingState === null) throw new CoreError("INVALID_EVENT_STREAM", "Append unexpectedly produced empty state");
  return { events, receipt, resultingState };
}
