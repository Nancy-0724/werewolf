import { createHmac, timingSafeEqual } from "node:crypto";
import * as z from "zod";

const SESSION_VERSION = 1 as const;
const SessionPayloadSchema = z.object({
  v: z.literal(SESSION_VERSION),
  gameId: z.string().min(1),
  playerId: z.string().min(1),
  exp: z.number().int().positive(),
}).strict();

export type WebSession = z.infer<typeof SessionPayloadSchema>;

export function assertWebSessionConfigured(): void {
  void sessionSecret();
}

function sessionSecret(): string {
  const configured = process.env.WEB_SESSION_SECRET?.trim();
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") throw new Error("WEB_SESSION_SECRET is required in production");
  return "werewolf-local-development-session-secret-change-me";
}

function sign(payload: string): string {
  return createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
}

export function createWebSessionToken(gameId: string, playerId: string, maxAgeSeconds = 60 * 60 * 24 * 7): string {
  const payload: WebSession = { v: SESSION_VERSION, gameId, playerId, exp: Math.floor(Date.now() / 1000) + maxAgeSeconds };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

export function verifyWebSessionToken(token: string | undefined | null): WebSession | null {
  if (!token) return null;
  const [encoded, signature, ...rest] = token.split(".");
  if (!encoded || !signature || rest.length > 0) return null;
  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) return null;
  try {
    const raw: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    const payload = SessionPayloadSchema.parse(raw);
    if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export const WEB_SESSION_COOKIE = "ww_session";
export const WEB_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
