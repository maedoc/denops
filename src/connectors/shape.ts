import type { JsonValue } from "../harness/types.ts";

// Field selection for list/get results.
//
// An LLM caller pays for every byte it reads, so ops that return upstream
// objects (GitLab projects/issues/MRs, IMAP envelopes) project onto a small
// default field set. Callers can override with `fields: [...]` (dotted paths
// allowed, e.g. "author.username") or opt into the raw object with `full: true`.

export interface ShapeArgs {
  fields?: unknown;
  full?: unknown;
}

const MAX_FIELDS = 24;
const MAX_FIELD_LEN = 100;

export function checkShapeArgs(args: unknown): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const a = args as Record<string, unknown>;
  if (a.fields !== undefined) {
    if (!Array.isArray(a.fields)) return "fields: expected array of strings";
    if (a.fields.length === 0) return "fields: must not be empty";
    if (a.fields.length > MAX_FIELDS) {
      return `fields: too many entries (${a.fields.length} > ${MAX_FIELDS})`;
    }
    for (let i = 0; i < a.fields.length; i++) {
      const f = a.fields[i];
      if (typeof f !== "string" || f.length === 0 || f.length > MAX_FIELD_LEN) {
        return `fields[${i}]: expected a non-empty string (max ${MAX_FIELD_LEN} chars)`;
      }
    }
  }
  if (a.full !== undefined && typeof a.full !== "boolean") return "full: expected boolean";
  return null;
}

// project returns only the requested dotted paths. Paths that cross arrays
// shape each element, so "changes.file" yields one object per change (and two
// sibling paths on the same array merge per element rather than transposing).
export function project(value: JsonValue, fields: string[]): JsonValue {
  const tree = new Map<string, unknown>();
  for (const path of fields) {
    let node = tree;
    const parts = path.split(".");
    for (let i = 0; i < parts.length; i++) {
      const key = parts[i];
      if (i === parts.length - 1) {
        node.set(key, null); // null marks a leaf
        break;
      }
      let child = node.get(key);
      if (!(child instanceof Map)) {
        child = new Map<string, unknown>();
        node.set(key, child);
      }
      node = child as Map<string, unknown>;
    }
  }
  return shapeNode(value, tree) as JsonValue;
}

function shapeNode(value: unknown, tree: Map<string, unknown>): unknown {
  if (Array.isArray(value)) {
    const shaped = value.map((v) => shapeNode(v, tree)).filter((v) => v !== undefined);
    return shaped;
  }
  if (tree.size === 0) return value; // leaf of the field tree: keep as-is
  if (!value || typeof value !== "object") return undefined;
  const out: Record<string, unknown> = {};
  const src = value as Record<string, unknown>;
  for (const [key, child] of tree) {
    if (!(key in src)) continue;
    // null marks a leaf: keep the value as-is
    const picked = child === null ? src[key] : shapeNode(src[key], child as Map<string, unknown>);
    if (picked !== undefined) out[key] = picked;
  }
  return out;
}

// shapeResult applies the caller's choice, then the op's default projection.
export function shapeResult(
  value: JsonValue,
  defaults: string[] | undefined,
  args: ShapeArgs,
): JsonValue {
  if (args.full === true) return value;
  const fields = Array.isArray(args.fields) ? args.fields as string[] : defaults;
  if (!fields) return value;
  return project(value, fields);
}

// wrapClient projects results for every op that has a default field set (or an
// explicit `fields` argument), leaving the rest untouched.
export function wrapClient<S extends string>(
  handlers: Record<S, (a: JsonValue) => Promise<JsonValue>>,
  defaults: Partial<Record<S, string[]>>,
): Record<S, (a: JsonValue) => Promise<JsonValue>> {
  const wrapped = {} as Record<S, (a: JsonValue) => Promise<JsonValue>>;
  for (const op of Object.keys(handlers) as S[]) {
    const fn = handlers[op];
    wrapped[op] = async (a: JsonValue) => {
      const value = await fn(a);
      return shapeResult(value, defaults[op], (a ?? {}) as ShapeArgs);
    };
  }
  return wrapped;
}
