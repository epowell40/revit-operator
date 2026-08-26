import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export const ASSIGNMENT_KERNEL_V2_META_KEY = "revit-operator/assignment-kernel-v2" as const;
export const ASSIGNMENT_KERNEL_V2_BINDING_META_KEY = "revit-operator/assignment-kernel-binding-v2" as const;
export const ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA = "revit-operator.assignment-kernel-operation-context/v2" as const;
export const ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA = "revit-operator.assignment-kernel-mcp-result/v2" as const;
const OPERATION_RESULT_V2_SCHEMA = "revit-operator.operation-result/v2" as const;

type Scalar = string | number | boolean | null;
type Binding = {
  assignment_id: string;
  run_id: string;
  generation: number;
  session_id: string;
  principal_id: string;
  document_fingerprint?: string;
};
type Context = {
  schema: typeof ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA;
  assignment_id: string;
  binding: Binding;
  operation_id: string;
  capability_id: string;
  requested_effect: "read" | "preview" | "apply";
  purpose: "work" | "discovery" | "verification" | "evidence_read" | "reconciliation";
  opened_at: string;
  deadline_at: string;
};
type NativeCall = {
  request_id: string;
  method: string;
  path: string;
  state: "reserved" | "dispatching" | "completed";
  payload?: unknown;
};
type Scope = { context: Context; native_calls: NativeCall[] };

const storage = new AsyncLocalStorage<Scope>();
const bindingStorage = new AsyncLocalStorage<Binding>();

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, canonicalValue(item)]));
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function text(value: unknown, max = 500): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseContext(meta: unknown): Context | null {
  const source = object(object(meta)[ASSIGNMENT_KERNEL_V2_META_KEY]);
  if (source.schema !== ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA) return null;
  const binding = object(source.binding);
  const requestedEffect = source.requested_effect;
  const purpose = source.purpose;
  if (!text(source.assignment_id) || !text(source.operation_id) || !text(source.capability_id)
      || !text(source.opened_at) || !text(source.deadline_at)
      || !["read", "preview", "apply"].includes(String(requestedEffect))
      || !["work", "discovery", "verification", "evidence_read", "reconciliation"].includes(String(purpose))) {
    throw new Error("assignment_kernel_v2_operation_context_invalid");
  }
  for (const field of ["assignment_id", "run_id", "session_id", "principal_id"]) {
    if (!text(binding[field])) throw new Error("assignment_kernel_v2_operation_binding_invalid");
  }
  if (!Number.isSafeInteger(binding.generation) || Number(binding.generation) < 1
      || binding.assignment_id !== source.assignment_id) throw new Error("assignment_kernel_v2_operation_binding_invalid");
  return structuredClone(source) as Context;
}

function parseBinding(meta: unknown): Binding | null {
  const source = object(object(meta)[ASSIGNMENT_KERNEL_V2_BINDING_META_KEY]);
  if (Object.keys(source).length === 0) return null;
  for (const field of ["assignment_id", "run_id", "session_id", "principal_id"]) {
    if (!text(source[field])) throw new Error("assignment_kernel_v2_binding_context_invalid");
  }
  if (!Number.isSafeInteger(source.generation) || Number(source.generation) < 1) {
    throw new Error("assignment_kernel_v2_binding_context_invalid");
  }
  return structuredClone(source) as Binding;
}

export async function runWithAssignmentKernelV2<T>(meta: unknown, fn: () => Promise<T>): Promise<T> {
  const context = parseContext(meta);
  const binding = context?.binding ?? parseBinding(meta);
  if (!binding) return await fn();
  return await bindingStorage.run(binding, async () => context
    ? await storage.run({ context, native_calls: [] }, fn)
    : await fn());
}

export function currentAssignmentKernelV2Context(): Readonly<Context> | null {
  const scope = storage.getStore();
  return scope ? structuredClone(scope.context) : null;
}

export function currentAssignmentKernelV2Binding(): Readonly<Binding> | null {
  const binding = bindingStorage.getStore();
  return binding ? structuredClone(binding) : null;
}

