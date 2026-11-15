const EVIDENCE_REF_SCHEMA = "revit-operator.evidence-ref.v1";
const EVIDENCE_PROJECTION_SCHEMA = "revit-operator.evidence-projection.v1";
const MODEL_EVIDENCE_ENVELOPE_SCHEMA = "revit-operator.model-evidence-envelope.v1";
const DEFAULT_ITEM_BUDGET_BYTES = 8_192;
const DEFAULT_REQUEST_BUDGET_BYTES = 32_768;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/;

function utf8Bytes(value) {
  return Buffer.byteLength(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function boundedIdentifier(value, name, { required = false } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (required) throw new Error(`${name} is required for evidence scoping.`);
    return null;
  }
  if (!SAFE_ID.test(text)) throw new Error(`${name} is not a bounded identifier.`);
  return text;
}

function normalizeGeneration(value) {
  if (value == null) return null;
  const generation = Number(value);
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new Error("Evidence generation must be a non-negative integer.");
  }
  return generation;
}

function normalizeEvidenceScope(scope) {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    throw new Error("Canonical evidence scope is required.");
  }
  return {
    session_id: boundedIdentifier(scope.session_id, "session_id", { required: true }),
    assignment_id: boundedIdentifier(scope.assignment_id, "assignment_id"),
    run_id: boundedIdentifier(scope.run_id, "run_id"),
    attempt_id: boundedIdentifier(scope.attempt_id, "attempt_id"),
    generation: normalizeGeneration(scope.generation)
  };
}

