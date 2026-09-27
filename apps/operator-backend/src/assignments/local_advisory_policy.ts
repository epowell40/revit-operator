import { getRequestContext } from "../request_context.js";
import type { AssignmentBindingV2 } from "../domain/assignment-kernel/identity.js";
import type { LocalAdvisoryExecutionPolicyV1 } from "../domain/assignment-kernel/execution_policy.js";
import { assignmentKernelV2Enabled } from "../domain/assignment-kernel/feature_flag.js";
import { getSidecarAgentProfileState } from "../capabilities/sidecar_agent_profile.js";
import { isHostedRuntime } from "../runtime_mode.js";

export function trustedLocalExperimentHost(env: NodeJS.ProcessEnv = process.env, context = getRequestContext()): boolean {
  if (!["local", "development"].includes(env.REVIT_OPERATOR_MODE ?? "")
      || context?.principal || context?.operator_backend_auth?.mode !== "shared_token") return false;
  try { return !isHostedRuntime(env) && ["127.0.0.1", "localhost", "[::1]"].includes(new URL(context.operator_backend_auth.allowed_origin).hostname); }
  catch { return false; }
}

export type LocalExecutorCapabilityV1 = Readonly<{
  schema: "revit-operator.local-executor-capability/v1";
  source: "backend_configuration";
  profile: "codex_v2_advisory_v1";
  executor: "codex";
  assignment_kernel: 2;
  execution_policy: "local_advisory_v1";
}>;

/** Explicit local developer profile, not provider/CLI readiness or write authority.
 * Both the authenticated handshake and new assignment selection use this predicate. */
export function localExecutorCapability(env: NodeJS.ProcessEnv = process.env,
  context = getRequestContext()): LocalExecutorCapabilityV1 | null {
  if (env.OPERATOR_LOCAL_EXECUTOR_PROFILE !== "codex_v2_advisory_v1"
      || !assignmentKernelV2Enabled(env) || !trustedLocalExperimentHost(env, context)
      || !getSidecarAgentProfileState(env).general_agent_ready) return null;
  return Object.freeze({ schema: "revit-operator.local-executor-capability/v1", source: "backend_configuration",
    profile: "codex_v2_advisory_v1", executor: "codex", assignment_kernel: 2, execution_policy: "local_advisory_v1" });
}

/** Called only by the trusted assignment factory, never from request arguments. */
export function selectLocalAdvisoryPolicy(binding: AssignmentBindingV2,
  env: NodeJS.ProcessEnv = process.env, context = getRequestContext()): LocalAdvisoryExecutionPolicyV1 | undefined {
  if (!trustedLocalExperimentHost(env, context) || !binding.document_fingerprint
      || (!localExecutorCapability(env, context)
        && !(env.OPERATOR_ADVISORY_VERIFICATION_SESSION_IDS ?? "").split(",").map(id => id.trim()).includes(binding.session_id))) return undefined;
  const limit = (key: string, fallback: number, max: number) => {
    const value = Number(env[key]);
    return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
  };
  return { mode: "local_advisory_v1", selected_by: "trusted_local_host", session_id: binding.session_id,
    document_fingerprint: binding.document_fingerprint,
    max_turns: limit("OPERATOR_ADVISORY_MAX_TURNS", 8, 16),
    max_provider_calls: limit("OPERATOR_ADVISORY_MAX_PROVIDER_CALLS", 64, 256),
    max_operations: limit("OPERATOR_ADVISORY_MAX_OPERATIONS", 256, 1024),
    max_total_tokens: limit("OPERATOR_ADVISORY_MAX_TOTAL_TOKENS", 8_000_000, 32_000_000),
    max_wall_clock_ms: limit("OPERATOR_ADVISORY_MAX_WALL_MS", 20 * 60_000, 120 * 60_000) };
}
