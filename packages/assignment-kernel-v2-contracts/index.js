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
