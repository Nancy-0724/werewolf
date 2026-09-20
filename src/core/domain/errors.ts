export const ERROR_CODES = [
  "INVALID_INPUT",
  "UNAUTHORIZED",
  "GAME_NOT_FOUND",
  "GAME_ALREADY_EXISTS",
  "INVALID_SEATS",
  "UNSUPPORTED_RULESET",
  "GAME_ALREADY_LOCKED",
  "GAME_NOT_LOCKED",
  "GAME_ALREADY_STARTED",
  "INVALID_PHASE",
  "INVALID_WINDOW_TOKEN",
  "INELIGIBLE_ACTOR",
  "ACTION_ALREADY_COMMITTED",
  "INVALID_TARGET",
  "ABILITY_RESOURCE_UNAVAILABLE",
  "GAME_ABORTED",
  "COMMAND_ID_REUSED",
  "CONCURRENCY_CONFLICT",
  "INVALID_EVENT_STREAM",
  "UNSUPPORTED_EVENT_VERSION",
  "INVALID_RANDOM_SOURCE",
  "INVALID_SNAPSHOT",
  "UNSUPPORTED_ENGINE_VERSION",
  "PERSISTENCE_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class CoreError extends Error {
  public readonly code: ErrorCode;

  public constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "CoreError";
    this.code = code;
  }
}

export function fail(code: ErrorCode, message: string): never {
  throw new CoreError(code, message);
}
