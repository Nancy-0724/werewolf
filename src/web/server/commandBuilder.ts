import { randomUUID } from "node:crypto";
import { CoreError } from "../../core/domain/errors.js";
import type { Command } from "../../core/domain/schemas.js";
import type { PlayerActionPrompt, PlayerView } from "../../projection/schemas.js";
import type { WebActionRequest } from "../shared/actionRequest.js";

function promptOf<C extends PlayerActionPrompt["commandType"]>(view: PlayerView, commandType: C): Extract<PlayerActionPrompt, { commandType: C }> {
  const prompt = view.availableActions.find((entry) => entry.commandType === commandType);
  if (prompt === undefined) throw new CoreError("INVALID_PHASE", `${commandType} is not currently available`);
  return prompt as Extract<PlayerActionPrompt, { commandType: C }>;
}

function requireTarget(target: string | null, legalTargets: readonly string[]): string {
  if (target === null || !legalTargets.includes(target)) throw new CoreError("INVALID_TARGET", "Target is not legal for the current action");
  return target;
}

export function buildPlayerCommand(
  gameId: string,
  playerId: string,
  view: PlayerView,
  request: WebActionRequest,
  speechSource: "HUMAN_TEXT" | "NPC_TEXT" = "HUMAN_TEXT",
): Command {
  const commandId = randomUUID();
  switch (request.commandType) {
    case "CommitGuardAction": {
      const prompt = promptOf(view, request.commandType);
      if (request.targetPlayerId !== null && !prompt.legalTargetPlayerIds.includes(request.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal guard target");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { targetPlayerId: request.targetPlayerId } };
    }
    case "CommitWolfBallot": {
      const prompt = promptOf(view, request.commandType);
      if (request.targetPlayerId !== null && !prompt.legalTargetPlayerIds.includes(request.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal wolf target");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { targetPlayerId: request.targetPlayerId } };
    }
    case "CommitBeautyAction": {
      const prompt = promptOf(view, request.commandType);
      if (request.mode === "KEEP") {
        if (request.targetPlayerId !== null || !prompt.modes.includes("KEEP")) throw new CoreError("INVALID_TARGET", "KEEP does not take a target");
        return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { mode: "KEEP", targetPlayerId: null } };
      }
      const targetPlayerId = requireTarget(request.targetPlayerId, prompt.legalTargetPlayerIds);
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { mode: "CHARM", targetPlayerId } };
    }
    case "CommitWitchAction": {
      const prompt = promptOf(view, request.commandType);
      if (request.action === "PASS") return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "PASS", targetPlayerId: null } };
      if (request.action === "HEAL") {
        const targetPlayerId = request.targetPlayerId;
        if (targetPlayerId === null || prompt.healRemaining !== 1 || prompt.healTargetPlayerId !== targetPlayerId) throw new CoreError("INVALID_TARGET", "Illegal heal target");
        return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "HEAL", targetPlayerId } };
      }
      const targetPlayerId = requireTarget(request.targetPlayerId, prompt.poisonTargetPlayerIds);
      if (prompt.poisonRemaining !== 1) throw new CoreError("ABILITY_RESOURCE_UNAVAILABLE", "Poison is unavailable");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "POISON", targetPlayerId } };
    }
    case "CommitSeerAction": {
      const prompt = promptOf(view, request.commandType);
      if (request.targetPlayerId !== null && !prompt.legalTargetPlayerIds.includes(request.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal seer target");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { targetPlayerId: request.targetPlayerId } };
    }
    case "CommitHunterReaction": {
      const prompt = promptOf(view, request.commandType);
      if (request.action === "PASS") return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "PASS", targetPlayerId: null } };
      const targetPlayerId = requireTarget(request.targetPlayerId, prompt.legalTargetPlayerIds);
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "SHOOT", targetPlayerId } };
    }
    case "CommitSpeech": {
      const prompt = promptOf(view, request.commandType);
      if (request.mode === "PASS") return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { mode: "PASS", text: null, source: null } };
      const text = request.text?.trim() ?? "";
      if (text.length === 0) throw new CoreError("INVALID_INPUT", "Speech text is required");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { mode: "SPEAK", text, source: speechSource } };
    }
    case "CommitSheriffSignup": {
      const prompt = promptOf(view, request.commandType);
      if (!prompt.choices.includes(request.choice)) throw new CoreError("INVALID_INPUT", "Illegal sheriff signup choice");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { join: request.choice === "JOIN" } };
    }
    case "CommitSheriffWithdrawal": {
      const prompt = promptOf(view, request.commandType);
      if (!prompt.choices.includes(request.choice)) throw new CoreError("INVALID_INPUT", "Illegal sheriff withdrawal choice");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { withdraw: request.choice === "WITHDRAW" } };
    }
    case "CommitBallot": {
      const prompt = promptOf(view, request.commandType);
      if (request.targetPlayerId !== null && !prompt.legalTargetPlayerIds.includes(request.targetPlayerId)) throw new CoreError("INVALID_TARGET", "Illegal ballot target");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { targetPlayerId: request.targetPlayerId } };
    }
    case "ChooseDaySpeechOrder": {
      const prompt = promptOf(view, request.commandType);
      if (!prompt.legalFirstSpeakerPlayerIds.includes(request.firstSpeakerPlayerId) || !prompt.directions.includes(request.direction)) throw new CoreError("INVALID_TARGET", "Illegal speech order choice");
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { firstSpeakerPlayerId: request.firstSpeakerPlayerId, direction: request.direction } };
    }
    case "CommitSelfExplosion": {
      const prompt = promptOf(view, request.commandType);
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: {} };
    }
    case "CommitSheriffBadgeAction": {
      const prompt = promptOf(view, request.commandType);
      if (request.action === "DESTROY") return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "DESTROY", targetPlayerId: null } };
      const targetPlayerId = requireTarget(request.targetPlayerId, prompt.transferTargetPlayerIds);
      return { commandId, gameId, actorPlayerId: playerId, windowToken: prompt.windowToken, commandType: request.commandType, payload: { action: "TRANSFER", targetPlayerId } };
    }
  }
}
