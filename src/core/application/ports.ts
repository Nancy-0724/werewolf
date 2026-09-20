export interface RandomPort {
  readonly algorithmId: string;
  readonly privateSeed: string | null;
  randomInt(exclusiveUpperBound: number): number;
}

export interface ClockPort {
  nowIso(): string;
}

export interface IdPort {
  nextId(): string;
}
