import {
  evaluateGeneralRevitCapabilityAttempt,
  generalRevitExecutionCase,
  type GeneralRevitAttempt,
  type GeneralRevitCapabilityCase
} from "./general_revit_capability_acceptance.js";
import {
  aggregateModelCallReceipts,
  modelCallReceiptsFromSources
} from "./general_revit_model_telemetry.js";
import {
  benchmarkInteractionResultPatternsV1,
  type BenchmarkInteractionCaseV1
} from "./protocol_v2_interaction.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

/** Adds only evaluator-declared, candidate-visible interaction values to result assertions. */
export function generalRevitExecutionCaseWithInteractionV1(
  testCase: GeneralRevitCapabilityCase,
  applyRequested: boolean,
  interaction: BenchmarkInteractionCaseV1 | null
): GeneralRevitCapabilityCase {
  const base = generalRevitExecutionCase(testCase, applyRequested);
  const requiredPatterns = interaction ? benchmarkInteractionResultPatternsV1(interaction) : [];
  return requiredPatterns.length > 0 ? {
    ...base,
    answer_assertions: {
      ...base.answer_assertions,
      must_match: [...(base.answer_assertions?.must_match ?? []), ...requiredPatterns]
    }
  } : base;
}

/** Re-evaluates a retained interaction flight under the same value-bound live contract. */
export function rescoreGeneralRevitInteractionTraceV1(
  trace: JsonRecord,
  testCase: GeneralRevitCapabilityCase,
  applyRequested: boolean,
  interaction: BenchmarkInteractionCaseV1 | null
): JsonRecord {
  const toolResults = record(trace.tool_results);
  const rawAttempt = record(toolResults.raw_sidecar_response);
  if (Object.keys(rawAttempt).length === 0) return trace;
  const executionCase = generalRevitExecutionCaseWithInteractionV1(testCase, applyRequested, interaction);
  const evaluation = evaluateGeneralRevitCapabilityAttempt(executionCase, {
    ...rawAttempt,
    assignment_projection: record(toolResults.durable_assignment_projection)
  } as GeneralRevitAttempt);
  const modelCallReceipts = modelCallReceiptsFromSources(rawAttempt, rawAttempt.computer_state, trace);
  const modelCallSummary = aggregateModelCallReceipts(modelCallReceipts);
  return {
    ...trace,
    model_call_receipts: modelCallReceipts,
    efficiency: {
      ...record(trace.efficiency),
      token_count: modelCallSummary.total_tokens,
      model_call_summary: modelCallSummary
    },
    verification_results: { ...record(trace.verification_results), evaluation },
    success_failure_score: {
      tier: evaluation.tier,
      non_refusal: evaluation.non_refusal,
      completed: evaluation.completed,
      verified: evaluation.verified
    },
    rescored_from_flight_record: true
  };
}
