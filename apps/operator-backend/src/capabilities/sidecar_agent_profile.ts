import { isHostedRuntime, resolveRuntimeMode, type OperatorRuntimeMode } from "../runtime_mode.js";

export const SIDECAR_AGENT_PROFILE_SCHEMA = "revit-operator.sidecar-agent-profile.v1" as const;

export type SidecarAgentCapabilityProfile = "general_agent" | "general_agent_laboratory" | "general_agent_unavailable";

export type SidecarAgentProfileReason =
  | "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY"
  | "GENERAL_AGENT_HOSTED_PRODUCTION_READY"
  | "GENERAL_AGENT_UNAVAILABLE_PROVIDER_REQUIRED"
  | "GENERAL_AGENT_UNAVAILABLE_PRINCIPAL_AUTH_REQUIRED"
  | "GENERAL_AGENT_UNAVAILABLE_LABORATORY_REQUIRES_EXACT_DEVELOPMENT"
  | "GENERAL_AGENT_UNAVAILABLE_DEVELOPMENT_REQUIRES_EXACT_LABORATORY"
  | "GENERAL_AGENT_UNAVAILABLE_GENERAL_BRAIN_REQUIRED"
  | "GENERAL_AGENT_UNAVAILABLE_RUNTIME_MODE_UNCONFIGURED"
  | "GENERAL_AGENT_UNAVAILABLE_DEFAULT";

export type SidecarAgentProfileState = Readonly<{
  schema: typeof SIDECAR_AGENT_PROFILE_SCHEMA;
  source: "backend_environment";
  runtime_mode: OperatorRuntimeMode | "unconfigured";
  tool_exposure_profile: "general" | "laboratory" | "unavailable";
  capability_profile: SidecarAgentCapabilityProfile;
  general_agent_ready: boolean;
  reason_code: SidecarAgentProfileReason;
}>;

/**
 * Backend-authored Sidecar profile state. Local laboratory activation remains
 * exact. Hosted production is the normal product path: an authenticated
 * principal runtime with the GPT-backed desktop relay available exposes the
 * full General Agent. Revit execution still travels through the independently
 * authorized ROSB transport; this profile does not weaken that boundary.
 */
export function getSidecarAgentProfileState(env: NodeJS.ProcessEnv = process.env): SidecarAgentProfileState {
  const runtimeMode = resolveRuntimeMode(env);
  const hostedRuntime = isHostedRuntime(env);
  const exactDevelopment = env.REVIT_OPERATOR_MODE === "development";
  const exactLaboratory = env.OPERATOR_TOOL_EXPOSURE_PROFILE === "laboratory";
  const exactGeneralBrain = env.OPERATOR_BRAIN === "codex";
  const laboratoryReady = exactDevelopment && exactLaboratory && exactGeneralBrain && !hostedRuntime;
  const exactHostedProduction = env.REVIT_OPERATOR_MODE === "hosted" || env.REVIT_OPERATOR_MODE === "production";
  const configuredAuth = (env.OPERATOR_AUTH_MODE ?? "").trim().toLowerCase();
  const principalAuth = configuredAuth === "principal_jwt" || (configuredAuth === "" && exactHostedProduction);
  const productionBrain = env.OPERATOR_BRAIN === "codex" || env.OPERATOR_BRAIN === "openai" || env.OPERATOR_BRAIN === "auto";
  const providerReady = !!((env.OPERATOR_OPENAI_API_KEY ?? "").trim() || (env.OPENAI_API_KEY ?? "").trim());
  const hostedProductionReady = exactHostedProduction && principalAuth && productionBrain && providerReady;
  const generalAgentReady = laboratoryReady || hostedProductionReady;

  let reasonCode: SidecarAgentProfileReason;
  if (laboratoryReady) {
    reasonCode = "GENERAL_AGENT_DEVELOPMENT_LABORATORY_READY";
  } else if (hostedProductionReady) {
    reasonCode = "GENERAL_AGENT_HOSTED_PRODUCTION_READY";
  } else if (exactHostedProduction && !principalAuth) {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_PRINCIPAL_AUTH_REQUIRED";
  } else if (exactHostedProduction && (!productionBrain || !providerReady)) {
    reasonCode = "GENERAL_AGENT_UNAVAILABLE_PROVIDER_REQUIRED";
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
    tool_exposure_profile: laboratoryReady ? "laboratory" : hostedProductionReady ? "general" : "unavailable",
    capability_profile: laboratoryReady ? "general_agent_laboratory" : hostedProductionReady ? "general_agent" : "general_agent_unavailable",
    general_agent_ready: generalAgentReady,
    reason_code: reasonCode
  });
}
