export const PROVIDER_USAGE_HOLD_V1_SCHEMA = "revit-operator.provider-usage-hold/v1";
const object = value => value && typeof value === "object" && !Array.isArray(value) ? value : null;
const id = value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
const model = value => value === null || (id(value) && value.length <= 160 && /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(value));
const keysOnly = (value, names) => Object.keys(value).every(key => names.includes(key));
const bindingKeys = ["assignment_id", "session_id", "run_id", "generation", "principal_id", "document_fingerprint"];
const budgetKeys = ["max_reasoning_turns", "max_provider_calls", "max_operations", "max_equivalent_operations", "max_no_progress_epochs", "max_reconciliation_attempts", "max_wall_clock_ms", "max_total_tokens"];
function invalid(reason) { throw new TypeError("assignment_kernel_v2_publication_invalid:provider_usage_hold_" + reason); }

/** A safe display projection. Issued transport authority belongs to the controller,
 * not this parser or a caller's provider error text. Zero response receipts are valid. */
export function parseProviderUsageHoldV1(value, expectedBinding) {
  const hold = object(value), binding = object(hold?.binding), budget = object(hold?.resume_budget);
  if (!hold || !keysOnly(hold, ["schema", "hold_id", "binding", "attempt_id", "provider_thread_id", "provider_turn_id", "code", "recorded_at", "resume_budget", "worker_identity"])
      || hold.schema !== PROVIDER_USAGE_HOLD_V1_SCHEMA || hold.code !== "usageLimitExceeded"
      || ![hold.hold_id, hold.attempt_id, hold.provider_thread_id, hold.provider_turn_id].every(id)
      || typeof hold.recorded_at !== "string" || hold.recorded_at.length > 80 || !Number.isFinite(Date.parse(hold.recorded_at))) invalid("shape");
  if (!binding || !keysOnly(binding, bindingKeys) || ![binding.assignment_id, binding.session_id, binding.run_id, binding.principal_id].every(id)
      || !Number.isSafeInteger(binding.generation) || binding.generation < 1
      || (binding.document_fingerprint !== undefined && !id(binding.document_fingerprint))
      || expectedBinding && !bindingKeys.every(key => (binding[key] ?? null) === (expectedBinding[key] ?? null))) invalid("binding");
  if (!budget || !keysOnly(budget, budgetKeys) || !budgetKeys.every(key => Number.isSafeInteger(budget[key]) && budget[key] > 0 && budget[key] <= 2_147_483_647)) invalid("budget");
  let worker;
  if (hold.worker_identity !== undefined) {
    const row = object(hold.worker_identity);
    if (!row || !keysOnly(row, ["provider", "configured_billing_mode", "requested_model", "requested_reasoning_effort", "reported_model", "reported_model_source"])
        || row.provider !== "openai_codex" || !["chatgpt", "api_key", "unknown"].includes(row.configured_billing_mode)
        || !model(row.requested_model)
        || ![null, "none", "low", "medium", "high", "xhigh", "max"].includes(row.requested_reasoning_effort)
        || !model(row.reported_model)
        || ![null, "raw_response", "rerouted"].includes(row.reported_model_source)
        || (row.reported_model === null) !== (row.reported_model_source === null)) invalid("worker_identity");
    worker = { provider: row.provider, configured_billing_mode: row.configured_billing_mode,
      requested_model: row.requested_model, requested_reasoning_effort: row.requested_reasoning_effort,
      reported_model: row.reported_model, reported_model_source: row.reported_model_source };
  }
  return { schema: PROVIDER_USAGE_HOLD_V1_SCHEMA, hold_id: hold.hold_id, binding: { ...binding }, attempt_id: hold.attempt_id,
    provider_thread_id: hold.provider_thread_id, provider_turn_id: hold.provider_turn_id, code: hold.code,
    recorded_at: hold.recorded_at, resume_budget: { ...budget }, ...(worker ? { worker_identity: worker } : {}) };
}
