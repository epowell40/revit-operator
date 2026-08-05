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

export type CertifiedSidecarActionFilter = { actions: ActionCall[]; policyHash?: string; denied: boolean; controlPlaneFailure?: string };

/** Provider-neutral final fence: no route-only or static-allowlist inference is possible here. */
export function filterCertifiedSidecarActions(actions: ActionCall[], env: NodeJS.ProcessEnv = process.env): CertifiedSidecarActionFilter {
  try {
    const trusted = loadTrustedToolExposurePolicy(env);
    const requestHash = computeRequestHash("GET", CERTIFIED_SIDECAR_CONTEXT_PATH, {});
    const evaluation = evaluateTrustedToolExposurePolicy({ policy: trusted.policy, method: "GET", path: CERTIFIED_SIDECAR_CONTEXT_PATH, requestHash, channel: "typed_mcp", alias: CERTIFIED_SIDECAR_CONTEXT_ALIAS });
    const allowed = actions.filter(action => action.method === "GET" && action.path === CERTIFIED_SIDECAR_CONTEXT_PATH && action.body === undefined && !!evaluation.record.effect_hash);
    return { actions: allowed, policyHash: trusted.policy.policy_hash, denied: allowed.length !== actions.length };
  } catch (error) {
    const code = error instanceof TrustedToolExposurePolicyError ? error.code : "CERTIFICATION_POLICY_UNAVAILABLE";
    return { actions: [], denied: true, controlPlaneFailure: code };
  }
}

const EXPECTED_PRE_DISPATCH_DENIALS = new Set([
  "revit_execution_denied", "revit_execution_not_dispatched", "revit_execution_authorization_unavailable",
  "revit_execution_authorization_endpoint_missing", "revit_bridge_loopback_required"
]);

function documentExecutorSignature(req: Pick<ChatRequest, "context">): string {
  const context = contextRecord(req);
  const revit = context?.revit && typeof context.revit === "object" ? context.revit as Record<string, unknown> : {};
  const document = revit.document && typeof revit.document === "object" ? revit.document as Record<string, unknown> : {};
  return JSON.stringify([document.title ?? "", document.path ?? "", revit.process_id ?? "", revit.courier_executor_id ?? ""]);
}

/** A backend-generated terminal receipt; prose never grants degraded completion. */
export function buildCertifiedReadDisposition(req: ChatRequest) {
  if (!isCertifiedSidecarRequest(req)) return null;
  const results = Array.isArray(req.tool_results) ? req.tool_results : [];
  if (results.length !== 1) return null;
  const result = results[0]!;
  const read = result.request_effect === "read" || result.method === "GET";
  if (!read || result.status !== "failed" || result.request_dispatched !== false || result.outcome_unknown !== false
    || result.reconciliation_required !== false || !EXPECTED_PRE_DISPATCH_DENIALS.has(String(result.failure_code ?? ""))) return null;
  try {
    const trusted = loadTrustedToolExposurePolicy();
    return {
      schema: "revit-operator.certified-read-disposition.v1" as const,
      terminal: true as const,
      status: "degraded" as const,
      session_id: req.session_id,
      message_id: req.message_id,
      policy_hash: trusted.policy.policy_hash,
      document_executor_signature: documentExecutorSignature(req),
      action_ids: [result.action_id],
      evidence_ids: [result.action_id],
      correction_count: 1 as const
    };
  } catch {
    return null;
  }
}
