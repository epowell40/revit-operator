import type { ExistingConditionsElement, ExistingConditionsSnapshot } from "./model_contract.js";

export const UNOBSERVED_DRAWING_ATTRIBUTES = ["family", "type", "size", "parameters", "system_type", "system_classification"] as const;
export type DrawingObservabilityPolicyV1 = {
  schema_version: 1;
  source_evidence_sha256: string;
  elements: Array<{
    key: string;
    existence: "required" | "ambiguous";
    unobserved_attributes: Array<typeof UNOBSERVED_DRAWING_ATTRIBUTES[number]>;
    reason: string;
  }>;
};

export function matchObservableElements<T extends { truth_key: string; candidate_key: string }>(
  truth: ExistingConditionsElement[], candidate: ExistingConditionsElement[], ambiguous: ReadonlySet<string>,
  match: (truth: ExistingConditionsElement[], candidate: ExistingConditionsElement[]) => T[]
): { requiredTruthElements: ExistingConditionsElement[]; requiredPairs: T[]; optionalPairs: T[]; pairs: T[] } {
  const requiredTruthElements = truth.filter(e => !ambiguous.has(e.key));
  const requiredPairs = match(requiredTruthElements, candidate);
  const used = new Set(requiredPairs.map(p => p.candidate_key));
  const optionalPairs = match(truth.filter(e => ambiguous.has(e.key)), candidate.filter(e => !used.has(e.key)));
  return { requiredTruthElements, requiredPairs, optionalPairs, pairs: [...requiredPairs, ...optionalPairs] };
}

export function observableRelationshipSnapshot(
  snapshot: ExistingConditionsSnapshot, ambiguous: ReadonlySet<string>, matched: ReadonlySet<string>
): ExistingConditionsSnapshot {
  const absent = new Set([...ambiguous].filter(key => !matched.has(key)));
  const exposedEnds = snapshot.connections.filter(edge => (edge.kind ?? "physical") === "physical"
    && absent.has(edge.a) !== absent.has(edge.b)).length;
  return {
    ...snapshot,
    elements: snapshot.elements.filter(e => !absent.has(e.key)),
    connections: snapshot.connections.filter(e => !absent.has(e.a) && !absent.has(e.b)),
    open_connector_count: snapshot.open_connector_count + exposedEnds
  };
}

/** Evaluator-owned drawing evidence, never a candidate-provided waiver. Keep
 * native truth intact and project only the fields the source can substantiate. */
export function projectDrawingObservableTruth(
  snapshot: ExistingConditionsSnapshot,
  policy: DrawingObservabilityPolicyV1 | undefined,
  visibleEvidence: readonly { sha256: string }[]
): { elements: ExistingConditionsElement[]; ambiguousKeys: Set<string>; invalidReasons: string[] } {
  const elements = structuredClone(snapshot.elements);
  const ambiguousKeys = new Set<string>();
  const invalidReasons: string[] = [];
  if (!policy) return { elements, ambiguousKeys, invalidReasons };
  if (policy.schema_version !== 1 || !/^[a-f0-9]{64}$/i.test(policy.source_evidence_sha256)
    || !visibleEvidence.some(e => e.sha256.toLowerCase() === policy.source_evidence_sha256.toLowerCase())
    || !Array.isArray(policy.elements)) {
    return { elements, ambiguousKeys, invalidReasons: ["drawing_observability_source_invalid"] };
  }
  const byKey = new Map(elements.map(e => [e.key, e]));
  const seen = new Set<string>();
  for (const rule of policy.elements) {
    const element = byKey.get(rule?.key);
    if (!element || seen.has(rule.key) || !["required", "ambiguous"].includes(rule.existence)
      || typeof rule.reason !== "string" || !rule.reason.trim() || !Array.isArray(rule.unobserved_attributes)
      || rule.unobserved_attributes.some(a => !UNOBSERVED_DRAWING_ATTRIBUTES.includes(a))
      || new Set(rule.unobserved_attributes).size !== rule.unobserved_attributes.length) {
      invalidReasons.push("drawing_observability_element_invalid"); continue;
    }
    seen.add(rule.key);
    if (rule.existence === "ambiguous") {
      // Optional existence is confined to uncertain mechanical symbols. It
      // cannot excuse a missing duct, fitting, wall or complete discipline.
      const physical = snapshot.connections.filter(e => (e.kind ?? "physical") === "physical" && (e.a === rule.key || e.b === rule.key));
      if (element.kind !== "family_instance" || element.discipline !== "mechanical" || physical.length !== 1) {
        invalidReasons.push("drawing_observability_ambiguous_symbol_invalid"); continue;
      }
      ambiguousKeys.add(rule.key);
    }
    for (const field of rule.unobserved_attributes) delete element[field];
  }
  return { elements, ambiguousKeys, invalidReasons: [...new Set(invalidReasons)] };
}
