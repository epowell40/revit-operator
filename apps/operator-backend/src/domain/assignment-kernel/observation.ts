import type {
  AssignmentBindingV2,
  ObservationIdV2,
  OperationIdV2,
  SemanticFactIdV2
} from "./identity.js";
import { canonicalJsonV2 } from "./canonical.js";
import type { PayloadProvenanceV2 } from "./payload_provenance.js";
import type {
  ObservationEvidenceClassV2,
  OperationFulfillmentRoleV2,
  SemanticFactClassV2
} from "./semantic_admissibility.js";

export const OBSERVATION_V2_SCHEMA = "revit-operator.observation/v2" as const;

export type SemanticFactScalarV2 = string | number | boolean | null;
export type SemanticFactCardinalityV2 = "one" | "many";

export interface SemanticFactV2 {
  fact_id: SemanticFactIdV2;
  fact_class?: SemanticFactClassV2;
  value: SemanticFactScalarV2 | readonly SemanticFactScalarV2[];
  cardinality?: SemanticFactCardinalityV2;
  dimensions?: Readonly<Record<string, SemanticFactScalarV2>>;
  identity_dimensions?: readonly string[];
  unit?: string;
  target_id?: string;
}

export function semanticFactIdentityV2(fact: SemanticFactV2): string {
  const cardinality = fact.cardinality ?? "one";
  const dimensions = fact.dimensions ?? {};
  const identityDimensions = cardinality === "many"
    ? [...(fact.identity_dimensions ?? Object.keys(dimensions))].sort()
    : Object.keys(dimensions).sort();
  const selectedDimensions = Object.fromEntries(identityDimensions.map((key) => [key, dimensions[key] ?? null]));
  return canonicalJsonV2({
    fact_id: fact.fact_id,
    cardinality,
    dimensions: selectedDimensions,
    target_id: fact.target_id ?? null,
    member_value: cardinality === "many" && identityDimensions.length === 0 ? fact.value : undefined
  });
}

export function normalizeSemanticFactSetV2(facts: readonly SemanticFactV2[]): readonly SemanticFactV2[] {
  const exact = new Set<string>();
  const normalized: SemanticFactV2[] = [];
  for (const fact of facts) {
    const copy = structuredClone(fact);
    const key = canonicalJsonV2({ identity: semanticFactIdentityV2(copy), value: copy.value, unit: copy.unit ?? null });
    if (exact.has(key)) continue;
    exact.add(key);
    normalized.push(copy);
  }
  return normalized;
}

export interface ObservationV2 {
  schema: typeof OBSERVATION_V2_SCHEMA;
  observation_id: ObservationIdV2;
  operation_id: OperationIdV2;
  fulfillment_role?: OperationFulfillmentRoleV2;
  evidence_class?: ObservationEvidenceClassV2;
  capability_id?: string;
  eligible_criterion_ids?: readonly string[];
  binding: AssignmentBindingV2;
  authority: string;
  result_schema_id: string;
  raw_payload_ref: string;
  raw_payload_hash: string;
  payload_provenance?: PayloadProvenanceV2;
  facts: readonly SemanticFactV2[];
  target_scope: Readonly<Record<string, string | number | boolean | null>>;
  observed_at: string;
  freshness_deadline?: string;
  before_observation_id?: ObservationIdV2;
  after_observation_id?: ObservationIdV2;
  verification_relevance: readonly string[];
}
