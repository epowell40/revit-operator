import { REUSED_DETAIL_GUIDANCE } from "./brains/redline_package_guidance.js";
import { imageInputManifest, retainImageInputDelivery } from './desktop_image_delivery.js';
import { parseProviderResponseUsageV1, type ProviderResponseUsageV1 } from "@revitoperator/assignment-kernel-v2-contracts/provider-turn-usage";
import { createOpenAiClient, resolveOpenAiApiKey } from "./openai_client.js";
import type { ModelCallReceipt } from "./contracts.js";
import { createOpenAiModelCallReceipt } from "./model_call_telemetry.js";
import {
  assertModelReasoningEffort,
  isReasoningEffort,
  isSafeModelId,
  normalizeModelId,
  normalizeReasoningEffort,
  type ReasoningEffort
} from "./speed_config.js";
import {
  getSidecarAgentProfileState,
  type SidecarAgentProfileState
} from "./capabilities/sidecar_agent_profile.js";
import { assertBoundedModelEvidencePayload, prepareBoundedModelEvidenceInput, type ModelEvidencePayloadUsage } from "./evidence/model_context_budget.js";
import { appendEvidenceTelemetry } from "./evidence/evidence_store.js";
import { localExecutorCapability, type LocalExecutorCapabilityV1 } from "./assignments/local_advisory_policy.js";
import {localDesktopNativeTransportAvailable} from './assignments/desktop_native_transport_policy.js';
import { executeExternalProviderCallV2, ExternalProviderAdmissionError } from "./assignments/external_provider_lifecycle.js";
import type { AssignmentKernelBindingInputV2 } from "./assignments/assignment_kernel_v2_lifecycle.js";
import {assignmentKernelV2ForBinding} from './assignments/assignment_kernel_v2_factory.js';
import {desktopAssignmentFeedbackInputV2} from './desktop_assignment_feedback.js';
import {withSerializedProviderTurn} from './provider_turn_queue.js';
import {prepareDesktopProviderInput,desktopModelInputPackage,desktopResponseOwnsContext} from './desktop_response_store.js';
import {resolveOpenAiDataPolicy} from './openai_data_policy.js';
import {getWorkspaceRoot} from './workspace.js';
import {desktopNativeInteractionTools,retainNativeInteractiveProviderResponse,withDesktopNativeProviderReadiness} from './assignments/desktop_native_tools.js';

export type DesktopComputerRelayRequest = {
  model?: string;
  reasoning_effort?: ReasoningEffort;
  instructions?: string;
  tools?: unknown[];
  input: unknown;
  previous_response_id?: string;
  evidence_scope?: { session_id: string; assignment_id?: string | null };
};

type DesktopComputerRelayResponse = {
  provider_data_policy?: ReturnType<typeof resolveOpenAiDataPolicy>;
  input_images?: ReturnType<typeof imageInputManifest>;
  input_image_delivery_error?: string;
  id: string;
  status?: string;
  output_text: string;
  output: unknown[];
  model?: string;
  model_call_receipt: ModelCallReceipt;
  provider_response_usage?: ProviderResponseUsageV1;
  model_context_package?: ReturnType<typeof desktopModelInputPackage>;
};

class DesktopComputerProviderError extends Error {
  readonly modelCallReceipt: ModelCallReceipt;
  readonly modelContextPackage?: ReturnType<typeof desktopModelInputPackage>;
  providerResponseUsage?: ProviderResponseUsageV1;

  constructor(modelCallReceipt: ModelCallReceipt, cause: unknown, contextPackage?: ReturnType<typeof desktopModelInputPackage>) {
    super("Desktop computer provider request failed.", { cause });
    this.name = "DesktopComputerProviderError";
    this.modelCallReceipt = modelCallReceipt;
    this.modelContextPackage = contextPackage;
  }
}

export function getDesktopComputerProviderErrorReceipt(error: unknown): ModelCallReceipt | null {
  return error instanceof DesktopComputerProviderError ? error.modelCallReceipt : null;
}

type ProviderFailureDiagnostic = {
  status: number | null; type: string | null; reason: string;
  parameter: string | null; request_id: string | null;
};