function sidecarEvidenceScope({ assignment, backendSessionId }) {
  const sessionId = assignment?.session_id || backendSessionId;
  return normalizeEvidenceScope({
    session_id: sessionId,
    assignment_id: assignment?.goal_id || null,
    run_id: assignment?.run_id || null,
    generation: assignment?.generation ?? null
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateEvidenceStoreResponse(response, { itemBudgetBytes = DEFAULT_ITEM_BUDGET_BYTES } = {}) {
  if (!isPlainObject(response) || response.ok !== true) {
    throw new Error("Evidence store did not return a successful response.");
  }
  const ref = response.ref;
  const projection = response.projection;
  if (!isPlainObject(ref) || ref.schema !== EVIDENCE_REF_SCHEMA || !SAFE_ID.test(`${ref.evidence_id || ""}`)) {
    throw new Error("Evidence store returned an invalid EvidenceRef.");
  }
  if (!isPlainObject(projection)
      || projection.schema !== EVIDENCE_PROJECTION_SCHEMA
      || projection.evidence_id !== ref.evidence_id
      || projection.content_hash !== ref.content_hash
      || projection.byte_count !== ref.byte_count) {
    throw new Error("Evidence store returned an invalid or mismatched projection.");
  }
  const projectionBytes = utf8Bytes(projection);
  if (projectionBytes > itemBudgetBytes || projection.projected_bytes > itemBudgetBytes) {
    throw new Error(`Evidence projection exceeds the ${itemBudgetBytes}-byte item budget.`);
  }
  const storedUniqueBytes = Number(response.stored_unique_bytes);
  const duplicateBytesAvoided = Number(response.duplicate_bytes_avoided);
  if (!Number.isSafeInteger(storedUniqueBytes) || storedUniqueBytes < 0
      || !Number.isSafeInteger(duplicateBytesAvoided) || duplicateBytesAvoided < 0) {
    throw new Error("Evidence store returned invalid deduplication telemetry.");
  }
  return {
    ref,
    projection,
    stored_unique_bytes: storedUniqueBytes,
    duplicate_bytes_avoided: duplicateBytesAvoided
  };
}

function modelEvidenceEnvelope(projections, omitted = 0, { requestBudgetBytes = DEFAULT_REQUEST_BUDGET_BYTES } = {}) {
  if (!Array.isArray(projections) || projections.length === 0) {
    throw new Error("At least one validated evidence projection is required.");
  }
  const envelope = {
    schema: MODEL_EVIDENCE_ENVELOPE_SCHEMA,
    evidence_projections: projections,
    omitted: Number.isSafeInteger(omitted) && omitted >= 0 ? omitted : 0,
    retrieval: "Read scoped helper_findings and visual_work_review first; these are supporting claims/assessments, not native proof or parent completion. Honor coverage; use a named evidence_id with exactly one focused field/item/text/target selector for missing whole findings. Target selectors match exact reviewed target identities only."
  };
  const bytes = utf8Bytes(envelope);
  if (bytes > requestBudgetBytes) {
    throw new Error(`Projected evidence exceeds the ${requestBudgetBytes}-byte model-request budget.`);
  }
  return { envelope, bytes };
}

function parseJsonOutput(output) {
  if (typeof output !== "string") return null;
  try { return JSON.parse(output); } catch { return null; }
}

function normalizeTargetScope(values) {
  const result = [];
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === "string" || typeof value === "number" ? `${value}`.trim() : "";
    if (!text || text.length > 120 || result.includes(text)) continue;
    result.push(text);
    if (result.length >= 32) break;
  }
  return result;
}

function targetScopeFromToolCall(toolCall) {
  let args = {};
  try { args = JSON.parse(`${toolCall?.arguments || "{}"}`); } catch {}
  const targets = [];
  const queue = [args];
  let visited = 0;
  while (queue.length > 0 && visited < 300 && targets.length < 32) {
    const value = queue.shift();
    visited += 1;
    if (Array.isArray(value)) {
      queue.push(...value.slice(0, 64));
      continue;
    }
    if (!isPlainObject(value)) continue;
    for (const [key, child] of Object.entries(value)) {
      if (/(?:element|target|view|sheet|room|space|system|circuit|level|host)(?:_?ids?|_?names?)?$/i.test(key)) {
        const items = Array.isArray(child) ? child : [child];
        targets.push(...items.filter(item => typeof item === "string" || typeof item === "number"));
      }
      if (child && typeof child === "object") queue.push(child);
    }
  }
  return normalizeTargetScope(targets);
}

async function persistSidecarEvidence({
  scope,
  source,
  raw,
  mediaType,
  targetScope = [],
  boundedSummary,
  verificationRelevance = "supporting",
  relationships = [],
  storeEvidence,
  itemBudgetBytes = DEFAULT_ITEM_BUDGET_BYTES
}) {
  if (typeof storeEvidence !== "function") throw new Error("Evidence storage callback is required.");
  const normalizedScope = normalizeEvidenceScope(scope);
  const body = {
    scope: normalizedScope,
    source: `${source || "operator_desktop"}`.slice(0, 240),
    media_type: mediaType,
    trust_level: "untrusted_caller",
    target_scope: normalizeTargetScope(targetScope),
    bounded_summary: `${boundedSummary || "Operator Desktop evidence."}`.slice(0, 600),
    verification_relevance: verificationRelevance,
    relationships
  };
  if (Buffer.isBuffer(raw)) body.raw_base64 = raw.toString("base64");
  else if (typeof raw === "string") {
    const parsed = parseJsonOutput(raw);
    if (parsed === null) body.raw_text = raw;
    else body.raw_json = parsed;
  } else body.raw_json = raw;
  const response = await storeEvidence(body);
  return validateEvidenceStoreResponse(response, { itemBudgetBytes });
}

async function projectSidecarFunctionOutput({
  toolCall,
  functionOutput,
  rawEvidence,
  scope,
  storeEvidence,
  itemBudgetBytes = DEFAULT_ITEM_BUDGET_BYTES,
  requestBudgetBytes = DEFAULT_REQUEST_BUDGET_BYTES
}) {
  if (!isPlainObject(functionOutput) || functionOutput.type !== "function_call_output") {
    throw new Error("A function_call_output is required for evidence projection.");
  }
  const raw = rawEvidence ?? functionOutput.output;
  const stored = await persistSidecarEvidence({
    scope,
    source: `operator_desktop.function.${toolCall?.name || "unknown"}`,
    raw,
    mediaType: "application/json",
    targetScope: targetScopeFromToolCall(toolCall),
    boundedSummary: `${toolCall?.name || "Function tool"} result retained as raw evidence.`,
    verificationRelevance: toolCall?.name === "delegate_revit_task" || toolCall?.name === "run_dynamic_revit_program"
      ? "required"
      : "supporting",
    storeEvidence,
    itemBudgetBytes
  });
  const { envelope, bytes } = modelEvidenceEnvelope([stored.projection], 0, { requestBudgetBytes });
  return {
    model_output: {
      type: "function_call_output",
      call_id: functionOutput.call_id,
      output: JSON.stringify(envelope)
    },
    evidence_ref: stored.ref,
    evidence_projection: stored.projection,
    telemetry: {
      raw_evidence_bytes: stored.ref.byte_count,
      projected_bytes: bytes,
      stored_unique_bytes: stored.stored_unique_bytes,
      duplicate_bytes_avoided: stored.duplicate_bytes_avoided
    }
  };
}

async function persistSidecarScreenshot({
  image,
  scope,
  screen = {},
  storeEvidence,
  relationshipEvidenceId = null
}) {
  const bytes = Buffer.isBuffer(image) ? Buffer.from(image) : Buffer.from(`${image || ""}`, "base64");
  if (bytes.length === 0) throw new Error("Screenshot evidence is empty.");
  return await persistSidecarEvidence({
    scope,
    source: "operator_desktop.screenshot",
    raw: bytes,
    mediaType: "image/png",
    targetScope: [],
    boundedSummary: `Authorized desktop capture ${Number(screen.width) || 0}x${Number(screen.height) || 0}.`,
    verificationRelevance: "supporting",
    relationships: relationshipEvidenceId
      ? [{ evidence_id: relationshipEvidenceId, relation: "capture_for" }]
      : [],
    storeEvidence
  });
}

function screenshotEvidenceInput(projection) {
  if (!isPlainObject(projection) || projection.schema !== EVIDENCE_PROJECTION_SCHEMA) {
    throw new Error("A validated screenshot evidence projection is required.");
  }
  return {
    role: "user",
    content: [{
      type: "input_text",
      text: `The attached current-screen image is retained as evidence ${projection.evidence_id} (${projection.byte_count} bytes, ${projection.content_hash}). Request that named image only if focused reinspection is needed.`
    }]
  };
}

export {
  DEFAULT_ITEM_BUDGET_BYTES,
  DEFAULT_REQUEST_BUDGET_BYTES,
  EVIDENCE_PROJECTION_SCHEMA,
  MODEL_EVIDENCE_ENVELOPE_SCHEMA,
  modelEvidenceEnvelope,
  normalizeEvidenceScope,
  persistSidecarEvidence,
  persistSidecarScreenshot,
  projectSidecarFunctionOutput,
  screenshotEvidenceInput,
  sidecarEvidenceScope,
  targetScopeFromToolCall,
  validateEvidenceStoreResponse
};
