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
