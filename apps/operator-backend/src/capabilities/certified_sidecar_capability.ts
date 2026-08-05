import type { ActionCall, ChatRequest } from "../contracts.js";
import { computeRequestHash } from "./tool_certification.js";
import { evaluateTrustedToolExposurePolicy, loadTrustedToolExposurePolicy, TrustedToolExposurePolicyError } from "./trusted_tool_exposure_policy.js";

export const CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA = "revit-operator.certified-sidecar-bootstrap.v1";
export const CERTIFIED_SIDECAR_CONTEXT_PATH = "/revit/context";
export const CERTIFIED_SIDECAR_CONTEXT_ALIAS = "revit_get_context";

type CertifiedSidecarBootstrap = {
  schema: typeof CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA;
  method: "GET";
  path: typeof CERTIFIED_SIDECAR_CONTEXT_PATH;
  request: Record<string, never>;
  effect: "read";
  channel: "typed_mcp";
  alias: typeof CERTIFIED_SIDECAR_CONTEXT_ALIAS;
};

function contextRecord(req: Pick<ChatRequest, "context">): Record<string, unknown> | null {
  const context = req.context;
  return context && typeof context === "object" && !Array.isArray(context) ? context as Record<string, unknown> : null;
}

function exactBootstrap(value: unknown): value is CertifiedSidecarBootstrap {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const binding = value as Record<string, unknown>;
  const keys = ["schema", "method", "path", "request", "effect", "channel", "alias"];
  if (Object.keys(binding).length !== keys.length || keys.some(key => !(key in binding))) return false;
  return binding.schema === CERTIFIED_SIDECAR_BOOTSTRAP_SCHEMA && binding.method === "GET"
    && binding.path === CERTIFIED_SIDECAR_CONTEXT_PATH && binding.effect === "read"
    && binding.channel === "typed_mcp" && binding.alias === CERTIFIED_SIDECAR_CONTEXT_ALIAS
    && !!binding.request && typeof binding.request === "object" && !Array.isArray(binding.request)
    && Object.keys(binding.request as object).length === 0;
}

/** The host must assert both the existing direct route and this exact observed binding. */
export function isCertifiedSidecarRequest(req: Pick<ChatRequest, "context">): boolean {
  const context = contextRecord(req);
  return context?.operator_brain_route === "direct" && exactBootstrap(context.certified_sidecar_bootstrap);
}

export type CertifiedSidecarCapabilityState = {
  schema: "revit-operator.certified-sidecar-capability-state.v1";
  policy_hash: string;
  method: "GET";
  path: typeof CERTIFIED_SIDECAR_CONTEXT_PATH;
  request_hash: string;
  effect_hash: string;
  channel: "typed_mcp";
  alias: typeof CERTIFIED_SIDECAR_CONTEXT_ALIAS;
  evidence_id: "certified-context";
};

export type CertifiedSidecarActionFilter = {
  actions: ActionCall[];
  state?: CertifiedSidecarCapabilityState;
  denied: boolean;
  controlPlaneFailure?: string;
};

/** Provider-neutral final fence: no route-only or static-allowlist inference is possible here. */
export function filterCertifiedSidecarActions(actions: ActionCall[], env: NodeJS.ProcessEnv = process.env): CertifiedSidecarActionFilter {
  try {
    const trusted = loadTrustedToolExposurePolicy(env);
    const requestHash = computeRequestHash("GET", CERTIFIED_SIDECAR_CONTEXT_PATH, {});
    const evaluation = evaluateTrustedToolExposurePolicy({ policy: trusted.policy, method: "GET", path: CERTIFIED_SIDECAR_CONTEXT_PATH, requestHash, channel: "typed_mcp", alias: CERTIFIED_SIDECAR_CONTEXT_ALIAS });
    const allowed = actions.filter(action => action.method === "GET" && action.path === CERTIFIED_SIDECAR_CONTEXT_PATH && action.body === undefined);
    return {
      actions: allowed,
      state: {
        schema: "revit-operator.certified-sidecar-capability-state.v1",
        policy_hash: trusted.policy.policy_hash,
        method: "GET",
        path: CERTIFIED_SIDECAR_CONTEXT_PATH,
        request_hash: evaluation.record.request_hash,
        effect_hash: evaluation.record.effect_hash,
        channel: "typed_mcp",
        alias: CERTIFIED_SIDECAR_CONTEXT_ALIAS,
        evidence_id: "certified-context"
      },
      denied: allowed.length !== actions.length
    };
  } catch (error) {
    const code = error instanceof TrustedToolExposurePolicyError ? error.code : "CERTIFICATION_POLICY_UNAVAILABLE";
    return { actions: [], denied: true, controlPlaneFailure: code };
  }
}