/** Content-free troubleshooting only. Neither a retry grant nor task/effect proof. */
function providerFailureDiagnostic(cause: unknown): ProviderFailureDiagnostic {
  const value = cause && typeof cause === 'object' ? cause as Record<string, unknown> : {};
  const message = typeof value.message === 'string' && value.message.length <= 8192 ? value.message : '';
  const requestId = value.requestID ?? value.request_id;
  const reasons: [RegExp, string][] = [
    [/computer tool cannot use multiple image inputs/i, 'computer_multiple_image_inputs'],
    [/provided without its required ['"]reasoning['"] item/i, 'missing_reasoning_item'],
    [/no tool output found for function call/i, 'missing_tool_output'],
    [/no tool call found for function call output/i, 'unexpected_tool_output'],
    [/previous response.{0,256}(?:not found|does not exist)/i, 'previous_response_unavailable'],
    [/(?:maximum context length|context window.{0,80}exceed|context_length_exceeded)/i, 'context_limit'],
    [/(?:invalid image|invalid_image)/i, 'invalid_image'],
    [/unsupported parameter/i, 'unsupported_parameter']
  ];
  return {
    status: Number.isInteger(value.status) && Number(value.status) >= 400 && Number(value.status) <= 599 ? Number(value.status) : null,
    type: ['invalid_request_error', 'authentication_error', 'permission_error', 'rate_limit_error', 'server_error'].includes(String(value.type)) ? String(value.type) : null,
    reason: reasons.find(([pattern]) => pattern.test(message))?.[1] ?? 'unclassified',
    parameter: typeof value.param === 'string' && /^(?:input|tools|previous_response_id|context_management|model|reasoning)(?:\[\d{1,5}\]|\.(?:content|type|image_url|output|call_id|name|parameters|compact_threshold|effort)){0,6}$/.test(value.param) ? value.param : null,
    request_id: typeof requestId === 'string' && /^req_[A-Za-z0-9]{1,96}$/.test(requestId) ? requestId : null
  };
}

export function desktopComputerErrorResponse(error: unknown): { error: string; admission?: {decision:string;reason:string}; model_call_receipts?: ModelCallReceipt[]; provider_response_usage?: ProviderResponseUsageV1; provider_diagnostic?: ProviderFailureDiagnostic; model_context_package?: ReturnType<typeof desktopModelInputPackage> } {
  if(error instanceof ExternalProviderAdmissionError)return {error:error.message,admission:{decision:error.decision,reason:error.reason}};
  const receipt = getDesktopComputerProviderErrorReceipt(error);
  const diagnostic = error instanceof DesktopComputerProviderError ? providerFailureDiagnostic(error.cause) : undefined;
  return receipt
    ? { error: diagnostic?.reason !== 'unclassified' && diagnostic?.status
      ? `Desktop computer provider request failed (HTTP ${diagnostic.status}; ${diagnostic.reason}). Saved work is retained; do not repeat the unchanged request.`
      : "Desktop computer provider request failed.",
      provider_diagnostic: diagnostic, model_call_receipts: [receipt],
      ...(error instanceof DesktopComputerProviderError && error.modelContextPackage ? {model_context_package:error.modelContextPackage} : {}),
      ...(error instanceof DesktopComputerProviderError && error.providerResponseUsage
      ? { provider_response_usage: error.providerResponseUsage } : {}) }
    : { error: error instanceof Error ? error.message : "Unknown OpenAI error" };
}

function resolveDesktopComputerModel(): string {
  return normalizeModelId(process.env.OPERATOR_DESKTOP_COMPUTER_MODEL, "gpt-5.6-terra");
}

function resolveDesktopComputerReasoningEffort(): ReasoningEffort {
  return normalizeReasoningEffort(process.env.OPERATOR_DESKTOP_COMPUTER_REASONING_EFFORT, "medium");
}

export function getDesktopComputerConfig(): {
  available: boolean;
  provider: "backend";
  model: string;
  reasoning_effort: string;
  sidecar_agent_profile: SidecarAgentProfileState;
  local_executor: LocalExecutorCapabilityV1 | null;
  desktop_native_tools: boolean;
} {
  return {
    available: !!resolveOpenAiApiKey(),
    provider: "backend",
    model: resolveDesktopComputerModel(),
    reasoning_effort: resolveDesktopComputerReasoningEffort(),
    sidecar_agent_profile: getSidecarAgentProfileState(),
    local_executor: localExecutorCapability(),
    desktop_native_tools: localDesktopNativeTransportAvailable()
  };
}

function normalizeRelayRequest(value: unknown): DesktopComputerRelayRequest {
  const body = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const input = body.input;
  if (input == null) {
    throw new Error("input is required.");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (model && !isSafeModelId(model)) {
    throw new Error("model must be a bounded provider model identifier.");
  }
  const reasoningEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort.trim().toLowerCase()
    : "";
  if (reasoningEffort && !isReasoningEffort(reasoningEffort)) {
    throw new Error("reasoning_effort must be none, low, medium, high, xhigh, or max.");
  }
  const rawEvidenceScope = body.evidence_scope && typeof body.evidence_scope === "object" && !Array.isArray(body.evidence_scope)
    ? body.evidence_scope as Record<string, unknown>
    : null;
  const sessionId = typeof rawEvidenceScope?.session_id === "string" ? rawEvidenceScope.session_id.trim() : "";
  const assignmentId = typeof rawEvidenceScope?.assignment_id === "string" ? rawEvidenceScope.assignment_id.trim() : "";
  if (rawEvidenceScope && (!/^[A-Za-z0-9._:-]{1,240}$/.test(sessionId)
      || (assignmentId && !/^[A-Za-z0-9._:-]{1,240}$/.test(assignmentId)))) {
    throw new Error("evidence_scope must contain bounded session and optional Assignment identifiers.");
  }

  return {
    model: model || undefined,
    reasoning_effort: reasoningEffort ? reasoningEffort as ReasoningEffort : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    tools: Array.isArray(body.tools) ? body.tools : undefined,
    input,
    evidence_scope: rawEvidenceScope ? { session_id: sessionId, assignment_id: assignmentId || null } : undefined,
    previous_response_id:
      typeof body.previous_response_id === "string" ? body.previous_response_id.trim() || undefined : undefined
  };
}

function recordDesktopEvidenceUsage(
  usage: ModelEvidencePayloadUsage,
  scope: DesktopComputerRelayRequest["evidence_scope"],
  receipt: ModelCallReceipt
): void {
  if (!scope || usage.projection_count === 0) return;
  appendEvidenceTelemetry({
    session_id: scope.session_id,
    assignment_id: scope.assignment_id ?? null,
    model_call_id: receipt.call_id,
    source: "desktop_computer_model_context",
    raw_evidence_bytes_produced: 0,
    unique_evidence_bytes_stored: 0,
    projected_bytes_sent: usage.projected_bytes,
    duplicate_bytes_avoided: Math.max(0, usage.referenced_raw_bytes - usage.projected_bytes),
    evidence_items_expanded: 0,
    budget_events: 0,
    estimated_model_tokens_avoided: Math.floor(Math.max(0, usage.referenced_raw_bytes - usage.projected_bytes) / 4)
  });
}

function extractOutputText(response: any): string {
  const direct = typeof response?.output_text === "string" ? response.output_text : "";
  if (direct.trim()) return direct;

  const parts: string[] = [];
  const outputItems = Array.isArray(response?.output) ? response.output : [];
  for (const item of outputItems) {
    if (!item || item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const contentItem of item.content) {
      if (!contentItem || contentItem.type !== "output_text" || typeof contentItem.text !== "string") continue;
      if (contentItem.text) parts.push(contentItem.text);
    }
  }

  return parts.join("");
}

function simplifyRelayResponse(response: any, modelCallReceipt: ModelCallReceipt): DesktopComputerRelayResponse {
  return {
    id: typeof response?.id === "string" ? response.id : "",
    status: typeof response?.status === "string" ? response.status : undefined,
    output_text: extractOutputText(response),
    output: Array.isArray(response?.output) ? response.output : [],
    model: typeof response?.model === "string" ? response.model : undefined,
    model_call_receipt: modelCallReceipt
  };
}

export async function relayDesktopComputerResponse(rawBody: unknown,
  retainedTurnUsage?: ModelEvidencePayloadUsage): Promise<DesktopComputerRelayResponse> {
  const apiKey = resolveOpenAiApiKey();
  if (!apiKey) {
    throw new Error("OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.");
  }

  const body = normalizeRelayRequest(rawBody);
  // Only the bound relay supplies this internal argument, after validating the
  // fresh turn and appending its exact host-retained conversation prefix. The
  // public HTTP body cannot select it. Do not re-project prior tool results or
  // count historical context again against one turn's evidence-envelope cap.
  if (!retainedTurnUsage) body.input = prepareBoundedModelEvidenceInput(body.input);
  const evidenceUsage = retainedTurnUsage ?? assertBoundedModelEvidencePayload(body.input);
  const dataPolicy=resolveOpenAiDataPolicy();
  const client = createOpenAiClient(apiKey);
  const model = body.model || resolveDesktopComputerModel();
  const reasoningEffort = body.reasoning_effort || resolveDesktopComputerReasoningEffort();
  assertModelReasoningEffort(model, reasoningEffort);
  const startedAtUtc = new Date().toISOString();
  const startedMs = Date.now();
  const instructions = body.instructions?.includes(REUSED_DETAIL_GUIDANCE)
    ? body.instructions : [body.instructions, REUSED_DETAIL_GUIDANCE].filter(Boolean).join("\n");
  const contextPackage = desktopModelInputPackage({...body,instructions});
  let response: unknown;
  try {
    response = await client.responses.create({
      model,
      reasoning: { effort: reasoningEffort },
      // Host-owned context management for the same execution owner. Preserve
      // opaque compaction output and actual provider usage through the normal
      // relay; it never replaces native evidence or canonical task state.
      // Terra's visual working set can already exceed100k before productive
      // work. Compacting each new image pair discards its precise pixels and
      // encourages a read/capture/compact loop. Leave room below its272k
      // long-context price boundary; this does not grant task calls or tokens.
      context_management: [{ type: "compaction", compact_threshold: model === "gpt-6.1-terra" ? 250_000 : 100_000 }],
      include: ['reasoning.encrypted_content'],
      instructions,
      tools: body.tools,
      input: body.input,
      previous_response_id: body.previous_response_id
    } as any);
  } catch (error) {
    const receipt = createOpenAiModelCallReceipt({
      route: "desktop_computer",
      requested_model: model,
      reasoning_effort: reasoningEffort,
      started_at_utc: startedAtUtc,
      duration_ms: Date.now() - startedMs,
      error
    });
    recordDesktopEvidenceUsage(evidenceUsage, body.evidence_scope, receipt);
    throw new DesktopComputerProviderError(receipt, error, contextPackage);
  }
  const receipt = createOpenAiModelCallReceipt({
    route: "desktop_computer",
    requested_model: model,
    reasoning_effort: reasoningEffort,
    started_at_utc: startedAtUtc,
    duration_ms: Date.now() - startedMs,
    response
  });
  recordDesktopEvidenceUsage(evidenceUsage, body.evidence_scope, receipt);
  return {...simplifyRelayResponse(response, receipt), provider_data_policy:dataPolicy,input_images:imageInputManifest(body.input),model_context_package:contextPackage};
}

/** The authenticated HTTP edge supplies this binding, never the model input. */
export async function relayBoundDesktopComputerResponse(rawBody: unknown,
  binding: AssignmentKernelBindingInputV2 & { kernelVersion: 1 | 2 },
  options: {signal?: AbortSignal} = {}): Promise<DesktopComputerRelayResponse> {
  const request = rawBody && typeof rawBody === "object" ? rawBody as Record<string, unknown> : {};
  const messageId = request.message_id;
  let providerBody:unknown=rawBody;
  let retainedTurnUsage: ModelEvidencePayloadUsage | undefined;
  if (messageId !== undefined && (typeof messageId !== "string" || !messageId.length || messageId.length > 256 || /[\u0000-\u001f]/.test(messageId)))
    throw new Error("desktop_provider_message_identity_invalid");
  const usage = (receipt: ModelCallReceipt) => messageId === undefined ? undefined : parseProviderResponseUsageV1({
    schema: "revit-operator.provider-response-usage/v1", session_id: binding.session_id, message_id: messageId,
    disposition: receipt.success ? "completed" : "failed", raw_response_ids: [receipt.call_id]
  });
  const invoke = async () => {
    try {
      const result = await relayDesktopComputerResponse(providerBody,retainedTurnUsage);
      const observed = usage(result.model_call_receipt);
      return { ...result, ...(observed ? { provider_response_usage: observed } : {}) };
    } catch (error) {
      if (error instanceof DesktopComputerProviderError) error.providerResponseUsage = usage(error.modelCallReceipt);
      throw error;
    }
  };
  if (binding.kernelVersion === 1) return invoke();
  const body = normalizeRelayRequest(rawBody);
  const model = body.model || resolveDesktopComputerModel();
  const reasoning = body.reasoning_effort || resolveDesktopComputerReasoningEffort();
  assertModelReasoningEffort(model, reasoning);
  body.input = prepareBoundedModelEvidenceInput(body.input);
  assertBoundedModelEvidencePayload(body.input);
  if (!resolveOpenAiApiKey()) throw new Error("OPERATOR_OPENAI_API_KEY (or OPENAI_API_KEY) is not set.");
  // The HTTP caller may leave while its upstream request is still settling.
  // Serialize only this outer relay; the canonical admission guard remains
  // authoritative for other in-flight work, pause, unknown effects and budget.
  return withSerializedProviderTurn({namespace:'desktop-outer',workspace:getWorkspaceRoot(),
    sessionId:JSON.stringify([binding.session_id,binding.assignment_id]),signal:options.signal},()=>withDesktopNativeProviderReadiness(binding,async()=>{
    // Re-resolve scoped ownership/generation and feedback after predecessor usage.
    const resolved=assignmentKernelV2ForBinding(binding);
    if(!resolved)throw new Error('desktop_assignment_feedback_binding_stale');
    // Scoped review gets its bounded packet, not the owner's entire checklist.
    // Current admission, Pause, unknown-effect and usage checks still apply.
    const ownerContext=desktopResponseOwnsContext(request);
    const ownerInput=ownerContext?desktopAssignmentFeedbackInputV2(body.input,resolved.snapshot,body.previous_response_id):undefined;
    const feedbackInput=ownerInput??body.input;
    providerBody={...request,input:feedbackInput};
    const interactiveTools=desktopNativeInteractionTools(binding,body.tools);
    if(interactiveTools) providerBody={...providerBody as Record<string,unknown>,tools:interactiveTools,
      instructions:(body.instructions??'')+'\nAn existing native placement call is outstanding. Only operate that Revit placement UI, then Escape and use native__await_interactive_placement for its actual result. Do not save, report or finish the task, call another native tool, or treat input readiness as a committed edit.'};
    retainedTurnUsage=assertBoundedModelEvidencePayload((providerBody as DesktopComputerRelayRequest).input);
    providerBody=prepareDesktopProviderInput(binding,messageId,{
      ...providerBody as Record<string,unknown>,model,reasoning_effort:reasoning },ownerContext?{hostFeedback:ownerInput!.at(-1)}:{});
    const response=await executeExternalProviderCallV2({ binding, model, reasoning_effort: reasoning,
      ...(interactiveTools?{nativeInteractiveInput:true as const}:{}),
      invoke, receipt: result => result.model_call_receipt,
      errorReceipt: getDesktopComputerProviderErrorReceipt });
    if(interactiveTools)retainNativeInteractiveProviderResponse(binding,response);
    try { retainImageInputDelivery(binding,response); }
    catch {
      // Provider usage and the response have already settled. A local image
      // index failure must not hide that response or trigger another paid call.
      // Missing/stale delivery receipts still fail the backcheck admission.
      response.input_image_delivery_error='image_delivery_index_unavailable';
    }
    return response;
  },options.signal));
}
