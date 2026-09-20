import { randomUUID } from "node:crypto";
import * as z from "zod";
import { CoreError } from "../../core/domain/errors.js";
import type { Command, Seat } from "../../core/domain/schemas.js";
import { supportedRulesetSnapshot } from "../../core/rulesets/wb12.js";
import type { PlayerView } from "../../projection/schemas.js";
import { WebActionRequestSchema, type WebActionRequest } from "../shared/actionRequest.js";
import { autoAdvanceUntilHuman } from "./bot.js";
import { buildPlayerCommand } from "./commandBuilder.js";
import { getWebRuntime, type WebStorageMode } from "./runtime.js";

export const CreateWebGameInputSchema = z.object({
  displayName: z.string().trim().min(1).max(24),
  seatNumber: z.number().int().min(1).max(12).default(1),
}).strict();
export type CreateWebGameInput = z.infer<typeof CreateWebGameInputSchema>;

function hostCommand(gameId: string, commandType: "CreateGame" | "ConfigureSeats" | "LockGame" | "StartGame", payload: Command["payload"]): Command {
  return { commandId: randomUUID(), gameId, actorPlayerId: null, windowToken: null, commandType, payload } as Command;
}

function makeSeats(displayName: string, humanSeatNumber: number, humanPlayerId: string): Seat[] {
  return Array.from({ length: 12 }, (_, index) => {
    const seatNumber = index + 1;
    const human = seatNumber === humanSeatNumber;
    return {
      playerId: human ? humanPlayerId : randomUUID(),
      seatNumber,
      displayName: human ? displayName : `NPC ${String(seatNumber).padStart(2, "0")}`,
      controllerType: human ? "HUMAN" as const : "NPC" as const,
    };
  });
}

export interface WebGameEnvelope {
  view: PlayerView;
  storageMode: WebStorageMode;
  autoAdvance: { steps: number; stoppedForHuman: boolean; terminal: boolean; capped: boolean };
}

export async function createWebGame(rawInput: unknown): Promise<{ gameId: string; playerId: string; envelope: WebGameEnvelope }> {
  const input = CreateWebGameInputSchema.parse(rawInput);
  const runtime = getWebRuntime();
  const gameId = randomUUID();
  const playerId = randomUUID();
  const seats = makeSeats(input.displayName, input.seatNumber, playerId);
  const host = { kind: "HOST" as const, hostId: "web-alpha-host" };

  await runtime.gameService.handle(host, hostCommand(gameId, "CreateGame", { rulesetSnapshot: supportedRulesetSnapshot() }));
  await runtime.gameService.handle(host, hostCommand(gameId, "ConfigureSeats", { seats }));
  await runtime.gameService.handle(host, hostCommand(gameId, "LockGame", {}));
  await runtime.gameService.handle(host, hostCommand(gameId, "StartGame", {}));
  const autoAdvance = await autoAdvanceUntilHuman(gameId, playerId);
  const view = await runtime.playerViewService.forPlayer(gameId, playerId);
  return { gameId, playerId, envelope: { view, storageMode: runtime.storageMode, autoAdvance } };
}

export async function loadWebGame(gameId: string, playerId: string): Promise<WebGameEnvelope> {
  const runtime = getWebRuntime();
  const view = await runtime.playerViewService.forPlayer(gameId, playerId);
  return { view, storageMode: runtime.storageMode, autoAdvance: { steps: 0, stoppedForHuman: view.availableActions.length > 0, terminal: view.public.status === "ENDED" || view.public.status === "ABORTED", capped: false } };
}

export async function submitWebAction(gameId: string, playerId: string, rawRequest: unknown): Promise<WebGameEnvelope> {
  const runtime = getWebRuntime();
  const request: WebActionRequest = WebActionRequestSchema.parse(rawRequest);
  const view = await runtime.playerViewService.forPlayer(gameId, playerId);
  const command = buildPlayerCommand(gameId, playerId, view, request, "HUMAN_TEXT");
  await runtime.gameService.handle({ kind: "PLAYER", playerId }, command);
  const autoAdvance = await autoAdvanceUntilHuman(gameId, playerId);
  const nextView = await runtime.playerViewService.forPlayer(gameId, playerId);
  return { view: nextView, storageMode: runtime.storageMode, autoAdvance };
}

export async function advanceWebGame(gameId: string, playerId: string): Promise<WebGameEnvelope> {
  const runtime = getWebRuntime();
  const viewBefore = await runtime.playerViewService.forPlayer(gameId, playerId);
  if (viewBefore.availableActions.length > 0) throw new CoreError("INVALID_PHASE", "Player action is required before auto advance");
  const autoAdvance = await autoAdvanceUntilHuman(gameId, playerId);
  const view = await runtime.playerViewService.forPlayer(gameId, playerId);
  return { view, storageMode: runtime.storageMode, autoAdvance };
}
