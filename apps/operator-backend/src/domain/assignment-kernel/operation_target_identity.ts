import type { OperationV2 } from "./operation.js";

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Native settlement identities preserve their source vocabulary (for example
 * `element_id:42`), while controller requests use `id:42`. Revit numeric
 * ElementIds are document-global, so these reviewed aliases may bind without
 * relabeling or copying the native result payload.
 */
export function operationTargetIdentityAliasesV2(value: unknown): readonly string[] {
  if (typeof value !== "string") return [];
  const identity = value.trim().toLowerCase();
  if (!identity || identity.length > 500 || /[\u0000-\u001f\u007f]/.test(identity)) return [];
  const aliases = new Set([identity]);
  const separator = identity.indexOf(":");
  if (separator > 0) {
    const kind = identity.slice(0, separator).replace(/[^a-z0-9]/g, "");
    const identifier = identity.slice(separator + 1);
    if ((kind === "id" || kind.endsWith("id")) && /^\d+$/.test(identifier)) {
      aliases.add(`id:${identifier}`);
    }
  }
  return [...aliases].sort(ordinal);
}

export function effectiveOperationTargetIdentitiesV2(operation: Pick<OperationV2, "target" | "result">): readonly string[] {
  const identities = [operation.target.target_id, ...(operation.result?.affected_target_identities ?? [])];
  return [...new Set(identities.flatMap(operationTargetIdentityAliasesV2))].sort(ordinal);
}

function exactOperationTargetIdentitiesV2(operation: Pick<OperationV2, "target" | "result">): readonly string[] {
  return [...new Set([
    operation.target.target_id,
    ...Object.values(operation.target.semantic_scope ?? {}),
    ...(operation.result?.affected_target_identities ?? [])
  ].filter((value): value is string => typeof value === "string" && value.length > 0))].sort(ordinal);
}

/** Exact admitted and native-reported identities for durable result projections. */
export function reportedOperationTargetIdentitiesV2(operation: Pick<OperationV2, "target" | "result">): readonly string[] {
  return exactOperationTargetIdentitiesV2(operation);
}

/**
 * Prefer the native result's exact affected set. The admitted target fallback
 * exists only for historical V2 results that predate the affected-target field;
 * an explicitly empty native set is never replaced with inferred identities.
 */
export function affectedOperationTargetIdentitiesV2(
  operation: Pick<OperationV2, "target" | "result" | "persistent_effect">
): readonly string[] {
  if (operation.result?.affected_target_identities !== undefined) {
    return [...operation.result.affected_target_identities];
  }
  if (operation.persistent_effect !== "applied") return [];
  return [...new Set([
    operation.target.target_id,
    ...Object.values(operation.target.semantic_scope ?? {})
  ].filter((value): value is string => typeof value === "string" && value.length > 0))].sort(ordinal);
}

export function operationMatchesTargetIdentityV2(
  operation: Pick<OperationV2, "target" | "result">,
  candidateIdentities: readonly string[]
): boolean {
  const candidates = new Set(candidateIdentities.flatMap(operationTargetIdentityAliasesV2));
  return effectiveOperationTargetIdentitiesV2(operation).some(identity => candidates.has(identity));
}
