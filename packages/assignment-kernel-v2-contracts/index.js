export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA = "revit-operator.assignment-kernel-session-index/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA = "revit-operator.assignment-kernel-session-index-response/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD = "assignment_kernel_v2_session_index";
export const ASSIGNMENT_SNAPSHOT_V2_SCHEMA = "revit-operator.assignment-snapshot/v2";
export const ASSIGNMENT_KERNEL_PUBLICATION_V2_SCHEMA = "revit-operator.assignment-kernel-publication/v2";
export const ASSIGNMENT_PROVIDER_LEDGER_V2_SCHEMA = "revit-operator.assignment-provider-ledger/v2";
export const ASSIGNMENT_PROVIDER_CALL_V2_SCHEMA = "revit-operator.provider-call/v2";
export const OPERATION_RESULT_SEMANTIC_GAP_V2_SCHEMA = "revit-operator.operation-result-semantic-gap/v2";

const PROVIDER_CALL_STATES_V2 = new Set([
  "admitted",
  "dispatched",
  "response_started",
  "usage_received",
  "completed",
  "response_transport_completed"
]);
const PROVIDER_ERROR_CLASSES_V2 = new Set(["provider", "transport", "canceled", "resource_exhausted"]);

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

function validOptionalTimestamp(value) {
  return value === undefined || requiredString(value) !== null;
}

function validOptionalNonNegativeInteger(value) {
  return value === undefined || value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validOptionalNonNegativeNumber(value) {
  return value === undefined || value === null || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validProviderUsage(value) {
  if (value === undefined) return true;
  const usage = record(value);
  return Boolean(usage)
    && validOptionalNonNegativeInteger(usage.input_tokens)
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
  return structuredClone(publication);
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
  if (evidenceResult && evidenceId) {
    const selection = record(evidenceResult.selection);
    for (const selectionPath of Object.keys(selection ?? {}).sort().slice(0, 64)) {
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
