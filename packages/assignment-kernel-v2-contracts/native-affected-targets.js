// Native operations may create many dependent styles/types (CAD links and
// family loads, for example). This bounds receipt cardinality, not the number
// of requested actions or verified deliverables. Transport byte caps still apply.
export const MAX_NATIVE_AFFECTED_TARGETS_V2 = 4096;
export function isNativeAffectedTargetIdentityV2(value) {
  return typeof value === "string" && value === value.trim() && value.length > 0 && value.length <= 500
    && !/[\u0000-\u001f\u007f]/.test(value);
}
export function isCanonicalNativeAffectedTargetSetV2(value) {
  return Array.isArray(value) && value.length <= MAX_NATIVE_AFFECTED_TARGETS_V2
    && value.every(isNativeAffectedTargetIdentityV2)
    && value.every((identity, index) => index === 0 || value[index - 1] < identity);
}
