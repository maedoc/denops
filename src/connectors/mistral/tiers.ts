import type { JsonValue } from "../../harness/types.ts";

// Write ops on pre-existing libraries are approval-tier; the same run may write
// freely into a library it created (mirroring documents.delete). Set
// connectors.mistral.allowOpenUploads: true to keep uploads open everywhere.
const RUN_SCOPED_WRITES = new Set([
  "mistral.documents.put",
  "mistral.documents.upload",
  "mistral.documents.replace",
]);

export interface RunLibraryState {
  createdLibraryIds: Set<string>;
}

export function mistralTierOverride(
  op: string,
  args: JsonValue,
  runState: RunLibraryState,
  opts: { allowOpenUploads?: boolean } = {},
): "open" | "approval" | null {
  if (!RUN_SCOPED_WRITES.has(op)) return null;
  if (opts.allowOpenUploads) return "open";
  const libraryId = String((args as { libraryId?: unknown }).libraryId ?? "");
  if (libraryId && runState.createdLibraryIds.has(libraryId)) return "open";
  return null; // fall back to the op's declared tier (approval)
}
