export * from "./native-parameter-checks.js";
import { parseProviderUsageHoldV1 } from "./provider-usage-hold.js";
export * from "./provider-usage-hold.js";
export * from "./native-artifact.js";
export * from "./native-completion.js";
export * from "./input-schema-gap.js";
export * from "./native-affected-targets.js";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA = "revit-operator.assignment-kernel-session-index/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA = "revit-operator.assignment-kernel-session-index-response/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD = "assignment_kernel_v2_session_index";
export const ASSIGNMENT_SNAPSHOT_V2_SCHEMA = "revit-operator.assignment-snapshot/v2";
export const ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA = "revit-operator.assignment-kernel-publication/v2";
export const ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA = "revit-operator.assignment-provider-ledger/v2";
export const ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA = "revit-operator.provider-call/v2";
export const ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA = "revit-operator.assignment-execution-failure/v2";
export const OPERATION_RESULT_SEMANTIC_GAP_V2_SCHEMA = "revit-operator.operation-result-semantic-gap/v2";
export const ASSIGNMENT_KERNEL_RUNTIME_ATTESTATION_V2_SCHEMA = "revit-operator.assignment-kernel-runtime-attestation/v2";
export const ASSIGNMENT_KERNEL_SEMANTIC_EVIDENCE_POLICY_V2 = "typed-deny-by-default/v2";

const PROVIDER_CALL_STATES_V2 = new Set([
  "admitted",
  "dispatched",
  "response_started",
  "usage_received",
  "completed",
  "response_transport_completed"
]);
const PROVIDER_ERROR_CLASSES_V2 = new Set(["provider", "transport", "canceled", "resource_exhausted"]);
const EXECUTION_FAILURE_CLASSES_V2 = new Set(["provider", "transport", "runtime", "canceled", "resource_exhausted"]);
const EXECUTION_FAILURE_PHASES_V2 = new Set([
  "request_validation",
  "runtime_setup",
  "provider_start",
  "provider_turn",
  "response_handoff"
]);
const EXECUTION_FAILURE_CODES_V2 = Object.freeze({
  provider: "provider_execution_failed",
  transport: "provider_transport_failed",
  runtime: "assignment_runtime_failed",
  canceled: "execution_canceled",
  resource_exhausted: "provider_resource_exhausted"
});