export function reserveAssignmentKernelNativeRequestV2(method: string, path: string): string | null {
  const scope = storage.getStore();
  if (!scope) return null;
  const requestId = sha256({
    operation_id: scope.context.operation_id,
    native_call_index: scope.native_calls.length
  });
  scope.native_calls.push({
    request_id: requestId,
    method: String(method).toUpperCase(),
    path: String(path),
    state: "reserved"
  });
  return requestId;
}

export function markAssignmentKernelNativeRequestDispatchingV2(requestId: string | null): void {
  if (!requestId) return;
  const call = storage.getStore()?.native_calls.find(candidate => candidate.request_id === requestId);
  if (!call) throw new Error("assignment_kernel_v2_native_request_unknown");
  if (call.state === "completed") throw new Error("assignment_kernel_v2_native_request_already_completed");
  call.state = "dispatching";
}

export function recordAssignmentKernelNativeResultV2(method: string, path: string, payload: unknown, requestId?: string | null): void {
  const scope = storage.getStore();
  if (!scope) return;
  const id = requestId ?? reserveAssignmentKernelNativeRequestV2(method, path);
  const call = scope.native_calls.find(candidate => candidate.request_id === id);
  if (!call || call.method !== String(method).toUpperCase() || call.path !== String(path)) {
    throw new Error("assignment_kernel_v2_native_result_request_mismatch");
  }
  call.state = "completed";
  call.payload = structuredClone(payload);
}

function normalizedFieldName(value: string): string {
  return value.normalize("NFKC").replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[\s-]+/g, "_").toLowerCase();
}

function aliasedField(row: Record<string, unknown>, names: readonly string[]): unknown {
  const accepted = new Set(names.map(normalizedFieldName));
  const matches = Object.entries(row).filter(([key]) => accepted.has(normalizedFieldName(key)));
  if (matches.length === 0) return undefined;
  const values = new Set(matches.map(([, value]) => canonicalJson(value)));
  if (values.size !== 1) throw new Error(`assignment_kernel_v2_source_alias_conflict:${names[0]}`);
  return matches[0]![1];
}

function scalar(value: unknown): value is Scalar {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function candidateItems(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = object(payload);
  for (const name of ["items", "elements", "results", "rows", "schedules", "records"]) {
    const value = aliasedField(root, [name]);
    if (Array.isArray(value)) return value;
  }
  return [];
}

function semanticFacts(payload: unknown, nativeCallCount: number): Array<Record<string, unknown>> {
  const facts: Array<Record<string, unknown>> = [
    { fact_id: "result.available", value: true },
    { fact_id: "result.native_call_count", value: nativeCallCount },
    { fact_id: "result.payload_hash", value: sha256(payload) }
  ];
  const root = object(payload);
  const total = aliasedField(root, ["total", "total_count", "totalCount", "count"]);
  if (typeof total === "number" && Number.isFinite(total)) facts.push({ fact_id: "inventory.total", value: total });
  const items = candidateItems(payload);
  if (items.length > 0) facts.push({ fact_id: "inventory.total", value: typeof total === "number" ? total : items.length });
  const groups = new Map<string, { family: Scalar; type: Scalar; count: number }>();
  for (const candidate of items) {
    const row = object(candidate);
    const family = aliasedField(row, ["family", "family_name", "familyName"]);
    const type = aliasedField(row, ["type", "type_name", "typeName"]);
    if (!scalar(family) || !scalar(type)) continue;
    const key = canonicalJson([family, type]);
    const prior = groups.get(key);
    groups.set(key, { family, type, count: (prior?.count ?? 0) + 1 });
  }
  for (const group of [...groups.values()].sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)))) {
    facts.push({ fact_id: "inventory.group", value: group.count, dimensions: { family: group.family, type: group.type } });
  }
  for (const [key, value] of Object.entries(root)) {
    if (scalar(value) && facts.length < 256) facts.push({ fact_id: `result.field.${normalizedFieldName(key)}`, value });
  }
  return facts;
}

