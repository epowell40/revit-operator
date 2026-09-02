export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_SCHEMA = "revit-operator.assignment-kernel-session-index/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_RESPONSE_SCHEMA = "revit-operator.assignment-kernel-session-index-response/v2";
export const ASSIGNMENT_KERNEL_V2_SESSION_INDEX_FIELD = "assignment_kernel_v2_session_index";

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function invalid(reason) {
  throw new TypeError(`assignment_kernel_v2_session_index_invalid:${reason}`);
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
