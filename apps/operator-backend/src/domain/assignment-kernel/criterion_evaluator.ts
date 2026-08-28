import { canonicalJsonV2 } from "./canonical.js";
import type { CriterionEvaluationV2 } from "./criteria.js";
import { kernelAssertV2 } from "./errors.js";
import type { ObservationIdV2 } from "./identity.js";
import { semanticFactIdentityV2, type SemanticFactV2 } from "./observation.js";
import { observationAdmissibilityForCriterionV2 } from "./semantic_admissibility.js";
import type { AssignmentSnapshotV2 } from "./snapshot.js";

function comparisonIdentity(comparison: Readonly<{ fact_id: string; dimensions?: Readonly<Record<string, string | number | boolean | null>>; target_id?: string }>): string {
  return semanticFactIdentityV2({ fact_id: comparison.fact_id, value: null, dimensions: comparison.dimensions, target_id: comparison.target_id });
}

export function evaluateCriterionV2(input: Readonly<{
  snapshot: AssignmentSnapshotV2;
  criterion_id: string;
  observation_ids: readonly ObservationIdV2[];
  evaluator_authority: string;
  evaluated_at: string;
  basis?: "observation" | "desired_state_equivalence";
}>): CriterionEvaluationV2 {
  const criterion = input.snapshot.spec.criteria.find((candidate) => candidate.criterion_id === input.criterion_id);
  kernelAssertV2(criterion, "criterion_unknown", "Criterion is not in AssignmentSpecV2.");
  kernelAssertV2(criterion.accepted_evaluator_authority_ids.includes(input.evaluator_authority), "criterion_evaluator_untrusted", "Criterion evaluator authority is not admitted by AssignmentSpecV2.");
  const proposedObservations = input.observation_ids.map((observationId) => {
    const observation = input.snapshot.observations[observationId];
    kernelAssertV2(observation, "criterion_observation_unknown", "Criterion evaluator received an unknown observation.");
    return observation;
  });
  const basis = input.basis ?? "observation";
  const admissions = proposedObservations.map((observation) => ({
    observation,
    admission: observationAdmissibilityForCriterionV2({
      snapshot: input.snapshot,
      criterion,
      observation,
      evaluated_at: input.evaluated_at,
      basis
    })
  })).filter(({ admission }) => admission.admissible);
  const observations = admissions.map(({ observation }) => observation);
  const facts = admissions.flatMap(({ observation, admission }) =>
    admission.supporting_facts.map((fact) => ({ observation, fact })));
  const byIdentity = new Map<string, string>();
  let contradiction = false;
  for (const { fact } of facts) {
    const identity = semanticFactIdentityV2(fact);
    const value = canonicalJsonV2(fact.value);
    const previous = byIdentity.get(identity);
    if (previous !== undefined && previous !== value) contradiction = true;
    byIdentity.set(identity, value);
  }

  const requiredFactsPresent = criterion.semantic_fact_requirements.every((required) => facts.some(({ fact }) => fact.fact_id === required));
  let desiredStateMatches = true;
  if (basis === "desired_state_equivalence") {
    const comparisons = criterion.desired_state_comparisons ?? [];
    kernelAssertV2(comparisons.length > 0, "criterion_desired_state_contract_missing", "Desired-state evaluation requires semantic comparisons in AssignmentSpecV2.");
    desiredStateMatches = comparisons.every((comparison) => {
      if (!Object.prototype.hasOwnProperty.call(input.snapshot.input_values, comparison.input_variable_id)) return false;
      const expected = canonicalJsonV2(input.snapshot.input_values[comparison.input_variable_id]);
      return byIdentity.get(comparisonIdentity(comparison)) === expected;
    });
  }

  const status = contradiction ? "uncertain" : requiredFactsPresent && desiredStateMatches ? "pass" : "uncertain";
  return {
    criterion_id: criterion.criterion_id,
    status,
    basis,
    supporting_operation_ids: [...new Set(observations.map((observation) => observation.operation_id))].sort(),
    supporting_facts: facts
      .filter(({ fact }) => criterion.semantic_fact_requirements.includes(fact.fact_id))
      .map(({ observation, fact }) => ({ observation_id: observation.observation_id, fact_id: fact.fact_id })),
    evaluator_authority: input.evaluator_authority,
    reason: contradiction
      ? "Authoritative observations disagree for the same semantic fact identity."
      : observations.length === 0
        ? "No Observation satisfies the criterion's typed evidence-admissibility policy."
        : !requiredFactsPresent
          ? "One or more required semantic facts are absent."
          : !desiredStateMatches
            ? "Observed state does not establish the authenticated desired state."
            : "All required semantic facts are authoritatively supported.",
    evaluated_at: input.evaluated_at
  };
}