function directSettlement(payload: unknown): Record<string, unknown> {
  return object(object(payload).canonical_attempt_settlement);
}

function aggregatePayload(calls: readonly NativeCall[]): unknown {
  return calls.length === 1 ? calls[0]!.payload : { native_results: calls.map(call => call.payload) };
}

function decoratedResult(result: unknown, capabilityId: string, scope: Scope): unknown {
  const calls = scope.native_calls;
  const completedCalls = calls.filter(call => call.state === "completed");
  const failed = Boolean(object(result).isError);
  if (!failed && completedCalls.length !== calls.length) throw new Error("assignment_kernel_v2_native_result_missing");
  const payload = completedCalls.length > 0 ? aggregatePayload(completedCalls) : result;
  const settlements = completedCalls.map(call => directSettlement(call.payload)).filter(row => Object.keys(row).length > 0);
  const retainedEvidenceRead = calls.length === 0 && scope.context.purpose === "evidence_read" && !failed;
  if (completedCalls.length > 0 && settlements.length !== completedCalls.length) throw new Error("assignment_kernel_v2_native_settlement_missing");
  const settlementEffects = settlements.map(row => text(row.effect_state));
  const persistentEffect = settlementEffects.includes("unknown") ? "unknown"
    : settlementEffects.includes("applied") ? "applied" : "none";
  if (scope.context.requested_effect === "read" && persistentEffect !== "none") throw new Error("assignment_kernel_v2_read_effect_conflict");
  if (scope.context.requested_effect !== "apply" && persistentEffect === "applied") throw new Error("assignment_kernel_v2_effect_exceeds_operation");
  const now = new Date().toISOString();
  const dispatchState = completedCalls.length > 0 || retainedEvidenceRead ? "dispatched"
    : calls.some(call => call.state === "dispatching") ? "dispatching" : "not_dispatched";
  const nativeTransactionState = persistentEffect === "applied" ? "committed"
    : scope.context.requested_effect === "preview" && !failed && calls.length > 0 ? "rolled_back"
      : persistentEffect === "unknown" ? "unknown" : "not_applicable";
  const operationResult = {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `resultv2_${sha256({ operation_id: scope.context.operation_id, payload, failed })}`,
    operation_id: scope.context.operation_id,
    binding: scope.context.binding,
    status: failed ? dispatchState === "not_dispatched" ? "failed_before_dispatch" : "failed_after_dispatch"
      : completedCalls.length > 0 || retainedEvidenceRead ? "succeeded" : "failed_before_dispatch",
    dispatch_state: dispatchState,
    persistent_effect: persistentEffect,
    native_transaction_state: nativeTransactionState,
    authority: completedCalls.length > 0 ? "native-host" : retainedEvidenceRead ? "operator-evidence-store" : "operator-mcp-transport",
    result_schema_id: `operator-capability/${capabilityId}/v2`,
    observation_required: (completedCalls.length > 0 || retainedEvidenceRead) && !failed,
    ...((completedCalls.length > 0 || retainedEvidenceRead) && !failed ? { raw_payload_hash: sha256(payload) } : {}),
    ...(text(settlements[0]?.attempt_id) ? { receipt_id: text(settlements[0]?.attempt_id) } : {}),
    ...(calls[0]?.request_id ? { native_correlation_id: calls[0].request_id } : {}),
    completed_at: now,
    ...(!failed && completedCalls.length > 0 ? {} : { error_code: failed ? "mcp_tool_failed" : "native_operation_not_observed" })
  };
  const root = object(result);
  return {
    ...root,
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: operationResult,
      ...(operationResult.observation_required ? {
        observation: {
          raw_payload: payload,
          semantic_facts: semanticFacts(payload, calls.length),
          target_scope: {},
          verification_relevance: scope.context.purpose === "verification" ? ["postcondition"] : ["task_result"]
        }
      } : {})
    }
  };
}

export function decorateAssignmentKernelMcpResultV2(result: unknown, capabilityId: string): unknown {
  const scope = storage.getStore();
  return scope ? decoratedResult(result, capabilityId, scope) : result;
}
