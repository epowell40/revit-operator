import { AsyncLocalStorage } from "node:async_hooks";
import {
  canonicalPayloadJsonV2,
  payloadDigestV2,
  payloadRepresentationDigestV2
} from "@revitoperator/payload-digest-v2";
import {
  OPERATION_RESULT_SEMANTIC_GAP_V2_SCHEMA,
  assignmentKernelControlEvidenceFactsV2,
  isAssignmentKernelDurableControlEvidenceProducerV2
} from "@revitoperator/assignment-kernel-v2-contracts";
import { createOperatorBackendClient } from "./operatorBackendClient.js";
import { previewSemanticEvidenceV2 } from "./previewSemanticEvidenceV2.js";

export const ASSIGNMENT_KERNEL_V2_META_KEY = "revit-operator/assignment-kernel-v2" as const;
export const ASSIGNMENT_KERNEL_V2_BINDING_META_KEY = "revit-operator/assignment-kernel-binding-v2" as const;
export const ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA = "revit-operator.assignment-kernel-operation-context/v2" as const;
export const ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA = "revit-operator.assignment-kernel-mcp-result/v2" as const;
const OPERATION_RESULT_V2_SCHEMA = "revit-operator.operation-result/v2" as const;
const OPERATION_INPUT_SCHEMA_GAP_V2_SCHEMA = "revit-operator.operation-input-schema-gap/v2" as const;

type Scalar = string | number | boolean | null;
type ClassifiedEffect = "read" | "preview" | "apply";
type FulfillmentRole = "supporting_control" | "prerequisite" | "delegated_task_execution" | "verification" | "reconciliation" | "telemetry";
type EvidenceClass = "control" | "prerequisite" | "task_result" | "verification" | "reconciliation" | "telemetry";
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
  operation_role: "root" | "prerequisite" | "child";
  parent_operation_id?: string;
  root_operation_id: string;
  blocks_parent_settlement: boolean;
  fulfillment_role: FulfillmentRole;
  delegation_authority_id?: string;
  eligible_criterion_ids: string[];
  request_identity: RequestIdentity;
  opened_at: string;
  deadline_at: string;
};
type RequestIdentity = {
  capability_id: string;
  method?: "GET" | "POST";
  path?: string;
  request_signature: string;
};
type NativeCall = {
  request_id: string;
  operation_id: string;
  parent_operation_id?: string;
  operation_role: "root" | "prerequisite" | "child";
  classified_effect: ClassifiedEffect;
  lease: Context;
  method: string;
  path: string;
  body?: unknown;
  state: "reserved" | "dispatching" | "completed";
  payload?: unknown;
  observation_payload?: unknown;
  payload_provenance?: ReturnType<typeof payloadProvenance>;
  settlement?: unknown;
};
type ChildAdmissionInput = {
  parent_operation_id: string;
  child_ordinal: number;
  operation_role: "prerequisite" | "child";
  capability_id: string;
  classified_effect: string;
  method: "GET" | "POST";
  path: string;
  arguments: unknown;
  blocks_parent_settlement: boolean;
  fulfillment_role: FulfillmentRole;
  delegation_authority_id?: string;
  eligible_criterion_ids: string[];
};
type OperationEdge = {
  openChild(input: ChildAdmissionInput, binding: Binding): Promise<Context>;
  markDispatch(lease: Context): Promise<void>;
  settle(lease: Context, mcpResult: unknown): Promise<unknown>;
};
type Scope = { context: Context; native_calls: NativeCall[]; parent_claimed: boolean; edge: OperationEdge };

export type AssignmentKernelNativeRequestV2 = Readonly<{
  request_id: string;
  operation_id: string;
  operation_role: "root" | "prerequisite" | "child";
  parent_operation_id?: string;
}>;

const storage = new AsyncLocalStorage<Scope>();
const bindingStorage = new AsyncLocalStorage<Binding>();

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function canonicalJson(value: unknown): string {
  return canonicalPayloadJsonV2(value);
}

function sha256(value: unknown): string {
  return payloadDigestV2(value).digest;
}

