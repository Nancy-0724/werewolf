import { randomInt, randomUUID } from "node:crypto";
import type { ClockPort, IdPort, RandomPort } from "../application/ports.js";

export class NodeCryptoRandom implements RandomPort {
  public readonly algorithmId = "node.crypto.randomInt";
  public readonly privateSeed = null;
  randomInt(exclusiveUpperBound: number): number {
    return randomInt(exclusiveUpperBound);
  }
}

export class SystemClock implements ClockPort {
  nowIso(): string {
    return new Date().toISOString();
  }
}

export class UuidPort implements IdPort {
  nextId(): string {
    return randomUUID();
  }
}
