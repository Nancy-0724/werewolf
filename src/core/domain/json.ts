import { CoreError } from "./errors.js";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export function cloneJson<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) {
    throw new CoreError("INVALID_INPUT", "Value is not JSON serializable");
  }
  return JSON.parse(text) as T;
}

function assertJsonInner(value: unknown, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CoreError("INVALID_INPUT", `Non-finite number at ${path}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonInner(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new CoreError("INVALID_INPUT", `Non-plain JSON object at ${path}`);
    }
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined || typeof item === "function") {
        throw new CoreError("INVALID_INPUT", `Non-JSON value at ${path}.${key}`);
      }
      assertJsonInner(item, `${path}.${key}`);
    }
    return;
  }
  throw new CoreError("INVALID_INPUT", `Non-JSON value at ${path}`);
}

export function assertJsonSerializable(value: unknown): void {
  assertJsonInner(value, "$");
}

export function stableStringify(value: unknown): string {
  assertJsonSerializable(value);
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input !== null && typeof input === "object") {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(input).sort()) {
        out[key] = normalize((input as Record<string, unknown>)[key]);
      }
      return out;
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
