import { NpcPersonaSchema, type NpcPersona } from "./schemas.js";

const PERSONAS: readonly NpcPersona[] = [
  { archetype: "ANALYST", aggression: 42, assertiveness: 58, riskTolerance: 38, skepticism: 75, leadership: 55, verbosity: 68, consistencyBias: 90, deceptionComfort: 45 },
  { archetype: "CAUTIOUS", aggression: 28, assertiveness: 42, riskTolerance: 24, skepticism: 62, leadership: 38, verbosity: 45, consistencyBias: 84, deceptionComfort: 35 },
  { archetype: "ASSERTIVE", aggression: 78, assertiveness: 86, riskTolerance: 70, skepticism: 55, leadership: 82, verbosity: 62, consistencyBias: 63, deceptionComfort: 72 },
  { archetype: "SOCIAL", aggression: 48, assertiveness: 66, riskTolerance: 52, skepticism: 42, leadership: 71, verbosity: 82, consistencyBias: 58, deceptionComfort: 64 },
  { archetype: "SKEPTIC", aggression: 55, assertiveness: 68, riskTolerance: 44, skepticism: 91, leadership: 57, verbosity: 57, consistencyBias: 78, deceptionComfort: 49 },
  { archetype: "OPPORTUNIST", aggression: 64, assertiveness: 73, riskTolerance: 76, skepticism: 59, leadership: 48, verbosity: 50, consistencyBias: 41, deceptionComfort: 88 },
] as const;

function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Stable per game/player. It intentionally uses no RNG, clock, network, or hidden GameState. */
export function deriveNpcPersona(gameId: string, npcPlayerId: string): NpcPersona {
  const index = fnv1a32(`${gameId}:${npcPlayerId}`) % PERSONAS.length;
  const persona = PERSONAS[index];
  if (persona === undefined) throw new Error("NPC persona catalog is empty");
  return NpcPersonaSchema.parse({ ...persona });
}
