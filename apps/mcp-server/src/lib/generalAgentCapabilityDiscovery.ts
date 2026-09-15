import { scoreToolSearchCandidateV3, compareToolSearchCandidatesV3, TOOL_SEARCH_RANKING_VERSION_V3 } from "./toolSearchRanking.js";
import {
  assertDiscoveredCapability,
  discoverCertifiedCapabilities
} from "./certifiedCapabilityProjection.js";

export const GENERAL_AGENT_CAPABILITY_DISCOVERY_V1 = "revit-operator.general-agent-capability-discovery.v1" as const;

type GeneralRegistryEntry = {
  method?: string;
  path?: string;
  title?: string;
  description?: string;
  example?: string;
  group?: string;
  risk?: string;
  required_fields?: string[];
  optional_fields?: string[];
};

export async function discoverHostedGeneralAgentCapabilities(
  input: { need: string; maxResults?: number },
  loadRegistry: () => Promise<{ tools?: GeneralRegistryEntry[] }>
) {
  const registry = await loadRegistry();
  const maxResults = input.maxResults ?? 4;
  const capabilities = (registry.tools ?? [])
    .map(tool => ({ tool, score: scoreToolSearchCandidateV3(tool, input.need) }))
    .filter(item => item.score > 0)
    .sort(compareToolSearchCandidatesV3)
    .slice(0, maxResults)
    .map(({ tool, score }) => ({
      method: tool.method ?? "",
      path: tool.path ?? "",
      group: tool.group ?? "",
      risk: tool.risk ?? "",
      title: tool.title ?? "",
      description: tool.description ?? "",
      ...(tool.required_fields?.length ? { required_fields: tool.required_fields } : {}),
      ...(tool.optional_fields?.length ? { optional_fields: tool.optional_fields.slice(0, 12) } : {}),
      score,
      executionTool: "revit_call_tool",
      authorization: "general_agent_ready"
    }));
  return {
    schemaVersion: "revit-operator.general-agent-capability-discovery.v2",
    status: capabilities.length ? "available" as const : "unavailable" as const,
    exposureMode: "general" as const,
    typedCatalogExposure: "full" as const,
    ranking_version: TOOL_SEARCH_RANKING_VERSION_V3,
    capabilities,
    reasonCodes: capabilities.length ? ["GENERAL_AGENT_CAPABILITIES_FOUND"] : ["GENERAL_AGENT_CAPABILITIES_UNAVAILABLE"]
  };
}

export const DYNAMIC_REVIT_PROGRAM_SUBSTRATE_V1 = {
  id: "dynamic_revit_program",
  kind: "dynamic_program",
  title: "Generate and preview a bounded task-specific Revit program",
  description: "For complex multi-step Revit work using loops, branching, custom algorithms, structured assertions, and bounded observe-revise-rerun feedback within explicit capability and effect limits.",
  semantics: {
    previewBeforeCommit: true,
    machineAccess: "restricted",
    externalFileEffects: "explicit_capability_required",
    iterativeObservation: "bounded_needs_facts",
    evidenceBoundIteration: "facts_repair_retry_max_5",
    structuredDiagnostics: "phase_range_step_assertion_repair_action",
    stepPlanning: "ordered_dependency_waves_and_counts",
    semanticTrace: "exact_step_node_fact_binding",
    deterministicReplay: true
  },
  admission: {
    required: true,
    contract: "dynamic_program_admission/v1",
    state: "not_admitted_by_discovery",
    authorizationGranted: false
  },
  execution: {
    tool: "operator_run_dynamic_revit_program",
    availability: "authenticated_general_agent_or_laboratory",
    hostedGeneralAgentExposure: true,
    certifiedProductionExposure: false
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
