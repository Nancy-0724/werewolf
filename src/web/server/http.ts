import { ZodError } from "zod";
import { CoreError } from "../../core/domain/errors.js";

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export function apiError(error: unknown): { status: number; body: ApiErrorBody } {
  if (error instanceof CoreError) {
    const status = error.code === "UNAUTHORIZED" ? 401 : error.code === "GAME_NOT_FOUND" ? 404 : error.code === "CONCURRENCY_CONFLICT" ? 409 : 400;
    return { status, body: { error: { code: error.code, message: error.message } } };
  }
  if (error instanceof ZodError) return { status: 400, body: { error: { code: "INVALID_INPUT", message: error.issues[0]?.message ?? "Invalid request" } } };
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : "Unexpected server error" } } };
}
