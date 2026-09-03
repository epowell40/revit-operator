import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import {
  OBSERVATION_V2_SCHEMA,
  OPERATION_RESULT_V2_SCHEMA,
  AssignmentKernelErrorV2,
  canonicalJsonV2,
  normalizeSemanticFactSetV2,
  sameAssignmentBindingV2,
  type AssignmentBindingV2,
  type ObservationV2,
  type ObservationEvidenceClassV2,
  type OperationFulfillmentRoleV2,
  type OperationResultV2,
  type SemanticFactV2
} from "../domain/assignment-kernel/index.js";

type TextContentV2 = Readonly<{ type: "text"; text: string }>;

export type OperationResultTransportV2 =
  | Readonly<{ transport: "direct_native"; operation_result_v2: unknown }>
  | Readonly<{ transport: "typed_mcp" | "generic_mcp"; structured_content: Readonly<{ operation_result_v2: unknown }> }>
  | Readonly<{ transport: "legacy_mcp_text"; content: readonly TextContentV2[] }>
  | Readonly<{ transport: "courier"; completion: Readonly<{ operation_result_v2: unknown }> }>
  | Readonly<{ transport: "dynamic_runtime"; settlement: Readonly<{ operation_result_v2: unknown }> }>;

export type SemanticFactDecoderV2 = (rawPayload: unknown) => readonly SemanticFactV2[];

