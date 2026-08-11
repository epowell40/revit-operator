import { isHostedRuntime, resolveRuntimeMode, type OperatorRuntimeMode } from "../runtime_mode.js";

export const SIDECAR_AGENT_PROFILE_SCHEMA = "revit-operator.sidecar-agent-profile.v1" as const;

export type SidecarAgentCapabilityProfile = "general_agent_laboratory" | "general_agent_unavailable";

export type SidecarAgentProfileReason =
  | "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY"
  | "GENERAL_AGENT_UNAVAILABLE_HOSTED_OR_PRODUCTION"
  | "GENERAL_AGENT_UNAVAILABLE_LABORATORY_REQUIRES_EXACT_DEVELOPMENT"
  | "GENERAL_AGENT_UNAVAILABLE_DEVELOPMENT_REQUIRES_EXACT_LABORATORY"
  | "GENERAL_AGENT_UNAVAILABLE_GENERAL_BRAIN_REQUIRED"
  | "GENERAL_AGENT_UNAVAILABLE_RUNTIME_MODE_UNCONFIGURED"
  | "GENERAL_AGENT_UNAVAILABLE_DEFAULT";

export type SidecarAgentProfileState = Readonly<{
  schema: typeof SIDECAR_AGENT_PROFILE_SCHEMA;
  source: "backend_environment";
  runtime_mode: OperatorRuntimeMode | "unconfigured";
  tool_exposure_profile: "certified" | "laboratory";
  capability_profile: SidecarAgentCapabilityProfile;
  general_agent_ready: boolean;
  reason_code: SidecarAgentProfileReason;
}>;

/**
 * Backend-authored Sidecar profile state. The laboratory escape deliberately
 * uses exact raw environment values so case/whitespace normalization cannot
 * silently broaden the production boundary.
 */
export function getSidecarAgentProfileState(env: NodeJS.ProcessEnv = process.env): SidecarAgentProfileState {
  const runtimeMode = resolveRuntimeMode(env);
  const hostedRuntime = isHostedRuntime(env);
  const exactDevelopment = env.REVIT_OPERATOR_MODE === "development";
  const exactLaboratory = env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
  const exactGeneralBrain = env.OPERATOR_BRAIN === "codex";
  const generalAgentReady = exactDevelopment && exactLaboratory && exactGeneralBrain && !hostedRuntime;

  let reasonCode: SidecarAgentProfileReason;
  if (generalAgentReady) {
    reasonCode = "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY";
  } else if (runtimeMode === "hosted" || runtimeMode === "production" || hostedRuntime) {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_HOSTED_OR_PRODUCTION";
  } else if (exactLaboratory && !exactDevelopment) {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_LABORATORY_REQUIRES_EXACT_DEVELOPMENT";
  } else if (runtimeMode === "development") {
    reasonCode = !exactLaboratory
      ? "GENERAL_AGENT_UNAVAILABLE_DEVELOPMENT_REQUIRES_EXACT_LABORATORY"
      : "GENERAL_AGENT_UNAVAILABLE_GENERAL_BRAIN_REQUIRED";
  } else if (runtimeMode === null) {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_RUNTIME_MODE_UNCONFIGURED";
  } else {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_DEFAULT";
  }

  return Object.freeze({
    schema: SIDECAR_AGENT_PROFILE_SCHEMA,
    source: "backend_environment",
    runtime_mode: runtimeMode ?? "unconfigured",
    tool_exposure_profile: generalAgentReady ? "laboratory" : "certified",
    capability_profile: generalAgentReady ? "general_agent_laboratory" : "general_agent_unavailable",
    general_agent_ready: generalAgentReady,
    reason_code: reasonCode
  });
}
