import { canonicalJsonV2 } from "../domain/assignment-kernel/canonical.js";
import type { OperationV2 } from "../domain/assignment-kernel/operation.js";
import { buildProgressEpochV2 } from "../domain/assignment-kernel/progress/controller.js";

function discoveryIdentity(operation: OperationV2): string | null {
  const route = operation.request_identity?.path ?? operation.input.path;
  if (typeof route !== "string" || !route.startsWith("/revit/")) return null;
  let url: URL;
  try { url = new URL(route, "http://native.invalid"); } catch { return null; }
  let body: unknown = operation.input.body ?? operation.input.arguments ?? operation.input;
  if (typeof body === "string") {
    if (body.length > 100_000) return null;
    try { body = JSON.parse(body); } catch { return null; }
  }
  const fields = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // Only bounded selectors describe new discovery. Diagnostic timestamps,
  // request IDs, signatures, payload hashes and presentation options cannot
  // buy another reasoning turn. Array selectors are sets, not ordering tokens.
  const selectorKeys = ["action", "id", "ids", "elementId", "elementIds", "viewId", "viewIds", "sheetNumber", "sheetNumbers",
    "levelId", "levelIds", "levelName", "levelNames", "nameContains", "category", "categories", "categoryName", "categoryNames",
    "typeId", "typeIds", "typeNameContains", "familyNameContains", "semanticGroups", "parameterNames", "includeTemplates", "offset"];
  const selectors: Record<string, unknown> = {};
  for (const key of selectorKeys) {
    const value = fields[key] ?? url.searchParams.get(key);
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length <= 256 && value.every(item => ["string", "number", "boolean"].includes(typeof item) && String(item).length <= 1000)) {
      selectors[key] = [...new Set(value.map(String))].sort();
    } else if (["string", "number", "boolean"].includes(typeof value) && String(value).length <= 1000) selectors[key] = String(value);
    else return null;
  }
  return canonicalJsonV2({ path: url.pathname,
    target_id: operation.target.target_id ?? null, document: operation.binding.document_fingerprint ?? null, selectors });
}

type HostProgressInput = Omit<Parameters<typeof buildProgressEpochV2>[0], "supporting_discovery_read_identities">;

/** Derive identities exclusively from host-retained operations, never caller maps. */
export function buildHostProgressEpochV2(input: HostProgressInput) {
  const identities = (operations: Readonly<Record<string, OperationV2>>) => Object.fromEntries(
    Object.values(operations).flatMap(operation => {
      const identity = discoveryIdentity(operation);
      return identity === null ? [] : [[operation.operation_id, identity]];
    }));
  return buildProgressEpochV2({ ...input, supporting_discovery_read_identities: {
    before: identities(input.before.operations), after: identities(input.after.operations)
  } });
}