function adapterAssert(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new AssignmentKernelErrorV2(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseLegacyText(content: readonly TextContentV2[]): unknown {
  adapterAssert(content.length === 1 && content[0]?.type === "text", "operation_result_text_envelope_invalid", "Legacy text transport must contain exactly one JSON text item.");
  let decoded: unknown;
  try {
    decoded = JSON.parse(content[0].text);
  } catch {
    throw new AssignmentKernelErrorV2("operation_result_text_json_invalid", "Legacy text transport is not valid JSON.");
  }
  adapterAssert(isRecord(decoded) && Object.keys(decoded).length === 1 && "operation_result_v2" in decoded, "operation_result_text_shape_invalid", "Legacy text transport must wrap exactly one OperationResultV2.");
  return decoded.operation_result_v2;
}

function transportPayload(envelope: OperationResultTransportV2): unknown {
  switch (envelope.transport) {
    case "direct_native": return envelope.operation_result_v2;
    case "typed_mcp":
    case "generic_mcp": return envelope.structured_content.operation_result_v2;
    case "legacy_mcp_text": return parseLegacyText(envelope.content);
    case "courier": return envelope.completion.operation_result_v2;
    case "dynamic_runtime": return envelope.settlement.operation_result_v2;
  }
}

function validateOperationResultShape(value: unknown): asserts value is OperationResultV2 {
  adapterAssert(isRecord(value), "operation_result_invalid", "Operation result must be an object.");
  adapterAssert(value.schema === OPERATION_RESULT_V2_SCHEMA, "operation_result_schema_invalid", "Operation result schema is not V2.");
  for (const key of ["result_id", "operation_id", "authority", "result_schema_id", "completed_at"] as const) {
    adapterAssert(typeof value[key] === "string" && value[key].length > 0, "operation_result_field_invalid", `Operation result field ${key} is required.`);
  }
  adapterAssert(isRecord(value.binding), "operation_result_binding_invalid", "Operation result binding is required.");
  for (const key of ["assignment_id", "run_id", "session_id", "principal_id"] as const) {
    adapterAssert(typeof value.binding[key] === "string" && value.binding[key].length > 0, "operation_result_binding_invalid", `Operation result binding field ${key} is required.`);
  }
  adapterAssert(Number.isInteger(value.binding.generation) && Number(value.binding.generation) > 0, "operation_result_binding_invalid", "Operation result generation must be a positive integer.");
  adapterAssert(typeof value.observation_required === "boolean", "operation_result_observation_contract_missing", "Operation result must state whether authoritative observation retention is required.");
  adapterAssert(["succeeded", "failed_before_dispatch", "completed_without_native_dispatch", "failed_after_dispatch", "timed_out", "canceled"].includes(String(value.status)), "operation_result_status_invalid", "Operation result status is invalid.");
  adapterAssert(["not_dispatched", "dispatching", "dispatched"].includes(String(value.dispatch_state)), "operation_result_dispatch_invalid", "Operation result dispatch state is invalid.");
  adapterAssert(["none", "unknown", "applied"].includes(String(value.persistent_effect)), "operation_result_effect_invalid", "Operation result effect is invalid.");
  adapterAssert(["not_applicable", "committed", "rolled_back", "unknown"].includes(String(value.native_transaction_state)), "operation_result_transaction_invalid", "Operation result transaction state is invalid.");
  if (value.affected_target_identities !== undefined) {
    adapterAssert(Array.isArray(value.affected_target_identities)
      && value.affected_target_identities.length <= 256
      && value.affected_target_identities.every(identity => typeof identity === "string"
        && identity === identity.trim() && identity.length > 0 && identity.length <= 500
        && !/[\u0000-\u001f\u007f]/.test(identity))
      && new Set(value.affected_target_identities).size === value.affected_target_identities.length
      && value.affected_target_identities.every((identity, index, identities) => index === 0 || identities[index - 1]! < identity),
    "operation_result_affected_targets_invalid", "Operation result affected targets must be a bounded unique ordinal identity set.");
  }
  if (value.observation_required) adapterAssert(typeof value.raw_payload_hash === "string" && value.raw_payload_hash.length > 0, "operation_result_payload_hash_missing", "Observation-bearing result requires a raw payload hash.");
  if (value.input_schema_gap !== undefined) {
    adapterAssert(isRecord(value.input_schema_gap), "operation_input_schema_gap_invalid", "Input-schema gap must be structured.");
    const gap = value.input_schema_gap;
    adapterAssert(gap.schema === "revit-operator.operation-input-schema-gap/v2"
      && gap.operation_id === value.operation_id
      && typeof gap.input_schema_digest === "string" && /^[a-f0-9]{64}$/.test(gap.input_schema_digest)
      && (gap.method === "GET" || gap.method === "POST") && typeof gap.path === "string"
      && typeof gap.request_signature === "string" && gap.request_signature.length > 0
      && gap.dispatch === false && gap.effect === "none"
      && Array.isArray(gap.issues) && gap.issues.length > 0,
    "operation_input_schema_gap_invalid", "Input-schema gap must bind to the no-effect operation result.");
  }
}

export function unwrapOperationResultV2(envelope: OperationResultTransportV2): OperationResultV2 {
  const result = transportPayload(envelope);
  validateOperationResultShape(result);
  return structuredClone(result);
}

export function canonicalPayloadHashV2(rawPayload: unknown): string {
  return payloadDigestV2(rawPayload).digest;
}

function normalizedSourceField(value: string): string {
  return value.normalize("NFKC").replace(/[\s_-]+/g, "").toLowerCase();
}

export function readAliasedSourceFieldV2(
  rawPayload: unknown,
  canonicalField: string,
  aliases: readonly string[] = []
): unknown {
  adapterAssert(isRecord(rawPayload), "semantic_source_not_object", "Semantic decoder source must be an object.");
  const accepted = new Set([canonicalField, ...aliases].map(normalizedSourceField));
  const matches = Object.entries(rawPayload).filter(([key]) => accepted.has(normalizedSourceField(key)));
  adapterAssert(matches.length > 0, "semantic_source_field_missing", `Semantic source field ${canonicalField} is missing.`);
  const canonicalValues = new Set(matches.map(([, value]) => canonicalJsonV2(value)));
  adapterAssert(canonicalValues.size === 1, "semantic_source_field_conflict", `Semantic source aliases for ${canonicalField} disagree.`);
  return structuredClone(matches[0][1]);
}

export class ObservationDecoderRegistryV2 {
  readonly #decoders = new Map<string, SemanticFactDecoderV2>();

  register(resultSchemaId: string, decoder: SemanticFactDecoderV2): void {
    adapterAssert(resultSchemaId.length > 0 && !this.#decoders.has(resultSchemaId), "observation_decoder_duplicate", "Result schema decoder must be unique.");
    this.#decoders.set(resultSchemaId, decoder);
  }

  decode(resultSchemaId: string, rawPayload: unknown): readonly SemanticFactV2[] {
    const decoder = this.#decoders.get(resultSchemaId);
    adapterAssert(decoder, "observation_decoder_missing", `No semantic decoder is registered for ${resultSchemaId}.`);
    return structuredClone(normalizeSemanticFactSetV2(decoder(structuredClone(rawPayload))));
  }
}

export function observationFromOperationResultV2(input: Readonly<{
  result: OperationResultV2;
  expected_binding: AssignmentBindingV2;
  observation_id: string;
  raw_payload_ref: string;
  raw_payload: unknown;
  target_scope?: Readonly<Record<string, string | number | boolean | null>>;
  verification_relevance?: readonly string[];
  fulfillment_role?: OperationFulfillmentRoleV2;
  evidence_class?: ObservationEvidenceClassV2;
  capability_id?: string;
  eligible_criterion_ids?: readonly string[];
  registry: ObservationDecoderRegistryV2;
}>): ObservationV2 {
  adapterAssert(input.result.observation_required, "operation_result_observation_not_required", "An observation cannot be synthesized for a result that does not require one.");
  adapterAssert(sameAssignmentBindingV2(input.result.binding, input.expected_binding), "observation_result_binding_invalid", "Result is outside the expected Assignment scope.");
  const payloadHash = canonicalPayloadHashV2(input.raw_payload);
  adapterAssert(input.result.raw_payload_hash === payloadHash, "observation_payload_hash_mismatch", "Raw payload does not match the native result hash.");
  return {
    schema: OBSERVATION_V2_SCHEMA,
    observation_id: input.observation_id,
    operation_id: input.result.operation_id,
    ...(input.fulfillment_role ? { fulfillment_role: input.fulfillment_role } : {}),
    ...(input.evidence_class ? { evidence_class: input.evidence_class } : {}),
    ...(input.capability_id ? { capability_id: input.capability_id } : {}),
    ...(input.eligible_criterion_ids ? { eligible_criterion_ids: [...input.eligible_criterion_ids] } : {}),
    binding: structuredClone(input.expected_binding),
    authority: input.result.authority,
    result_schema_id: input.result.result_schema_id,
    raw_payload_ref: input.raw_payload_ref,
    raw_payload_hash: payloadHash,
    ...(input.result.payload_provenance
      ? { payload_provenance: structuredClone(input.result.payload_provenance) }
      : {}),
    facts: input.registry.decode(input.result.result_schema_id, input.raw_payload),
    target_scope: structuredClone(input.target_scope ?? {}),
    observed_at: input.result.completed_at,
    verification_relevance: structuredClone(input.verification_relevance ?? [])
  };
}