export function isTerminalProviderCallStateV2(value) {
  return value === "completed" || value === "response_transport_completed";
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function invalid(reason) {
  throw new TypeError(`assignment_kernel_v2_session_index_invalid:${reason}`);
}

function publicationInvalid(reason) {
  throw new TypeError(`assignment_kernel_v2_publication_invalid:${reason}`);
}

function runtimeAttestationInvalid(reason) {
  throw new TypeError(`assignment_kernel_v2_runtime_attestation_invalid:${reason}`);
}

function requiredString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function requiredStringArray(value) {
  if (!Array.isArray(value)) return null;
  const values = value.map(requiredString);
  if (values.some((entry) => entry === null)) return null;
  return values;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  const leftRecord = record(left);
  const rightRecord = record(right);
  if (!leftRecord || !rightRecord) return false;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return sameStrings(leftKeys, rightKeys)
    && leftKeys.every((key) => sameJsonValue(leftRecord[key], rightRecord[key]));
}

function sameAssignmentBinding(leftValue, right) {
  const left = record(leftValue);
  return Boolean(left)
    && left.assignment_id === right.assignment_id
    && left.run_id === right.run_id
    && left.generation === right.generation
    && left.session_id === right.session_id
    && left.principal_id === right.principal_id
    && (left.document_fingerprint ?? null) === (right.document_fingerprint ?? null);
}

/**
 * Publishes the effective lifecycle configuration of the running backend. This
 * is intentionally a small behavioral contract rather than a copy of process
 * environment variables: qualification consumers need to prove which runtime
 * owns canonical state, progression, publication, and evidence admission.
 */
export function assignmentKernelRuntimeAttestationV2(enabledValue) {
  const enabled = enabledValue === true;
  return Object.freeze({
    schema: ASSIGNMENT_KERNEL_RUNTIME_ATTESTATION_V2_SCHEMA,
    assignment_kernel_v2_enabled: enabled,
    lifecycle_owner: enabled ? "assignment_kernel_v2" : "legacy_goal_v1",
    progress_owner: enabled ? "deterministic_progress_controller_v2" : "legacy_agent_loop_v1",
    session_index_response_schema: enabled ? ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA : null,
    exact_publication_schema: enabled ? ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA : null,
    provider_ledger_schema: enabled ? ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA : null,
    semantic_evidence_policy: enabled ? ASSIGNMENT_KERNEL_SEMANTIC_EVIDENCE_POLICY_V2 : null
  });
}

export function parseAssignmentKernelRuntimeAttestationV2(value) {
  const attestation = record(value);
  if (!attestation || attestation.schema !== ASSIGNMENT_KERNEL_RUNTIME_ATTESTATION_V2_SCHEMA) {
    runtimeAttestationInvalid("schema");
  }
  const keys = Object.keys(attestation).sort();
  const expectedKeys = Object.keys(assignmentKernelRuntimeAttestationV2(true)).sort();
  if (!sameStrings(keys, expectedKeys)) runtimeAttestationInvalid("fields");
  if (typeof attestation.assignment_kernel_v2_enabled !== "boolean") {
    runtimeAttestationInvalid("enabled");
  }
  const expected = assignmentKernelRuntimeAttestationV2(attestation.assignment_kernel_v2_enabled);
  if (!sameJsonValue(attestation, expected)) runtimeAttestationInvalid("coherence");
  return structuredClone(attestation);
}

function validOptionalTimestamp(value) {
  return value === undefined || requiredString(value) !== null;
}

function validOptionalNonNegativeInteger(value) {
  return value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validOptionalNonNegativeNumber(value) {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validUpstreamProviderReceipt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const bounded = v => typeof v === "string" && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f]/.test(v);
  return value.route === "desktop_computer" && bounded(value.call_id) && bounded(value.model)
    && bounded(value.requested_model) && bounded(value.started_at_utc) && Number.isFinite(Date.parse(value.started_at_utc))
    && (value.duration_ms === null || Number.isSafeInteger(value.duration_ms) && value.duration_ms >= 0);
}

function validProviderUsage(value) {
  if (value === undefined) return true;
  const usage = record(value);
  return Boolean(usage)
    && validOptionalNonNegativeInteger(usage.input_tokens)
    && validOptionalNonNegativeInteger(usage.cached_input_tokens)
    && validOptionalNonNegativeInteger(usage.cache_write_input_tokens)
    && (usage.input_tokens == null || (usage.cached_input_tokens ?? 0) + (usage.cache_write_input_tokens ?? 0) <= usage.input_tokens)
    && validOptionalNonNegativeInteger(usage.output_tokens)
    && validOptionalNonNegativeInteger(usage.reasoning_tokens)
    && validOptionalNonNegativeInteger(usage.total_tokens)
    && validOptionalNonNegativeNumber(usage.estimated_cost_usd);
}

export function parseAssignmentKernelSessionIndexV2(value) {
  const index = record(value);
  if (!index || index.schema !== ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA) invalid("schema");
  if (typeof index.session_id !== "string" || !Array.isArray(index.assignments)) invalid("shape");
  for (const entryValue of index.assignments) {
    const entry = record(entryValue);
    const binding = record(entry?.binding);
    if (!entry || typeof entry.assignment_id !== "string" || !entry.assignment_id
        || !Number.isSafeInteger(entry.assignment_version) || entry.assignment_version < 1
        || typeof entry.outcome !== "string" || typeof entry.terminal !== "boolean"
        || !binding || binding.assignment_id !== entry.assignment_id
        || binding.session_id !== index.session_id || typeof binding.run_id !== "string"
        || !Number.isSafeInteger(binding.generation) || binding.generation < 1
        || typeof binding.principal_id !== "string") invalid("entry");
  }
  return structuredClone(index);
}

export function assignmentKernelSessionIndexResponseV2(indexValue) {
  const index = parseAssignmentKernelSessionIndexV2(indexValue);
  return {
    schema: ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
    ok: true,
    [ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD]: index
  };
}

export function parseAssignmentKernelSessionIndexResponseV2(value) {
  const response = record(value);
  if (!response || response.schema !== ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA
      || response.ok !== true) invalid("response_schema");
  const keys = Object.keys(response).sort();
  const expected = ["schema", "ok", ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) invalid("response_fields");
  return {
    schema: ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA,
    ok: true,
    [ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD]: parseAssignmentKernelSessionIndexV2(response[ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD])
  };
}

/**
 * Validates the exact-ID V2 publication shared by backend, Sidecar, recovery,
 * benchmark, Work Packet, and Protocol V2 consumers. This checks envelope and
 * provider-ledger coherence without reconstructing canonical Assignment truth.
 */
export function parseAssignmentKernelPublicationV2(value) {
  const publication = record(value);
  if (!publication || publication.schema !== ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA) publicationInvalid("schema");
  const assignmentId = requiredString(publication.assignment_id);
  const assignmentVersion = publication.assignment_version;
  const snapshot = record(publication.snapshot);
  const binding = record(snapshot?.current_binding);
  const ledger = record(publication.provider_ledger);
  if (!assignmentId || !Number.isSafeInteger(assignmentVersion) || assignmentVersion < 1) publicationInvalid("identity");
  if (!snapshot || snapshot.schema !== ASSIGNMENT_SNAPSHOT_V2_SCHEMA
      || snapshot.assignment_version !== assignmentVersion) publicationInvalid("snapshot");
  if (snapshot.execution_control !== undefined) {
    const control = record(snapshot.execution_control);
    if (!control || !["paused", "running"].includes(control.state)
        || typeof control.command_id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(control.command_id)
        || typeof control.changed_at !== "string" || !Number.isFinite(Date.parse(control.changed_at))) {
      publicationInvalid("execution_control");
    }
  }
  const runId = requiredString(binding?.run_id);
  const generation = binding?.generation;
  if (binding?.assignment_id !== assignmentId || !runId
      || !Number.isSafeInteger(generation) || generation < 1
      || !requiredString(binding?.session_id) || !requiredString(binding?.principal_id)) publicationInvalid("binding");
  if (!ledger || ledger.schema !== ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA
      || ledger.assignment_id !== assignmentId || ledger.run_id !== runId
      || ledger.generation !== generation) publicationInvalid("provider_ledger_binding");

  const callIds = requiredStringArray(ledger.call_ids);
  const inFlightCallIds = requiredStringArray(ledger.in_flight_call_ids);
  const snapshotCallIds = requiredStringArray(snapshot.provider_call_ids);
  const snapshotInFlightCallIds = requiredStringArray(snapshot.in_flight_provider_call_ids);
  const calls = record(ledger.calls);
  const snapshotCalls = record(snapshot.provider_calls);
  if (!callIds || !inFlightCallIds || !snapshotCallIds || !snapshotInFlightCallIds || !calls || !snapshotCalls
      || new Set(callIds).size !== callIds.length || new Set(inFlightCallIds).size !== inFlightCallIds.length
      || !sameStrings(callIds, snapshotCallIds) || !sameStrings(inFlightCallIds, snapshotInFlightCallIds)
      || inFlightCallIds.some((callId) => !callIds.includes(callId))) publicationInvalid("provider_ledger_index");
  const callKeys = Object.keys(calls).sort();
  const snapshotCallKeys = Object.keys(snapshotCalls).sort();
  const expectedCallKeys = [...callIds].sort();
  if (!sameStrings(callKeys, expectedCallKeys) || !sameStrings(snapshotCallKeys, expectedCallKeys)) {
    publicationInvalid("provider_ledger_calls");
  }
  for (const callId of callIds) {
    const call = record(calls[callId]);
    const snapshotCall = record(snapshotCalls[callId]);
    if (!call || !snapshotCall || call.call_id !== callId || snapshotCall.call_id !== callId) {
      publicationInvalid("provider_call_identity");
    }
    if (!sameJsonValue(call, snapshotCall)) publicationInvalid("provider_call_projection");
    const gapIds = requiredStringArray(call.gap_ids);
    const criterionIds = requiredStringArray(call.criterion_ids);
    const expectedInformation = requiredStringArray(call.expected_information);
    if (!sameAssignmentBinding(call.binding, binding)) publicationInvalid("provider_call_binding");
    if (call.schema !== ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA
        || !PROVIDER_CALL_STATES_V2.has(call.state)
        || !requiredString(call.provider) || !requiredString(call.model)
        || !(call.reasoning_effort === null || requiredString(call.reasoning_effort))
        || !gapIds || !criterionIds || !expectedInformation
        || new Set(gapIds).size !== gapIds.length
        || new Set(criterionIds).size !== criterionIds.length
        || new Set(expectedInformation).size !== expectedInformation.length
        || !requiredString(call.admitted_at)
        || !validOptionalTimestamp(call.dispatched_at)
        || !validOptionalTimestamp(call.response_started_at)
        || !validOptionalTimestamp(call.usage_received_at)
        || !validOptionalTimestamp(call.completed_at)
        || !validOptionalTimestamp(call.response_transport_completed_at)
        || !validOptionalNonNegativeInteger(call.provider_duration_ms)
        || !validProviderUsage(call.usage)
        || (call.upstream_receipt !== undefined && !validUpstreamProviderReceipt(call.upstream_receipt))
        || (call.controller_turn_id !== undefined && !requiredString(call.controller_turn_id))
        || (call.success !== undefined && typeof call.success !== "boolean")
        || (call.error_class !== undefined && !PROVIDER_ERROR_CLASSES_V2.has(call.error_class))) {
      publicationInvalid("provider_call_shape");
    }
    const completed = requiredString(call.completed_at) !== null;
    const terminalState = isTerminalProviderCallStateV2(call.state);
    const listedInFlight = inFlightCallIds.includes(callId);
    if (completed !== terminalState || listedInFlight === completed
        || (completed && typeof call.success !== "boolean")
        || (call.state === "response_transport_completed" && !requiredString(call.response_transport_completed_at))) {
      publicationInvalid("provider_call_state");
    }
  }

  const hasExecutionFailureIndex = snapshot.execution_failure_ids !== undefined
    || snapshot.execution_failures !== undefined;
  // Publications retained before the execution-failure ledger was introduced
  // have neither field. Current producers always publish both; partial or
  // incoherent ledgers fail closed without rewriting historical evidence.
  if (hasExecutionFailureIndex) {
    const executionFailureIds = requiredStringArray(snapshot.execution_failure_ids);
    const executionFailures = record(snapshot.execution_failures);
    if (!executionFailureIds || !executionFailures
        || new Set(executionFailureIds).size !== executionFailureIds.length
        || !sameStrings(Object.keys(executionFailures).sort(), [...executionFailureIds].sort())) {
      publicationInvalid("execution_failure_index");
    }
    for (const failureId of executionFailureIds) {
      const failure = record(executionFailures[failureId]);
      const errorClass = failure?.error_class;
      if (!failure || failure.schema !== ASSIGNMENT_EXECUTION_FAILURE_V2_SCHEMA
          || failure.failure_id !== failureId
          || !sameAssignmentBinding(failure.binding, binding)
          || !EXECUTION_FAILURE_CLASSES_V2.has(errorClass)
          || !EXECUTION_FAILURE_PHASES_V2.has(failure.phase)
          || failure.code !== EXECUTION_FAILURE_CODES_V2[errorClass]) {
        publicationInvalid("execution_failure_shape");
      }
    }
  }
  const parsed = structuredClone(publication);
  if (snapshot.provider_usage_hold !== undefined) parsed.snapshot.provider_usage_hold = parseProviderUsageHoldV1(snapshot.provider_usage_hold, binding);
  return parsed;
}

export const ASSIGNMENT_KERNEL_V2_CONTROL_EVIDENCE_SCHEMA = "revit-operator.assignment-kernel-control-evidence/v2";

const CONTROL_CAPABILITY_DEFINITIONS_V2 = Object.freeze({
  operator_record_execution_strategy: Object.freeze({
    capability_id: "operator_record_execution_strategy",
    durable_result_evidence: false,
    collection_fields: Object.freeze([])
  }),
  operator_discover_capabilities: Object.freeze({
    capability_id: "operator_discover_capabilities",
    durable_result_evidence: true,
    collection_fields: Object.freeze(["capabilities"])
  }),
  operator_retrieve_evidence: Object.freeze({
    capability_id: "operator_retrieve_evidence",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  operator_validate_existing_conditions_interpretation: Object.freeze({
    capability_id: "operator_validate_existing_conditions_interpretation",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  operator_register_existing_conditions_interpretation: Object.freeze({
    capability_id: "operator_register_existing_conditions_interpretation",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  revit_search_tools: Object.freeze({
    capability_id: "revit_search_tools",
    durable_result_evidence: true,
    collection_fields: Object.freeze(["matches", "tools", "results"])
  }),
  revit_tool_registry: Object.freeze({
    capability_id: "revit_tool_registry",
    durable_result_evidence: true,
    collection_fields: Object.freeze(["tools"])
  }),
  revit_tool_doc: Object.freeze({
    capability_id: "revit_tool_doc",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  revit_tool_examples: Object.freeze({
    capability_id: "revit_tool_examples",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  operator_native_tool_registry: Object.freeze({
    capability_id: "operator_native_tool_registry",
    durable_result_evidence: true,
    collection_fields: Object.freeze(["tools"])
  }),
  operator_native_tool_search: Object.freeze({
    capability_id: "operator_native_tool_search",
    durable_result_evidence: true,
    collection_fields: Object.freeze(["matches", "tools", "results"])
  }),
  operator_native_tool_doc: Object.freeze({
    capability_id: "operator_native_tool_doc",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  }),
  operator_native_tool_examples: Object.freeze({
    capability_id: "operator_native_tool_examples",
    durable_result_evidence: true,
    collection_fields: Object.freeze([])
  })
});

export const ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS = Object.freeze(
  Object.keys(CONTROL_CAPABILITY_DEFINITIONS_V2)
);
export const ASSIGNMENT_KERNEL_V2_DURABLE_CONTROL_EVIDENCE_PRODUCER_IDS = Object.freeze(
  ASSIGNMENT_KERNEL_V2_CONTROL_CAPABILITY_IDS.filter(
    capabilityId => CONTROL_CAPABILITY_DEFINITIONS_V2[capabilityId].durable_result_evidence
  )
);

export function assignmentKernelControlCapabilityV2(capabilityId) {
  return typeof capabilityId === "string"
    ? CONTROL_CAPABILITY_DEFINITIONS_V2[capabilityId] ?? null
    : null;
}

export function isAssignmentKernelControlCapabilityV2(capabilityId) {
  return assignmentKernelControlCapabilityV2(capabilityId) !== null;
}

export function isAssignmentKernelDurableControlEvidenceProducerV2(capabilityId) {
  return assignmentKernelControlCapabilityV2(capabilityId)?.durable_result_evidence === true;
}

function boundedControlText(value, maximum = 512) {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}

function compareControlFacts(left, right) {
  const leftIdentity = JSON.stringify([left.fact_id, left.dimensions ?? {}]);
  const rightIdentity = JSON.stringify([right.fact_id, right.dimensions ?? {}]);
  return leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0;
}

/**
 * Derives bounded controller facts from a parsed semantic result. The caller
 * retains the original result object as raw evidence; this adapter never
 * reconstructs or changes that payload and never emits domain/task facts.
 */
export function assignmentKernelControlEvidenceFactsV2(capabilityId, value) {
  const definition = assignmentKernelControlCapabilityV2(capabilityId);
  if (!definition?.durable_result_evidence) return [];
  const payload = record(value) ?? {};
  if (definition.capability_id === "operator_validate_existing_conditions_interpretation"
      || definition.capability_id === "operator_register_existing_conditions_interpretation") {
    const evidence = record(payload.evidence_ref);
    const evidenceId = boundedControlText(evidence?.evidence_id, 80);
    const contentHash = boundedControlText(evidence?.content_hash, 80);
    if (payload.schema_version !== 1 || payload.native_write_allowed !== false
        || evidence?.trust_level !== "host_observed"
        || !/^ev1_[A-Za-z0-9_-]{32}$/.test(evidenceId)
        || !/^sha256:[a-f0-9]{64}$/.test(contentHash)) return [];
    const dimensions = { capability_id: definition.capability_id, content_hash: contentHash };
    if (definition.capability_id === "operator_validate_existing_conditions_interpretation") {
      if (!/^[a-f0-9]{64}$/.test(boundedControlText(payload.source_binding_sha256, 80))
          || !/^[a-f0-9]{64}$/.test(boundedControlText(payload.interpretation_sha256, 80))) return [];
      return [{ fact_id: "control.existing_conditions_interpretation_available", fact_class: "control",
        value: true, cardinality: "many", identity_dimensions: Object.keys(dimensions).sort(), dimensions }];
    }
    const registration = record(payload.registration);
    if (registration?.verified !== true
        || !/^ev1_[A-Za-z0-9_-]{32}$/.test(boundedControlText(payload.interpretation_evidence_id, 80))
        || !/^obsv2_[a-f0-9]{64}$/.test(boundedControlText(payload.frame_observation_id, 80))) return [];
    return [{ fact_id: "control.existing_conditions_registration_available", fact_class: "control",
      value: true, cardinality: "many", identity_dimensions: Object.keys(dimensions).sort(), dimensions }];
  }
  const status = boundedControlText(payload.status, 80) || "completed";
  const evidenceResult = definition.capability_id === "operator_retrieve_evidence"
    ? record(payload.result) ?? payload
    : null;
  const evidenceRef = record(evidenceResult?.evidence_ref ?? evidenceResult?.evidenceRef);
  const evidenceId = boundedControlText(evidenceRef?.evidence_id ?? evidenceRef?.evidenceId, 256);
  const facts = [definition.capability_id === "operator_retrieve_evidence" ? {
    fact_id: "control.evidence_retrieval_status",
    fact_class: "control",
    value: status,
    dimensions: {
      capability_id: definition.capability_id,
      ...(evidenceId ? { evidence_id: evidenceId } : {})
    }
  } : {
    fact_id: "control.capability_discovery_status",
    fact_class: "control",
    value: status,
    dimensions: { capability_id: definition.capability_id }
  }];
  if (evidenceResult?.schema === "revit-operator.evidence-retrieval.v1" && evidenceId
      && payload.ok !== false && evidenceResult.ok !== false) {
    const selection = record(evidenceResult.selection);
    const missingFields = new Set(Array.isArray(evidenceResult.missing_fields) ? evidenceResult.missing_fields : []);
    const paths = Object.keys(selection ?? {}).filter(path => !missingFields.has(path)).sort().slice(0, 64);
    const page = record(evidenceResult.pagination);
    const rows = evidenceResult.selection;
    // A page contributes only its actual retained rows or selected cells. Repeated or
    // overlapping selections cannot manufacture progress by changing page sizes,
    // purpose, timestamps or payload contents. These remain control-only facts.
    if (Array.isArray(rows) && rows.length > 0 && rows.length <= 256 && page
        && typeof page.path === "string" && page.path.length > 0 && page.path.length <= 480
        && !/[\u0000-\u001f]/.test(page.path)
        && Number.isSafeInteger(page.start) && page.start >= 0
        && Number.isSafeInteger(page.requested_count) && page.requested_count >= rows.length && page.requested_count <= 256
        && page.returned_count === rows.length
        && Number.isSafeInteger(page.total_items) && page.total_items >= page.start + rows.length) {
      const projected = page.row_projection === "selected_fields" || hasOwn(page, "fields");
      const columns = Array.isArray(page.fields) && page.fields.length > 0 && page.fields.length <= 64
        && page.fields.every(field => typeof field === "string" && field.trim() === field && field.length > 0
          && field.length <= 512 && !/[\u0000-\u001f]/.test(field))
        && new Set(page.fields).size === page.fields.length ? page.fields : null;
      for (let index = 0; index < rows.length; index += 1) {
        const rowPath = `${page.path}[${page.start + index}]`;
        if (!projected) { paths.push(rowPath); continue; }
        const row = record(rows[index]);
        const values = record(row?.values);
        if (!columns || !row || row.row_index !== page.start + index || !values
            || !Array.isArray(row.missing_fields) || !row.missing_fields.every(field => typeof field === "string")) continue;
        // Reviewing one column did not deliver the other cells in this row.
        // Missing fields, projection metadata and invented row indices earn no
        // knowledge credit. These remain supporting facts, never fulfillment.
        for (const field of columns) {
          const cellPath = `${rowPath}.${field}`;
          if (hasOwn(values, field) && !row.missing_fields.includes(field) && cellPath.length <= 512) paths.push(cellPath);
        }
      }
    }
    for (const selectionPath of paths) {
      const boundedPath = boundedControlText(selectionPath, 512);
      if (!boundedPath) continue;
      const dimensions = {
        capability_id: definition.capability_id,
        evidence_id: evidenceId,
        selection_path: boundedPath
      };
      facts.push({
        fact_id: "control.evidence_selection_available",
        fact_class: "control",
        value: true,
        cardinality: "many",
        identity_dimensions: Object.keys(dimensions).sort(),
        dimensions
      });
    }
  }
  const candidates = [];
  for (const field of definition.collection_fields) {
    const collection = payload[field];
    if (Array.isArray(collection)) candidates.push(...collection.slice(0, 128));
  }
  if (boundedControlText(payload.path) || boundedControlText(payload.id)) candidates.push(payload);

  const exact = new Set();
  for (const candidateValue of candidates.slice(0, 128)) {
    const candidate = record(candidateValue);
    if (!candidate) continue;
    const methodCandidate = boundedControlText(candidate.method, 16).toUpperCase();
    const pathCandidate = boundedControlText(candidate.path, 512);
    const method = methodCandidate === "GET" || methodCandidate === "POST" ? methodCandidate : "";
    const path = method && pathCandidate.startsWith("/revit/") ? pathCandidate : "";
    const discoveredCapabilityId = boundedControlText(candidate.capability_id ?? candidate.capabilityId ?? candidate.id, 256);
    const dimensions = path
      ? { capability_id: definition.capability_id, method, path }
      : discoveredCapabilityId
        ? { capability_id: definition.capability_id, discovered_capability_id: discoveredCapabilityId }
        : null;
    if (!dimensions) continue;
    const identity = JSON.stringify(dimensions);
    if (exact.has(identity)) continue;
    exact.add(identity);
    facts.push({
      fact_id: "control.capability_available",
      fact_class: "control",
      value: true,
      cardinality: "many",
      identity_dimensions: Object.keys(dimensions).sort(),
      dimensions
    });
  }
  return facts.sort(compareControlFacts);
}

export const EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA = "revit-operator.evidence-retrieval-selector-contract/v1";

function evidenceSelectorInvalid(reason) {
  throw new TypeError(`evidence_retrieval_selector_invalid:${reason}`);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function boundedSelectorString(value, maximum, field) {
  if (typeof value !== "string") evidenceSelectorInvalid(`${field} must be a string`);
  const text = value.trim();
  if (!text) evidenceSelectorInvalid(`${field} must not be empty`);
  if (text.length > maximum) evidenceSelectorInvalid(`${field} exceeds ${maximum} characters`);
  if (/[\u0000-\u001f]/.test(text)) evidenceSelectorInvalid(`${field} contains control characters`);
  return text;
}

function scalarSelectorField(value, label) {
  if (typeof value !== "string" || value.trim() !== value || /[\u0000-\u001f]/.test(value)) evidenceSelectorInvalid("invalid scalar field path");
  return boundedSelectorString(value, 512, label);
}

/**
 * Parses the one-selector evidence-retrieval contract shared by MCP and the
 * backend. Optional properties which are present are validated rather than
 * silently ignored, and multiple active selectors fail before evidence bytes
 * are read.
 */
export function parseEvidenceRetrievalSelectorV1(value) {
  const request = record(value);
  if (!request) evidenceSelectorInvalid("request must be an object");
  const active = [];

  if (hasOwn(request, "fields")) {
    if (!Array.isArray(request.fields) || request.fields.length < 1 || request.fields.length > 64) {
      evidenceSelectorInvalid("fields must contain 1..64 paths");
    }
    const fields = request.fields.map((field, index) => boundedSelectorString(field, 512, `fields[${index}]`));
    active.push({ kind: "fields", fields });
  }
  if (hasOwn(request, "item_range")) {
    const itemRange = record(request.item_range);
    if (!itemRange
        || !Number.isSafeInteger(itemRange.start) || itemRange.start < 0
        || !Number.isSafeInteger(itemRange.count) || itemRange.count < 1 || itemRange.count > 256) {
      evidenceSelectorInvalid("item_range requires path, start >= 0, and count 1..256");
    }
    let fields;
    if (hasOwn(itemRange, "fields")) {
      if (!Array.isArray(itemRange.fields) || itemRange.fields.length < 1 || itemRange.fields.length > 64) {
        evidenceSelectorInvalid("item_range.fields must contain 1..64 paths");
      }
      fields = itemRange.fields.map((field, index) => {
        if (typeof field === "string" && /[\u0000-\u001f]/.test(field)) evidenceSelectorInvalid("item_range.fields must not contain control characters");
        return boundedSelectorString(field, 512, `item_range.fields[${index}]`);
      });
      if (new Set(fields).size !== fields.length) evidenceSelectorInvalid("item_range.fields must be unique");
      fields = Object.freeze(fields);
    }
    let filters, orderBy;
    if (hasOwn(itemRange, "filters") || hasOwn(itemRange, "orderBy")) {
      if (!fields) evidenceSelectorInvalid("scalar selection requires item_range.fields");
      if (hasOwn(itemRange, "filters")) {
        if (!Array.isArray(itemRange.filters) || itemRange.filters.length < 1 || itemRange.filters.length > 8) evidenceSelectorInvalid("item_range.filters must contain 1..8 predicates");
        filters = Object.freeze(itemRange.filters.map((input, index) => {
          const f = record(input);
          if (!f || Object.keys(f).some(k => !["field", "op", "value"].includes(k)) || !hasOwn(f, "value")
              || !["eq", "ne", "lt", "lte", "gt", "gte"].includes(f.op)) evidenceSelectorInvalid("invalid scalar filter");
          const v = f.value;
          if (!(v === null || typeof v === "boolean" || typeof v === "number" && Number.isFinite(v)
              || typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f]/.test(v))) evidenceSelectorInvalid("filter value must be a bounded finite scalar");
          if (!["eq", "ne"].includes(f.op) && typeof v !== "number") evidenceSelectorInvalid("ordered filter value must be numeric");
          return Object.freeze({ field: scalarSelectorField(f.field, `item_range.filters[${index}].field`), op: f.op, value: v });
        }));
      }
      if (hasOwn(itemRange, "orderBy")) {
        const o = record(itemRange.orderBy);
        if (!o || Object.keys(o).some(k => !["field", "direction"].includes(k)) || !["asc", "desc"].includes(o.direction)) evidenceSelectorInvalid("orderBy requires field and asc|desc direction");
        orderBy = Object.freeze({ field: scalarSelectorField(o.field, "item_range.orderBy.field"), direction: o.direction });
      }
    }
    active.push({
      kind: "item_range",
      item_range: {
        path: boundedSelectorString(itemRange.path, 512, "item_range.path"),
        start: itemRange.start,
        count: itemRange.count,
        ...(fields ? { fields } : {}),
        ...(filters ? { filters } : {}),
        ...(orderBy ? { orderBy } : {})
      }
    });
  }
  if (hasOwn(request, "text_range")) {
    const textRange = record(request.text_range);
    if (!textRange
        || !Number.isSafeInteger(textRange.start) || textRange.start < 0
        || !Number.isSafeInteger(textRange.length) || textRange.length < 1 || textRange.length > 1_048_576) {
      evidenceSelectorInvalid("text_range requires start >= 0 and length 1..1048576");
    }
    const fieldPath = hasOwn(textRange, "path") ? boundedSelectorString(textRange.path, 512, "text_range.path") : undefined;
    if (fieldPath !== undefined && fieldPath !== textRange.path) evidenceSelectorInvalid("text_range.path must not contain surrounding whitespace");
    if (fieldPath && /[\u0000-\u001f]/.test(fieldPath)) evidenceSelectorInvalid("text_range.path contains control characters");
    active.push({ kind: "text_range", text_range: { start: textRange.start, length: textRange.length, ...(fieldPath === undefined ? {} : { path: fieldPath }) } });
  }
  if (hasOwn(request, "target_subset")) {
    if (!Array.isArray(request.target_subset) || request.target_subset.length < 1 || request.target_subset.length > 64) {
      evidenceSelectorInvalid("target_subset must contain 1..64 target identities");
    }
    const targetSubset = [...new Set(request.target_subset.map((target, index) =>
      boundedSelectorString(target, 160, `target_subset[${index}]`)))];
    active.push({ kind: "target_subset", target_subset: targetSubset });
  }
  if (hasOwn(request, "image")) {
    if (request.image !== true) evidenceSelectorInvalid("image must be true when supplied");
    active.push({ kind: "image", image: true });
  }
  if (active.length !== 1) {
    evidenceSelectorInvalid("exactly one active selector is required: fields, item_range, text_range, target_subset, or image=true");
  }
  return Object.freeze(active[0]);
}

/** Fail closed when a peer did not execute the requested retained scalar selection.
 * This authenticates no native fact and changes no legacy unfiltered response. */
export function assertScalarEvidencePageV1(request, envelope) {
  const selector = parseEvidenceRetrievalSelectorV1(request);
  if (selector.kind !== "item_range" || !selector.item_range.filters && !selector.item_range.orderBy) return;
  const range = selector.item_range, result = record(envelope)?.result ?? envelope;
  const r = record(result), p = record(r?.pagination), q = record(p?.selection_query), rows = r?.selection;
  const fail = () => { throw new TypeError("scalar_evidence_response_invalid: peer must return the exact partial scalar-selection coverage"); };
  const count = v => Number.isSafeInteger(v) && v >= 0;
  if (!r || r.schema !== "revit-operator.evidence-retrieval.v1" || r.complete !== false || !p || !q || !Array.isArray(rows)
      || p.path !== range.path || p.start !== range.start || p.requested_count !== range.count || p.returned_count !== rows.length
      || rows.length > range.count || q.cursor_basis !== "selected_rank" || !count(q.source_total_items) || q.source_total_items > 5000
      || p.total_items !== q.source_total_items || !count(q.matched_total_items) || q.matched_total_items > q.source_total_items
      || q.scanned_retained_rows !== q.source_total_items || q.retained_scan_complete !== true || p.source_rows_exhausted !== false
      || p.row_projection !== "selected_fields" || JSON.stringify(p.fields) !== JSON.stringify(range.fields)
      || JSON.stringify(q.filters ?? []) !== JSON.stringify(range.filters ?? [])
      || JSON.stringify(q.orderBy ?? null) !== JSON.stringify(range.orderBy ?? null)
      || !count(q.non_comparable_filter_rows) || q.non_comparable_filter_rows > q.source_total_items
      || !count(q.unavailable_numeric_order_rows) || q.unavailable_numeric_order_rows > q.matched_total_items
      || !range.filters && (q.non_comparable_filter_rows !== 0 || q.matched_total_items !== q.source_total_items)
      || !range.orderBy && q.unavailable_numeric_order_rows !== 0) fail();
  const available = Math.max(0, q.matched_total_items - range.start), more = range.start + rows.length < q.matched_total_items;
  if (rows.length > available || p.has_more !== more || p.next_start !== (more ? range.start + rows.length : null)
      || q.selected_rows_exhausted !== !more || p.byte_limited !== (rows.length < Math.min(range.count, available))
      || p.requested_rows_complete !== !p.byte_limited || more && rows.length === 0) fail();
  const indices = new Set();
  for (const item of rows) {
    const row = record(item), values = record(row?.values);
    if (!row || !count(row.row_index) || row.row_index >= q.source_total_items || indices.has(row.row_index) || !values
        || !Array.isArray(row.missing_fields) || row.missing_fields.some(f => !range.fields.includes(f))
        || new Set(row.missing_fields).size !== row.missing_fields.length
        || Object.keys(values).length !== range.fields.length || !range.fields.every(f => hasOwn(values, f))) fail();
    indices.add(row.row_index);
  }
}

/** Returns true only for reviewed scalar/collection identity field names. */
export function isEvidenceTargetIdentityFieldV1(value) {
  if (typeof value !== "string" || !value) return false;
  const compact = value.replace(/[_-]/g, "").toLowerCase();
  if (/^(?:uniqueid|uniqueids)$/.test(compact)) return true;
  return /(?:element|target|view|sheet|room|space|system|circuit|level|host|textnote|connector|fitting|sourcescoped)(?:id|ids|uniqueid|uniqueids|name|names)?$/.test(compact);
}

export function evidenceTargetIdentityValuesV1(value) {
  const candidates = Array.isArray(value) ? value : [value];
  const identities = [];
  for (const candidate of candidates) {
    const identity = typeof candidate === "string"
      ? candidate.trim()
      : Number.isSafeInteger(candidate)
        ? String(candidate)
        : "";
    if (identity && identity.length <= 160 && !/[\u0000-\u001f]/.test(identity) && !identities.includes(identity)) {
      identities.push(identity);
    }
  }
  return identities;
}

function matchingScalarRecordTargets(value, targets) {
  const row = record(value);
  const matches = new Set();
  if (!row) return matches;
  for (const [key, fieldValue] of Object.entries(row)) {
    if (!isEvidenceTargetIdentityFieldV1(key) || Array.isArray(fieldValue)) continue;
    for (const identity of evidenceTargetIdentityValuesV1(fieldValue)) {
      if (targets.has(identity)) matches.add(identity);
    }
  }
  return matches;
}

function isEvidenceTargetIdentityMapFieldV1(value) {
  if (typeof value !== "string" || !value) return false;
  const compact = value.replace(/[_-]/g, "").toLowerCase();
  return /^(?:by(?:id|uniqueid|target)|(?:item|items|element|elements|target|targets|view|views|sheet|sheets|room|rooms|space|spaces|system|systems|circuit|circuits|level|levels|host|hosts|textnote|textnotes|connector|connectors|fitting|fittings)by(?:id|uniqueid|target))$/.test(compact);
}

/**
 * Selects complete rows and scalar identity-array members which are bound to
 * every requested target. Arbitrary prose and partial substrings are never
 * evidence of target identity. The caller retains the original immutable raw
 * object and applies the final byte cap to this deterministic selection.
 */
export function selectExactEvidenceTargetsV1(payload, targetSubset) {
  const parsed = parseEvidenceRetrievalSelectorV1({ target_subset: targetSubset });
  const requested = parsed.target_subset;
  const targets = new Set(requested);
  const matched = new Set();
  const selections = new Map();
  const queue = [{ value: payload, path: "payload", field: "payload" }];
  let cursor = 0;
  let visited = 0;

  while (cursor < queue.length) {
    const current = queue[cursor++];
    if (++visited > 100_000) evidenceSelectorInvalid("target_subset structural scan exceeds 100000 nodes");
    if (Array.isArray(current.value)) {
      if (isEvidenceTargetIdentityFieldV1(current.field)) {
        const selected = current.value.filter(item => {
          const identity = evidenceTargetIdentityValuesV1(item)[0];
          if (!identity || !targets.has(identity)) return false;
          matched.add(identity);
          return true;
        });
        if (selected.length > 0) selections.set(current.path, selected);
      }
      const selectedRows = [];
      for (const item of current.value) {
        const matches = matchingScalarRecordTargets(item, targets);
        if (matches.size === 0) continue;
        selectedRows.push(item);
        for (const identity of matches) matched.add(identity);
      }
      if (selectedRows.length > 0) {
        selections.set(current.path, selectedRows);
        continue;
      }
      for (let index = 0; index < current.value.length; index += 1) {
        const item = current.value[index];
        if (item && typeof item === "object") queue.push({ value: item, path: `${current.path}[${index}]`, field: current.field });
      }
      continue;
    }

    const row = record(current.value);
    if (!row) continue;
    const rowMatches = matchingScalarRecordTargets(row, targets);
    if (rowMatches.size > 0) {
      selections.set(current.path, row);
      for (const identity of rowMatches) matched.add(identity);
      continue;
    }
    for (const [key, fieldValue] of Object.entries(row)) {
      if (targets.has(key) && isEvidenceTargetIdentityMapFieldV1(current.field)) {
        selections.set(`${current.path}.${key}`, fieldValue);
        matched.add(key);
        continue;
      }
      if (fieldValue && typeof fieldValue === "object") {
        queue.push({ value: fieldValue, path: `${current.path}.${key}`, field: key });
      }
    }
  }

  const missing = requested.filter(identity => !matched.has(identity));
  if (missing.length > 0) {
    evidenceSelectorInvalid(`target_subset did not match exact target identities: ${missing.join(", ")}`);
  }
  return Object.freeze({
    schema: EVIDENCE_RETRIEVAL_SELECTOR_CONTRACT_V1_SCHEMA,
    selection: Object.freeze(Object.fromEntries(selections)),
    matched_target_ids: Object.freeze([...requested]),
    selection_paths: Object.freeze([...selections.keys()])
  });
}

/** Bounded native failure parsing only. The reducer separately validates exact
 * receipt/hash/binding and journal order before this can inform a write retry. */
export function nativeFailureDependencyLinksV1(value, declaredTargetIdentities) {
  const record = value => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  const payload = record(value), transaction = record(payload?.transaction), rows = payload?.capturedFailures;
  if (!payload || transaction?.status !== "rolled_back" || transaction.committed !== false
      || payload.failureRollbackRequested !== true || payload.applied !== false || payload.success !== false
      || !Array.isArray(rows) || rows.length === 0 || rows.length > 64 || !Array.isArray(declaredTargetIdentities)) return undefined;
  const targets = new Set(declaredTargetIdentities
    .filter(value => typeof value === "string" && /^id:[1-9]\d*$/.test(value)).map(value => value.slice(3)));
  const dependencies = new Map();
  for (const value of rows) {
    const row = record(value), ids = row?.elementIds;
    if (!row || !["Error", "Warning", "DocumentCorruption"].includes(row.severity)
        || typeof row.message !== "string" || !row.message.trim()
        || typeof row.failureDefinitionId !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(row.failureDefinitionId)
        || !Array.isArray(row.captureErrors) || row.captureErrors.length !== 0
        || !Array.isArray(ids) || ids.length > 32
        || ids.some(id => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) return undefined;
    const named = ids.map(String), matched = named.filter(id => targets.has(id));
    if (!matched.length) continue;
    for (const id of named) if (!targets.has(id)) {
      const linked = dependencies.get(id) ?? new Set();
      for (const target of matched) linked.add(target);
      dependencies.set(id, linked);
      if (dependencies.size > 256) return undefined;
    }
  }
  if (dependencies.size === 0) return undefined;
  return [...dependencies.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([element_id, linked]) => ({ element_id, target_element_ids: [...linked].sort() }));
}

export * from "./native-continuation.js";
export * from "./schedule-filter-state.js";

/** Shared owner/MCP peer guard for projected retained strings, never native proof. */
export function assertEvidenceTextRangePageV1(selector, response) {
  const range=record(record(selector)?.text_range),result=record(record(response)?.result),p=record(result?.text_pagination);
  if(range?.path===undefined){if(result?.text_pagination!==undefined)throw Error('focused_evidence_unexpected_text_pagination');return;}
  const bad=()=>{throw Error('focused_evidence_text_pagination_invalid');};
  if(typeof range.path!=='string'||!range.path||!Number.isSafeInteger(range.start)||range.start<0||!Number.isSafeInteger(range.length)||range.length<1)bad();
  if(!result||typeof result.selection!=='string'||result.complete!==false||!p||p.path!==range.path||p.start!==range.start||p.requested_length!==range.length)bad();
  const encoded=new TextEncoder().encode(result.selection),n=encoded.length;
  if(new TextDecoder('utf-8',{fatal:true}).decode(encoded)!==result.selection)bad();
  const source=record(result.evidence_ref);
  if(!source||!Number.isSafeInteger(source.byte_count)||!Number.isSafeInteger(p.total_utf8_bytes)||p.total_utf8_bytes<range.start||p.total_utf8_bytes>source.byte_count
    ||p.returned_utf8_bytes!==n||n>range.length||n>p.total_utf8_bytes-range.start)bad();
  const end=range.start+n,more=end<p.total_utf8_bytes;
  if(p.has_more!==more||p.next_start!==(more?end:null)||more&&n===0
    ||p.field_complete!==(range.start===0&&!more)||p.byte_limited!==(n<Math.min(range.length,p.total_utf8_bytes-range.start)))bad();
}

/** This route edits an owned, detached family document. Its verified child
 * typography is useful progress but is never proof of a loaded project result.
 * Keep this distinction independent of producer-supplied success flags. */
export function isDetachedFamilyLabelEditV2(method, path) {
  return typeof method === "string" && method.trim().toUpperCase() === "POST"
    && typeof path === "string" && path.trim().toLowerCase() === "/revit/set-family-label-style";
}