function payloadProvenance(sourceValue: unknown, normalizedValue: unknown, transformationId: string) {
  const sourceJson = JSON.stringify(sourceValue);
  if (sourceJson === undefined) throw new Error("assignment_kernel_v2_payload_not_json_serializable");
  return {
    schema: "revit-operator.payload-provenance/v2",
    source: payloadRepresentationDigestV2(Buffer.from(sourceJson, "utf8"), "utf8_json_bytes"),
    normalized: payloadDigestV2(normalizedValue),
    transformation_id: transformationId,
    transformation_version: "1"
  };
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
  const role = source.operation_role ?? "root";
  const requestIdentity = object(source.request_identity);
  if (!text(source.assignment_id) || !text(source.operation_id) || !text(source.capability_id)
      || !text(source.opened_at) || !text(source.deadline_at)
      || !["read", "preview", "apply"].includes(String(requestedEffect))
      || !["work", "discovery", "verification", "evidence_read", "reconciliation"].includes(String(purpose))
      || !["root", "prerequisite", "child"].includes(String(role))
      || !["supporting_control", "prerequisite", "delegated_task_execution", "verification", "reconciliation", "telemetry"].includes(String(source.fulfillment_role))
      || !Array.isArray(source.eligible_criterion_ids)
      || ((source.fulfillment_role === "delegated_task_execution" || source.fulfillment_role === "verification")
        && !text(source.delegation_authority_id))
      || !text(source.root_operation_id ?? source.operation_id)
      || !text(requestIdentity.capability_id)
      || !text(requestIdentity.request_signature)) {
    throw new Error("assignment_kernel_v2_operation_context_invalid");
  }
  for (const field of ["assignment_id", "run_id", "session_id", "principal_id"]) {
    if (!text(binding[field])) throw new Error("assignment_kernel_v2_operation_binding_invalid");
  }
  if (!Number.isSafeInteger(binding.generation) || Number(binding.generation) < 1
      || binding.assignment_id !== source.assignment_id) throw new Error("assignment_kernel_v2_operation_binding_invalid");
  return structuredClone({
    ...source,
    operation_role: role,
    root_operation_id: source.root_operation_id ?? source.operation_id,
    blocks_parent_settlement: source.blocks_parent_settlement === true,
    request_identity: requestIdentity
  }) as Context;
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

function bindingBody(binding: Binding): Record<string, unknown> {
  return {
    assignment_id: binding.assignment_id,
    run_id: binding.run_id,
    generation: binding.generation,
    session_id: binding.session_id
  };
}

function defaultOperationEdge(): OperationEdge {
  const client = createOperatorBackendClient();
  return {
    async openChild(input, binding) {
      const response = object(await client.openAssignmentChildOperationV2({ ...bindingBody(binding), ...input }));
      const lease = object(response.operation_lease_v2);
      if (lease.schema !== ASSIGNMENT_KERNEL_OPERATION_CONTEXT_V2_SCHEMA) {
        throw new Error("assignment_kernel_v2_child_operation_admission_invalid");
      }
      return structuredClone(lease) as Context;
    },
    async markDispatch(lease) {
      await client.markAssignmentOperationDispatchV2({
        ...bindingBody(lease.binding),
        operation_id: lease.operation_id
      });
    },
    async settle(lease, mcpResult) {
      return await client.settleAssignmentOperationV2({
        ...bindingBody(lease.binding),
        operation_id: lease.operation_id,
        mcp_result: mcpResult
      });
    }
  };
}

export async function runWithAssignmentKernelV2<T>(meta: unknown, fn: () => Promise<T>, edge?: OperationEdge): Promise<T> {
  const context = parseContext(meta);
  const binding = context?.binding ?? parseBinding(meta);
  if (!binding) return await fn();
  return await bindingStorage.run(binding, async () => context
    ? await storage.run({ context, native_calls: [], parent_claimed: false, edge: edge ?? defaultOperationEdge() }, fn)
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

function nativeRequestIdentity(method: "GET" | "POST", path: string, body: unknown): RequestIdentity {
  const capabilityId = `native:${method}:${path}`;
  return {
    capability_id: capabilityId,
    method,
    path,
    request_signature: sha256({ capability_id: capabilityId, method, path, body: body ?? null })
  };
}

/**
 * A reviewed MCP handler calls this only for the one native action that is
 * intended to fulfill its admitted task. Supporting and prerequisite calls do
 * not opt in and therefore remain deny-by-default control evidence.
 */
export function currentAssignmentKernelTaskFulfillmentRoleV2(): "delegated_task_execution" | "verification" | undefined {
  const role = storage.getStore()?.context.fulfillment_role;
  return role === "delegated_task_execution" || role === "verification" ? role : undefined;
}

function evidenceClass(role: FulfillmentRole): EvidenceClass {
  return ({
    supporting_control: "control",
    prerequisite: "prerequisite",
    delegated_task_execution: "task_result",
    verification: "verification",
    reconciliation: "reconciliation",
    telemetry: "telemetry"
  } as const)[role];
}

function nativeChildFulfillmentRole(_path: string, topology: "prerequisite" | "child", explicit?: FulfillmentRole): FulfillmentRole {
  if (topology === "prerequisite") return "prerequisite";
  if (explicit) return explicit;
  return "supporting_control";
}

function operationMatchesNativeRequest(
  context: Context,
  request: RequestIdentity,
  body: unknown,
  classifiedEffect: ClassifiedEffect
): boolean {
  const expected = context.request_identity;
  // A typed MCP capability and a native route are different executable
  // identities unless the trusted controller admitted the exact native
  // method/path. Never let the first hidden native call opportunistically
  // claim an abstract typed parent.
  if (context.requested_effect !== classifiedEffect
      || !expected.method || !expected.path
      || expected.method !== request.method
      || expected.path !== request.path) return false;
  if (context.capability_id === "revit_call_tool") {
    return expected.request_signature === sha256({
      capability_id: context.capability_id,
      method: request.method,
      path: request.path,
      body: body ?? null
    });
  }
  return context.capability_id === request.capability_id
    && expected.request_signature === request.request_signature;
}

export async function beginAssignmentKernelNativeRequestV2(
  methodValue: string,
  pathValue: string,
  body?: unknown,
  options: Readonly<{
    operation_role?: "prerequisite" | "child";
    fulfillment_role?: FulfillmentRole;
    classified_effect?: string;
    blocks_parent_settlement?: boolean;
  }> = {}
): Promise<AssignmentKernelNativeRequestV2 | null> {
  const scope = storage.getStore();
  if (!scope) return null;
  const method = String(methodValue).trim().toUpperCase();
  if (method !== "GET" && method !== "POST") throw new Error("assignment_kernel_v2_native_request_method_invalid");
  const path = String(pathValue).trim();
  if (!path.startsWith("/")) throw new Error("assignment_kernel_v2_native_request_path_invalid");
  const identity = nativeRequestIdentity(method, path, body);
  const classifiedEffectValue = options.classified_effect ?? scope.context.requested_effect;
  if (!['read', 'preview', 'apply'].includes(classifiedEffectValue)) {
    throw new Error("assignment_kernel_v2_native_effect_classification_invalid");
  }
  const classifiedEffect = classifiedEffectValue as ClassifiedEffect;
  const parentMatches = operationMatchesNativeRequest(scope.context, identity, body, classifiedEffect);
  const useParent = !options.operation_role && !scope.parent_claimed && parentMatches;
  let lease: Context;
  let role: "root" | "prerequisite" | "child";
  if (useParent) {
    scope.parent_claimed = true;
    lease = scope.context;
    role = "root";
  } else {
    role = options.operation_role ?? "child";
    const taskFulfillmentRequested = options.fulfillment_role === "delegated_task_execution"
      || options.fulfillment_role === "verification";
    const fulfillmentRole = nativeChildFulfillmentRole(
      path,
      role,
      taskFulfillmentRequested && classifiedEffect !== scope.context.requested_effect
        ? undefined
        : options.fulfillment_role
    );
    lease = await scope.edge.openChild({
      parent_operation_id: scope.context.operation_id,
      child_ordinal: scope.native_calls.length,
      operation_role: role,
      capability_id: identity.capability_id,
      classified_effect: classifiedEffect,
      method,
      path,
      arguments: { method, path, body: body ?? null },
      blocks_parent_settlement: options.blocks_parent_settlement !== false,
      fulfillment_role: fulfillmentRole,
      ...((fulfillmentRole === "delegated_task_execution" || fulfillmentRole === "verification") && scope.context.delegation_authority_id
        ? { delegation_authority_id: scope.context.delegation_authority_id }
        : {}),
      eligible_criterion_ids: fulfillmentRole === "delegated_task_execution" || fulfillmentRole === "verification"
        ? [...scope.context.eligible_criterion_ids]
        : []
    }, scope.context.binding);
    if (lease.operation_id === scope.context.operation_id || lease.parent_operation_id !== scope.context.operation_id) {
      throw new Error("assignment_kernel_v2_child_operation_identity_invalid");
    }
    if (lease.requested_effect !== classifiedEffect) {
      throw new Error("assignment_kernel_v2_child_effect_classification_mismatch");
    }
  }
  const requestId = sha256({
    operation_id: lease.operation_id,
    request_identity: identity,
    native_call_index: scope.native_calls.length
  });
  scope.native_calls.push({
    request_id: requestId,
    operation_id: lease.operation_id,
    ...(role === "root" ? {} : { parent_operation_id: scope.context.operation_id }),
    operation_role: role,
    classified_effect: classifiedEffect,
    lease,
    method,
    path,
    ...(body === undefined ? {} : { body: structuredClone(body) }),
    state: "reserved"
  });
  return Object.freeze({
    request_id: requestId,
    operation_id: lease.operation_id,
    operation_role: role,
    ...(role === "root" ? {} : { parent_operation_id: scope.context.operation_id })
  });
}

function nativeCall(request: AssignmentKernelNativeRequestV2 | null): NativeCall | null {
  if (!request) return null;
  const call = storage.getStore()?.native_calls.find(candidate => candidate.request_id === request.request_id);
  if (!call || call.operation_id !== request.operation_id) throw new Error("assignment_kernel_v2_native_request_unknown");
  return call;
}

export async function markAssignmentKernelNativeRequestDispatchingV2(request: AssignmentKernelNativeRequestV2 | null): Promise<void> {
  const call = nativeCall(request);
  if (!call) return;
  if (call.state === "completed") throw new Error("assignment_kernel_v2_native_request_already_completed");
  if (call.state === "dispatching") return;
  if (call.operation_role !== "root") await storage.getStore()!.edge.markDispatch(call.lease);
  call.state = "dispatching";
}

export async function recordAssignmentKernelNativeResultV2(
  method: string,
  path: string,
  payload: unknown,
  request: AssignmentKernelNativeRequestV2 | null
): Promise<void> {
  const scope = storage.getStore();
  if (!scope) return;
  const call = nativeCall(request);
  if (!call || call.method !== String(method).toUpperCase() || call.path !== String(path)) {
    throw new Error("assignment_kernel_v2_native_result_request_mismatch");
  }
  if (call.state === "completed") return;
  call.payload = structuredClone(payload);
  call.observation_payload = observationPayload(call.payload);
  call.payload_provenance = payloadProvenance(
    call.payload,
    call.observation_payload,
    "revit-operator.native-result-control-extraction"
  );
  if (call.operation_role !== "root") {
    const result = operationResultForCall(call, false);
    const settlementEnvelope = mcpEnvelopeForCall(call, result);
    call.settlement = await scope.edge.settle(call.lease, settlementEnvelope);
  }
  call.state = "completed";
}

export async function recordAssignmentKernelNativeFailureV2(
  request: AssignmentKernelNativeRequestV2 | null,
  error: unknown
): Promise<void> {
  const scope = storage.getStore();
  const call = nativeCall(request);
  if (!scope || !call || call.state === "completed") return;
  const errorRecord = object(error);
  const bridgeDetails = object(errorRecord.bridgeDetails);
  const phase = text(errorRecord.phase) || text(bridgeDetails.phase);
  const outcomeUnknown = errorRecord.outcomeUnknown === true || errorRecord.outcome_unknown === true;
  const explicitlyNotDispatched = errorRecord.request_dispatched === false
    || bridgeDetails.request_dispatched === false
    || bridgeDetails.dispatched === false
    || ["pre_dispatch", "request_validation", "authentication", "authorization", "write_grant", "admission", "routing"].includes(phase);
  const explicitlyDispatched = errorRecord.request_dispatched === true
    || bridgeDetails.request_dispatched === true
    || bridgeDetails.dispatched === true
    || typeof errorRecord.status === "number"
    || phase === "response";
  call.payload = {
    error_code: text(errorRecord.code) || "native_operation_failed",
    outcome_unknown: outcomeUnknown,
    native_dispatch_state: explicitlyNotDispatched ? "not_dispatched"
      : explicitlyDispatched ? "dispatched"
        : outcomeUnknown ? "dispatching" : "not_dispatched"
  };
  if (call.operation_role !== "root") {
    const result = operationResultForCall(call, true);
    call.settlement = await scope.edge.settle(call.lease, mcpEnvelopeForCall(call, result));
  }
  call.state = "completed";
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

function nativeDomainFailure(payload: unknown): boolean {
  const root = object(payload);
  return aliasedField(root, ["ok"]) === false || aliasedField(root, ["success"]) === false;
}

function nativeDomainFailureCode(payload: unknown): string {
  const root = object(payload);
  return text(aliasedField(root, ["error_code", "errorCode", "code"])) || "native_domain_operation_failed";
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

function quantifyGroupDimensions(body: unknown): string[] {
  const declared = aliasedField(object(body), ["group_by", "groupBy"]);
  const names = Array.isArray(declared)
    ? declared.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .slice(0, 3)
        .map(normalizedFieldName)
    : [];
  return names.length > 0 ? names : ["type"];
}

function semanticFacts(
  payload: unknown,
  nativeCallCount: number,
  evidence: EvidenceClass,
  path: string,
  requestBody?: unknown,
  requestedEffect?: Context["requested_effect"],
  authoritativePreview = false,
  controlCapabilityId?: string,
  taskResultAdmitted = true
): Array<Record<string, unknown>> {
  const domainSucceeded = !nativeDomainFailure(payload);
  const facts: Array<Record<string, unknown>> = [
    { fact_id: "control.result_available", fact_class: "control", value: true },
    { fact_id: "control.domain_succeeded", fact_class: "control", value: domainSucceeded },
    { fact_id: "control.native_call_count", fact_class: "control", value: nativeCallCount },
    { fact_id: "control.payload_hash", fact_class: "control", value: sha256(payload) }
  ];
  if (evidence === "task_result" && domainSucceeded && taskResultAdmitted) {
    facts.push({ fact_id: "task.result_available", fact_class: "domain", value: true });
  }
  const root = object(payload);
  const textNoteResult = evidence === "task_result"
    && domainSucceeded
    && ["/revit/replace-text-note", "/revit/set-text-note-text"].includes(path.toLowerCase());
  if (textNoteResult) {
    facts.push(...previewSemanticEvidenceV2({
      path,
      payload,
      requestBody,
      requestedEffect,
      authoritativePreview
    }).facts);
  }
  const summary = object(aliasedField(root, ["summary"]));
  const rootTotal = aliasedField(root, ["total", "total_count", "totalCount", "count"]);
  const total = rootTotal === undefined
    ? aliasedField(summary, ["total", "total_count", "totalCount", "count"])
    : rootTotal;
  const inventory = evidence === "task_result" && domainSucceeded && taskResultAdmitted && path.toLowerCase() === "/revit/quantify";
  if (inventory && typeof total === "number" && Number.isFinite(total)) {
    facts.push({ fact_id: "inventory.complete", fact_class: "domain", value: true });
    facts.push({ fact_id: "inventory.total", fact_class: "domain", value: total });
  }
  const items = candidateItems(payload);
  if (inventory && items.length > 0 && !(typeof total === "number" && Number.isFinite(total))) {
    facts.push({ fact_id: "inventory.complete", fact_class: "domain", value: true });
    facts.push({ fact_id: "inventory.total", fact_class: "domain", value: items.length });
  }
  const groups = new Map<string, { dimensions: Record<string, Scalar>; count: number }>();
  const rootGroups = aliasedField(root, ["groups", "grouped_counts", "groupedCounts"]);
  const declaredGroups = rootGroups === undefined
    ? aliasedField(summary, ["groups", "grouped_counts", "groupedCounts"])
    : rootGroups;
  const groupCandidates = Array.isArray(declaredGroups)
    ? declaredGroups
    : Object.keys(object(declaredGroups)).length > 0 ? [] : items;
  for (const candidate of groupCandidates) {
    const row = object(candidate);
    const family = aliasedField(row, ["family", "family_name", "familyName"]);
    const type = aliasedField(row, ["type", "type_name", "typeName"]);
    if (!scalar(family) || !scalar(type)) continue;
    const dimensions = { family, type };
    const key = canonicalJson(dimensions);
    const prior = groups.get(key);
    const declaredCount = aliasedField(row, ["count", "total", "quantity"]);
    const count = typeof declaredCount === "number" && Number.isFinite(declaredCount) ? declaredCount : 1;
    groups.set(key, { dimensions, count: (prior?.count ?? 0) + count });
  }
  if (inventory && declaredGroups && !Array.isArray(declaredGroups)) {
    const dimensionNames = quantifyGroupDimensions(requestBody);
    for (const [groupKey, declaredCount] of Object.entries(object(declaredGroups))) {
      if (typeof declaredCount !== "number" || !Number.isFinite(declaredCount)) continue;
      const values = groupKey.split(" | ");
      if (values.length !== dimensionNames.length) continue;
      const dimensions = Object.fromEntries(dimensionNames.map((name, index) => [name, values[index]!])) as Record<string, Scalar>;
      const key = canonicalJson(dimensions);
      const prior = groups.get(key);
      groups.set(key, { dimensions, count: (prior?.count ?? 0) + declaredCount });
    }
  }
  for (const group of [...groups.values()].sort((left, right) => {
    const leftJson = canonicalJson(left);
    const rightJson = canonicalJson(right);
    return leftJson < rightJson ? -1 : leftJson > rightJson ? 1 : 0;
  })) {
    if (inventory) facts.push({ fact_id: "inventory.group", fact_class: "domain", value: group.count, dimensions: group.dimensions });
  }
  if (evidence === "control" && controlCapabilityId) {
    facts.push(...assignmentKernelControlEvidenceFactsV2(
      controlCapabilityId,
      semanticPayloadFromMcpResult(payload)
    ).map(fact => ({ ...fact })));
  }
  for (const [key, value] of Object.entries(root)) {
    if (scalar(value) && facts.length < 256) facts.push({ fact_id: `control.field.${normalizedFieldName(key)}`, fact_class: "control", value });
  }
  return facts;
}

function directSettlement(payload: unknown): Record<string, unknown> {
  return object(object(payload).canonical_attempt_settlement);
}

function observationPayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return structuredClone(payload);
  return Object.fromEntries(Object.entries(payload as Record<string, unknown>)
    .filter(([key]) => key !== "canonical_attempt_settlement")
    .map(([key, value]) => [key, structuredClone(value)]));
}

function semanticPayloadFromMcpResult(payload: unknown): unknown {
  const root = object(payload);
  const structured = object(root.structuredContent ?? root.structured_content);
  if (Object.keys(structured).length > 0) return structured;
  const content = Array.isArray(root.content) ? root.content : [];
  for (const itemValue of content.slice(0, 8)) {
    const item = object(itemValue);
    if (item.type !== "text" || typeof item.text !== "string") continue;
    try {
      return JSON.parse(item.text);
    } catch {
      // Non-JSON text remains part of the exact raw payload but cannot mint
      // structured capability knowledge.
    }
  }
  return root;
}

function operationResultForCall(call: NativeCall, transportFailed: boolean): Record<string, unknown> {
  const settlement = directSettlement(call.payload);
  if (!transportFailed && Object.keys(settlement).length === 0) throw new Error("assignment_kernel_v2_native_settlement_missing");
  const domainFailed = !transportFailed && nativeDomainFailure(call.observation_payload);
  const failed = transportFailed || domainFailed;
  const failureDispatchState = text(object(call.payload).native_dispatch_state);
  const dispatchState = transportFailed
    ? failureDispatchState === "dispatched" ? "dispatched"
      : failureDispatchState === "dispatching" ? "dispatching"
        : "not_dispatched"
    : settlement.request_dispatched === true ? "dispatched" : "not_dispatched";
  const dispatched = dispatchState !== "not_dispatched";
  const outcomeUnknown = object(call.payload).outcome_unknown === true;
  const persistentEffect = text(settlement.effect_state)
    || (transportFailed && dispatched && call.lease.requested_effect === "apply" && outcomeUnknown ? "unknown" : "none");
  if (!['none', 'unknown', 'applied'].includes(persistentEffect)) throw new Error("assignment_kernel_v2_native_effect_invalid");
  if (call.lease.requested_effect === "read" && persistentEffect !== "none") throw new Error("assignment_kernel_v2_read_effect_conflict");
  if (call.lease.requested_effect !== "apply" && persistentEffect === "applied") throw new Error("assignment_kernel_v2_effect_exceeds_operation");
  const nativeTransactionState = persistentEffect === "applied" ? "committed"
    : call.lease.requested_effect === "preview" && !transportFailed && dispatched ? "rolled_back"
      : persistentEffect === "unknown" ? "unknown" : "not_applicable";
  const provenance = transportFailed ? undefined : call.payload_provenance;
  if (!transportFailed && (!provenance || call.observation_payload === undefined)) {
    throw new Error("assignment_kernel_v2_observation_payload_not_captured");
  }
  const resultSchemaId = `operator-native/${call.method}:${call.path}/v2`;
  const authoritativeTaskPreview = !failed
    && call.lease.fulfillment_role === "delegated_task_execution"
    && call.lease.requested_effect === "preview"
    && dispatched
    && persistentEffect === "none"
    && nativeTransactionState === "rolled_back";
  const previewEvidence = authoritativeTaskPreview ? previewSemanticEvidenceV2({
    path: call.path,
    payload: call.observation_payload,
    requestBody: call.body,
    requestedEffect: call.lease.requested_effect,
    authoritativePreview: true
  }) : null;
  const resultSemanticReason = previewEvidence && !previewEvidence.admitted
    ? previewEvidence.recognized ? "preview_result_contract_invalid" : "preview_semantic_adapter_missing"
    : null;
  const resultFailed = failed || resultSemanticReason !== null;
  return {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `resultv2_${sha256({ operation_id: call.operation_id, payload: call.payload, failed: resultFailed, result_semantic_reason: resultSemanticReason })}`,
    operation_id: call.operation_id,
    binding: call.lease.binding,
    status: resultFailed ? dispatched ? "failed_after_dispatch" : "failed_before_dispatch" : "succeeded",
    dispatch_state: dispatchState,
    persistent_effect: persistentEffect,
    native_transaction_state: nativeTransactionState,
    authority: "native-host",
    result_schema_id: resultSchemaId,
    observation_required: !transportFailed,
    ...(!transportFailed && provenance ? {
      raw_payload_hash: provenance.normalized.digest,
      payload_provenance: provenance
    } : {}),
    ...(text(settlement.attempt_id) ? { receipt_id: text(settlement.attempt_id) } : {}),
    native_correlation_id: call.request_id,
    request_identity: call.lease.request_identity,
    completed_at: new Date().toISOString(),
    ...(resultSemanticReason ? { result_semantic_gap: {
      schema: OPERATION_RESULT_SEMANTIC_GAP_V2_SCHEMA,
      gap_id: `result-semantics:${call.operation_id}`,
      operation_id: call.operation_id,
      capability_id: call.lease.capability_id,
      result_schema_id: resultSchemaId,
      reason_code: resultSemanticReason,
      retryable: false,
      provider_correctable: false,
      native_replay_allowed: false
    } } : {}),
    ...(transportFailed ? { error_code: "native_operation_failed" }
      : domainFailed ? { error_code: nativeDomainFailureCode(call.observation_payload) }
        : resultSemanticReason ? { error_code: resultSemanticReason }
          : {})
  };
}

function mcpEnvelopeForCall(call: NativeCall, operationResult: Record<string, unknown>): Record<string, unknown> {
  const observationClass = evidenceClass(call.lease.fulfillment_role);
  const authoritativePreview = call.classified_effect === "preview"
    && operationResult.status === "succeeded"
    && operationResult.dispatch_state === "dispatched"
    && operationResult.persistent_effect === "none"
    && operationResult.native_transaction_state === "rolled_back";
  return {
    content: [],
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: operationResult,
      ...(operationResult.observation_required ? {
        observation: {
          raw_payload: call.observation_payload,
          semantic_facts: semanticFacts(
            call.observation_payload,
            1,
            observationClass,
            call.path,
            call.body,
            call.lease.requested_effect,
            authoritativePreview,
            undefined,
            operationResult.status === "succeeded"
          ),
          target_scope: {},
          verification_relevance: [observationClass],
          evidence_class: observationClass
        }
      } : {})
    }
  };
}

function transportOnlyResult(
  context: Context,
  payload: unknown,
  failed: boolean,
  observationAuthority?: "operator-evidence-store" | "operator-mcp-transport"
): Record<string, unknown> {
  const observationBearing = Boolean(observationAuthority) && !failed;
  const provenance = observationBearing
    ? payloadProvenance(payload, payload, "revit-operator.parsed-json-to-canonical-payload")
    : undefined;
  const failure = object(object(payload).structuredContent ?? object(payload).structured_content);
  const validationIssues = Array.isArray(failure.validation_issues)
    ? failure.validation_issues.map(candidate => object(candidate)).filter(candidate =>
      text(candidate.field_path) && text(candidate.expected_type) && text(candidate.actual_type))
    : [];
  const inputSchemaGap = failed
    && failure.schema === "revit-operator.mcp-pre-dispatch-failure.v1"
    && failure.code === "mcp_request_validation_failed"
    && failure.request_dispatched === false
    && validationIssues.length > 0
    ? {
        schema: OPERATION_INPUT_SCHEMA_GAP_V2_SCHEMA,
        gap_id: `input-schema:${context.operation_id}`,
        operation_id: context.operation_id,
        capability_id: context.capability_id,
        input_schema_id: text(failure.input_schema_id) || `operator-capability/${context.capability_id}/input/v2`,
        input_schema_digest: text(failure.input_schema_digest),
        method: context.request_identity.method ?? "POST",
        path: context.request_identity.path ?? text(failure.path),
        request_signature: context.request_identity.request_signature,
        dispatch: false,
        effect: "none",
        issues: validationIssues.map(issue => ({
          field_path: text(issue.field_path),
          expected_type: text(issue.expected_type),
          actual_type: text(issue.actual_type),
          safe_correction_eligibility: issue.safe_correction_eligibility === "declared_deterministic_coercion"
            ? "declared_deterministic_coercion"
            : "provider_corrected_arguments_required",
          correction_action: issue.correction_action === "wrap_scalar_as_singleton_array"
            ? "wrap_scalar_as_singleton_array"
            : "provider_resubmit",
          expected_constraint: structuredClone(object(issue.expected_constraint))
        }))
      }
    : undefined;
  return {
    schema: OPERATION_RESULT_V2_SCHEMA,
    result_id: `resultv2_${sha256({ operation_id: context.operation_id, payload, failed })}`,
    operation_id: context.operation_id,
    binding: context.binding,
    status: failed ? "failed_before_dispatch"
      : observationBearing ? "succeeded" : "completed_without_native_dispatch",
    dispatch_state: observationBearing ? "dispatched" : "not_dispatched",
    persistent_effect: "none",
    native_transaction_state: "not_applicable",
    authority: observationAuthority ?? "operator-mcp-transport",
    result_schema_id: `operator-capability/${context.capability_id}/v2`,
    observation_required: observationBearing,
    ...(observationBearing && provenance ? {
      raw_payload_hash: provenance.normalized.digest,
      payload_provenance: provenance
    } : {}),
    request_identity: context.request_identity,
    completed_at: new Date().toISOString(),
    ...(failed ? { error_code: "mcp_tool_failed" } : {}),
    ...(inputSchemaGap ? { input_schema_gap: inputSchemaGap } : {})
  };
}

function decoratedResult(result: unknown, capabilityId: string, scope: Scope): unknown {
  const calls = scope.native_calls;
  if (calls.some(call => call.state !== "completed")) throw new Error("assignment_kernel_v2_native_result_missing");
  const failed = Boolean(object(result).isError);
  const parentCall = calls.find(call => call.operation_role === "root");
  const retainedEvidenceRead = !parentCall && scope.context.purpose === "evidence_read" && !failed;
  const retainedControlEvidence = !parentCall
    && !failed
    && scope.context.requested_effect === "read"
    && capabilityId === scope.context.capability_id
    && isAssignmentKernelDurableControlEvidenceProducerV2(scope.context.capability_id);
  const observationAuthority = retainedEvidenceRead ? "operator-evidence-store" as const
    : retainedControlEvidence ? "operator-mcp-transport" as const
      : undefined;
  const operationResult = parentCall
    ? operationResultForCall(parentCall, failed)
    : transportOnlyResult(scope.context, result, failed, observationAuthority);
  const authoritativeParentPreview = parentCall
    ? parentCall.classified_effect === "preview"
      && operationResult.status === "succeeded"
      && operationResult.dispatch_state === "dispatched"
      && operationResult.persistent_effect === "none"
      && operationResult.native_transaction_state === "rolled_back"
    : false;
  const root = object(result);
  const childOperationResults = calls
    .filter(call => call.operation_role !== "root")
    .map(call => ({
      operation_id: call.operation_id,
      parent_operation_id: call.parent_operation_id,
      operation_role: call.operation_role,
      request_identity: call.lease.request_identity,
      settlement_digest: sha256(call.settlement ?? null)
    }));
  return {
    ...root,
    structuredContent: {
      schema: ASSIGNMENT_KERNEL_MCP_RESULT_V2_SCHEMA,
      operation_result_v2: operationResult,
      ...(parentCall && operationResult.observation_required ? {
        observation: {
          raw_payload: parentCall.observation_payload,
           semantic_facts: semanticFacts(
             parentCall.observation_payload,
             1,
             evidenceClass(parentCall.lease.fulfillment_role),
             parentCall.path,
             parentCall.body,
             parentCall.lease.requested_effect,
             authoritativeParentPreview,
             undefined,
             operationResult.status === "succeeded"
           ),
          target_scope: {},
           verification_relevance: [evidenceClass(parentCall.lease.fulfillment_role)],
           evidence_class: evidenceClass(parentCall.lease.fulfillment_role)
        }
      } : operationResult.observation_required ? {
        observation: {
          raw_payload: result,
           semantic_facts: semanticFacts(
             result,
             0,
             "control",
             observationAuthority ?? "operator-mcp-transport",
             undefined,
             scope.context.requested_effect,
             false,
             retainedControlEvidence ? scope.context.capability_id : undefined
           ),
          target_scope: {},
           verification_relevance: ["control"],
           evidence_class: "control"
        }
      } : {}),
      ...(childOperationResults.length > 0 ? { child_operation_results_v2: childOperationResults } : {})
    }
  };
}

export function decorateAssignmentKernelMcpResultV2(result: unknown, capabilityId: string): unknown {
  const scope = storage.getStore();
  return scope ? decoratedResult(result, capabilityId, scope) : result;
}
