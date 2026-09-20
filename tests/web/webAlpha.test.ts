import { describe, expect, it, vi } from "vitest";
import { WebActionRequestSchema } from "../../src/web/shared/actionRequest.js";
import { CreateWebGameInputSchema, createWebGame } from "../../src/web/server/gameApp.js";
import { createWebSessionToken, verifyWebSessionToken } from "../../src/web/server/session.js";

describe("Web Alpha contracts", () => {
  it("W01 validates create-game input", () => {
    expect(CreateWebGameInputSchema.parse({ displayName: "Nancy", seatNumber: 7 })).toEqual({ displayName: "Nancy", seatNumber: 7 });
  });

  it("W02 rejects invalid human seat", () => {
    expect(() => CreateWebGameInputSchema.parse({ displayName: "Nancy", seatNumber: 13 })).toThrow();
  });

  it("W03 accepts a legal target-style action request", () => {
    expect(WebActionRequestSchema.parse({ commandType: "CommitSeerAction", targetPlayerId: "p2" }).commandType).toBe("CommitSeerAction");
  });

  it("W04 accepts witch pass without a target", () => {
    expect(WebActionRequestSchema.parse({ commandType: "CommitWitchAction", action: "PASS", targetPlayerId: null })).toEqual({ commandType: "CommitWitchAction", action: "PASS", targetPlayerId: null });
  });

  it("W05 rejects unknown browser command types", () => {
    expect(() => WebActionRequestSchema.parse({ commandType: "RevealAllRoles" })).toThrow();
  });

  it("W06 signs and verifies anonymous game sessions", () => {
    vi.stubEnv("WEB_SESSION_SECRET", "web-alpha-test-secret");
    const token = createWebSessionToken("g1", "p1", 60);
    expect(verifyWebSessionToken(token)).toMatchObject({ gameId: "g1", playerId: "p1", v: 1 });
    vi.unstubAllEnvs();
  });

  it("W07 rejects tampered game-session cookies", () => {
    vi.stubEnv("WEB_SESSION_SECRET", "web-alpha-test-secret");
    const token = createWebSessionToken("g1", "p1", 60);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    expect(verifyWebSessionToken(tampered)).toBeNull();
    vi.unstubAllEnvs();
  });

  it("W08 creates a 1-human + 11-NPC game and advances to a human decision point", async () => {
    const created = await createWebGame({ displayName: "Human", seatNumber: 1 });
    expect(created.envelope.storageMode).toBe("MEMORY_DEMO");
    expect(created.envelope.view.public.seats).toHaveLength(12);
    expect(created.envelope.view.viewer.displayName).toBe("Human");
    expect(created.envelope.view.public.seats.filter((seat) => seat.controllerType === "HUMAN")).toHaveLength(1);
    expect(created.envelope.view.availableActions.length).toBeGreaterThan(0);
  });
});
