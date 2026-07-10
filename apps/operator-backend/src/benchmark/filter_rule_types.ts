export type FilterRuleStorageType = "string" | "integer" | "double" | "element_id";

export function textValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function positiveInteger(value: unknown): number | null {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function normalizedFilterParameterName(value: unknown): string {
  return textValue(value).toLowerCase().replace(/\s+/g, " ").trim();
}

export function normalizedFilterRuleStorageType(value: unknown): FilterRuleStorageType | null {
  const normalized = textValue(value).toLowerCase().replace(/[\s-]+/g, "_").trim();
  return normalized === "string" || normalized === "integer" || normalized === "double" || normalized === "element_id"
    ? normalized
    : null;
}

export function filterParameterLooksElementId(value: unknown): boolean {
  const normalized = normalizedFilterParameterName(value);
  return normalized === "system type" ||
    normalized === "family and type" ||
    normalized === "type" ||
    normalized === "type name" ||
    normalized === "workset";
}

export function inferFilterRuleStorageType(parameterName: unknown): FilterRuleStorageType | null {
  const normalized = normalizedFilterParameterName(parameterName);
  if (!normalized) return null;
  if (["comments", "type comments", "description", "mark", "type mark"].includes(normalized)) return "string";
  if (filterParameterLooksElementId(normalized)) return "element_id";
  if (/\b(count|number)\b/.test(normalized)) return "integer";
  if (/\b(length|width|height|area|volume|flow|pressure|velocity|offset|diameter|size)\b/.test(normalized)) return "double";
  return null;
}

export function filterRuleOperatorAllowedForStorageType(storageType: FilterRuleStorageType, operatorValue: unknown): boolean {
  const op = textValue(operatorValue).toLowerCase().replace(/\s+/g, "_").trim() || "equals";
  if (storageType === "element_id") return op === "equals" || op === "not_equals";
  if (storageType === "string") {
    return ["equals", "not_equals", "contains", "not_contains", "begins_with", "ends_with"].includes(op);
  }
  return ["equals", "not_equals", "greater", "greater_or_equal", "less", "less_or_equal"].includes(op);
}
