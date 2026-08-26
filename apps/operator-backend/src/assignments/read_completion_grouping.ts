const GENERIC_SELECTOR_TOKENS = new Set(["name", "id", "identity", "value", "key", "label", "number", "code"]);

function selectorTokens(field: string): string[] {
  return field.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean)
    .map(token => token === "families" ? "family" : token === "types" ? "type" : token);
}

function explicitDimension(field: string, requestedDimensions: string[]): string | null {
  const tokens = selectorTokens(field);
  const dimensions = requestedDimensions.filter(dimension => tokens.includes(dimension));
  if (dimensions.length !== 1) return null;
  return tokens.every(token => token === dimensions[0] || GENERIC_SELECTOR_TOKENS.has(token)) ? dimensions[0] : null;
}

function isCanonicalName(field: string): boolean {
  return selectorTokens(field).join(".") === "name";
}

/**
 * Proves that one grouped assertion carries every requested semantic dimension.
 * A result schema may expose its entity type as the canonical `name` beside an
 * explicit `familyName` (or another explicit dimension). In that single,
 * arity-complete case the remaining dimension is deterministic. Multiple
 * generic labels, extra fields, and generic-only groupings remain ambiguous.
 */
export function groupingSelectorsCoverRequestedDimensions(
  fields: string[],
  requestedDimensions: string[]
): boolean {
  if (fields.length !== requestedDimensions.length || requestedDimensions.length < 1) return false;
  const mapped = fields.map(field => explicitDimension(field, requestedDimensions));
  const explicit = mapped.filter((dimension): dimension is string => Boolean(dimension));
  if (new Set(explicit).size !== explicit.length) return false;

  const unresolvedIndexes = mapped.flatMap((dimension, index) => dimension ? [] : [index]);
  const remaining = requestedDimensions.filter(dimension => !explicit.includes(dimension));
  if (unresolvedIndexes.length === 0) return remaining.length === 0;
  if (unresolvedIndexes.length !== 1 || remaining.length !== 1) return false;
  return isCanonicalName(fields[unresolvedIndexes[0]!]);
}
