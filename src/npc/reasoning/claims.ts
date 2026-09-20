import type { NpcCognitiveState, NpcClaim } from "../cognition/schemas.js";

const ROLE_ALIASES: ReadonlyArray<readonly [RegExp, string]> = [
  [/狼美人|狼美/u, "WOLF_BEAUTY"],
  [/預言家|预言家|預言|预言/u, "SEER"],
  [/女巫/u, "WITCH"],
  [/獵人|猎人/u, "HUNTER"],
  [/守衛|守卫/u, "GUARD"],
  [/平民|村民/u, "VILLAGER"],
  [/狼人|普通狼/u, "WEREWOLF"],
];

function roleFromText(text: string): string | null {
  for (const [pattern, roleId] of ROLE_ALIASES) if (pattern.test(text)) return roleId;
  return null;
}

function playerIdForSeat(state: NpcCognitiveState, seatNumberText: string): string | null {
  const seatNumber = Number.parseInt(seatNumberText, 10);
  if (!Number.isInteger(seatNumber)) return null;
  return state.publicSnapshot.seats.find((seat) => seat.seatNumber === seatNumber)?.playerId ?? null;
}

function alignmentFromToken(token: string): "WOLF" | "GOOD" | null {
  if (/查殺|查杀|狼人|是狼|狼牌|狼/u.test(token)) return "WOLF";
  if (/金水|好人|善良|不是狼/u.test(token)) return "GOOD";
  return null;
}

function normalizeStatement(text: string): string { return text.trim().replace(/\s+/gu, " ").slice(0, 240); }

function autoClaimId(ordinal: number, kind: string, index: number): string { return `AUTO:SPEECH:${ordinal}:${kind}:${index}`; }

export function extractClaimsFromSpeechMemory(state: NpcCognitiveState): NpcClaim[] {
  const claims: NpcClaim[] = [];
  for (const memory of state.memory) {
    if (memory.visibility !== "PUBLIC" || memory.observation.type !== "SPEECH") continue;
    const observation = memory.observation;
    const text = normalizeStatement(observation.text);
    let index = 0;

    const selfRoleMatch = text.match(/(?:我是|我才是|我跳|我認|我认|我身份是|我身分是|我底牌是)\s*([^，。,.!！?？\s]{1,8})/u);
    if (selfRoleMatch?.[1]) {
      const roleId = roleFromText(selfRoleMatch[1]);
      if (roleId) claims.push({
        claimId: autoClaimId(observation.ordinal, "ROLE", index++),
        sourcePlayerId: observation.speakerPlayerId,
        sourcePublicOrdinal: observation.ordinal,
        claimType: "ROLE_CLAIM",
        roleId,
        targetPlayerId: observation.speakerPlayerId,
        alignment: roleId === "WEREWOLF" || roleId === "WOLF_BEAUTY" ? "WOLF" : "GOOD",
        statement: text,
      });
    }

    const checkPatterns = [
      /(?:查|驗|验|查驗|查验)(?:了|過|过)?\s*(\d{1,2})\s*號[^，。,.!！?？]{0,18}?(查殺|查杀|金水|好人|狼人|是狼|狼牌)/gu,
      /(\d{1,2})\s*號[^，。,.!！?？]{0,8}?(?:是|為|为)?\s*(查殺|查杀|金水)/gu,
    ];
    const seenCheckTargets = new Set<string>();
    for (const pattern of checkPatterns) {
      for (const match of text.matchAll(pattern)) {
        const targetPlayerId = playerIdForSeat(state, match[1] ?? "");
        const alignment = alignmentFromToken(match[2] ?? "");
        if (!targetPlayerId || !alignment || seenCheckTargets.has(`${targetPlayerId}:${alignment}`)) continue;
        seenCheckTargets.add(`${targetPlayerId}:${alignment}`);
        claims.push({
          claimId: autoClaimId(observation.ordinal, "CHECK", index++),
          sourcePlayerId: observation.speakerPlayerId,
          sourcePublicOrdinal: observation.ordinal,
          claimType: "CHECK_RESULT",
          roleId: "SEER",
          targetPlayerId,
          alignment,
          statement: text,
        });
      }
    }

    const voteMatch = text.match(/(?:我(?:今天|這輪|这轮)?(?:會|会|要|想)?(?:投|出)|(?:投|出|票))\s*(\d{1,2})\s*號/u);
    if (voteMatch?.[1]) {
      const targetPlayerId = playerIdForSeat(state, voteMatch[1]);
      if (targetPlayerId) claims.push({
        claimId: autoClaimId(observation.ordinal, "VOTE", index++),
        sourcePlayerId: observation.speakerPlayerId,
        sourcePublicOrdinal: observation.ordinal,
        claimType: "VOTE_INTENT",
        roleId: null,
        targetPlayerId,
        alignment: null,
        statement: text,
      });
    }

    if (seenCheckTargets.size === 0) {
      const readMatch = text.match(/(\d{1,2})\s*號[^，。,.!！?？]{0,15}?(偏狼|像狼|狼面|狼坑|是狼|偏好|像好人|好人面)/u);
      if (readMatch?.[1] && readMatch[2]) {
        const targetPlayerId = playerIdForSeat(state, readMatch[1]);
        const alignment = /狼/u.test(readMatch[2]) ? "WOLF" : "GOOD";
        if (targetPlayerId) claims.push({
          claimId: autoClaimId(observation.ordinal, "READ", index++),
          sourcePlayerId: observation.speakerPlayerId,
          sourcePublicOrdinal: observation.ordinal,
          claimType: "ALIGNMENT_READ",
          roleId: null,
          targetPlayerId,
          alignment,
          statement: text,
        });
      }
    }
  }
  return claims;
}
