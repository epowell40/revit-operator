import {
  assertDiscoveredCapability,
  discoverCertifiedCapabilities
} from "./certifiedCapabilityProjection.js";

export const GENERAL_AGENT_CAPABILITY_DISCOVERY_V1 = "revit-operator.general-agent-capability-discovery.v1" as const;

export const DYNAMIC_REVIT_PROGRAM_SUBSTRATE_V1 = {
  id: "dynamic_revit_program",
  kind: "dynamic_program",
  title: "Generate and preview a bounded task-specific Revit program",
  description: "For complex multi-step Revit work using loops, branching, or custom algorithms within explicit capability and effect limits.",
  semantics: {
    previewBeforeCommit: true,
    machineAccess: "restricted",
    externalFileEffects: "explicit_capability_required"
  },
  admission: {
    required: true,
    contract: "dynamic_program_admission/v1",
    state: "not_admitted_by_discovery",
    authorizationGranted: false
  }
} as const;

/**
 * Adds model-facing execution-substrate context around the exact certified
 * projection. It does not alter policy membership or discovery receipts.
 */
export function discoverGeneralAgentCapabilities(
  input: { need: string; maxResults?: number },
  env: NodeJS.ProcessEnv = process.env
) {
  const certified = discoverCertifiedCapabilities(input, env);
  return {
    ...certified,
    generalAgentSchemaVersion: GENERAL_AGENT_CAPABILITY_DISCOVERY_V1,
    executionSubstrates: [DYNAMIC_REVIT_PROGRAM_SUBSTRATE_V1]
  };
}

export { assertDiscoveredCapability };