const EXPECTED_PRE_DISPATCH_DENIALS = new Set([
  "certified_action_denied"
]);

function documentExecutorSignature(req: Pick<ChatRequest, "context">): string {
  const context = contextRecord(req);
  const revit = context?.revit && typeof context.revit === "object" ? context.revit as Record<string, unknown> : {};
  const document = revit.document && typeof revit.document === "object" ? revit.document as Record<string, unknown> : {};
  return JSON.stringify([document.title ?? "", document.path ?? "", revit.process_id ?? "", revit.courier_executor_id ?? ""]);
}

/** A backend-generated terminal receipt; prose never grants degraded completion. */
function groundedCertifiedAnswer(req: ChatRequest, assistantMessage: string): boolean {
  const context = contextRecord(req);
  const revit = context?.revit && typeof context.revit === "object" ? context.revit as Record<string, unknown> : {};
  const document = revit.document && typeof revit.document === "object" ? revit.document as Record<string, unknown> : {};
  const readiness = revit.readiness && typeof revit.readiness === "object" ? revit.readiness as Record<string, unknown> : {};
  const ui = context?.ui && typeof context.ui === "object" ? context.ui as Record<string, unknown> : {};
  const uiDocument = ui.revit_document && typeof ui.revit_document === "object" ? ui.revit_document as Record<string, unknown> : {};
  const evidenceValues = [document.title, document.path, readiness.active_view_name, uiDocument.title, uiDocument.path]
    .filter((value): value is string => typeof value === "string" && value.trim().length >= 4)
    .map(value => value.trim().toLowerCase());
  const answer = assistantMessage.trim().toLowerCase();
  return answer.length >= 20 && evidenceValues.some(value => answer.includes(value));
}

export function buildCertifiedReadDisposition(req: ChatRequest, state: CertifiedSidecarCapabilityState | undefined, assistantMessage = "") {
  if (!isCertifiedSidecarRequest(req)) return null;
  if (!state) return null;
  const results = Array.isArray(req.tool_results) ? req.tool_results : [];
  if (results.length === 0) return null;
  const failures = results.filter(result => result.status === "failed");
  if (failures.length !== 1) return null;
  if (results.some(result => result.request_effect !== "read")) return null;
  if (results.some(result => result.outcome_unknown !== false || result.reconciliation_required !== false)) return null;
  const failure = failures[0]!;
  if (failure.request_dispatched !== false || !EXPECTED_PRE_DISPATCH_DENIALS.has(String(failure.failure_code ?? ""))) return null;
  if (!groundedCertifiedAnswer(req, assistantMessage)) return null;
  const successfulEvidenceIds = results
    .filter(result => result.status === "done")
    .map(result => result.action_id)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    schema: "revit-operator.certified-read-disposition.v1" as const,
    terminal: true as const,
    status: "degraded" as const,
    session_id: req.session_id,
    message_id: req.message_id,
    policy_hash: state.policy_hash,
    document_executor_signature: documentExecutorSignature(req),
    action_ids: [failure.action_id],
    evidence_ids: [state.evidence_id, ...successfulEvidenceIds],
    answer_status: "grounded_evidence_summary" as const,
    answer_evidence_ids: [state.evidence_id],
    correction_count: 1 as const
  };
}
