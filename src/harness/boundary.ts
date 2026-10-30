import type { JsonValue, OpResult, OpSpec } from "./types.ts";

export class BoundaryError extends Error {}

export function validateArgs(spec: OpSpec, args: unknown): string | null {
  return spec.argSchema(args);
}

export function serializedSize(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v) ?? "").length;
}

export function opResultToJson(r: OpResult): JsonValue {
  return r.ok ? (r.result ?? null) : { __opError: r.error ?? "unknown error" };
}
