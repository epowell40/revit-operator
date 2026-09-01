export type ToolSearchRiskCandidate = {
  path?: unknown;
  risk?: unknown;
};

const MUTATION_DISCOVERY_TOKEN = /\b(?:add(?:ing)?|appl(?:y|ying)|creat(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|modif(?:y|ying)|mov(?:e|ing)|plac(?:e|ing)|remov(?:e|ing)|renam(?:e|ing)|replac(?:e|ement|ing)|resiz(?:e|ing)|rotat(?:e|ing)|set|setting|updat(?:e|ing)|writ(?:e|ing))\b/i;

export const TOOL_SEARCH_RISK_FILTER_ADVISORY_V1 = "revit-operator.tool-search-risk-filter-advisory/v1" as const;

/**
 * Registry risk describes the possible committed effect of a route. It does
 * not become `low` merely because that route also supports dry-run or rollback
 * preview. A low-only search for mutation work therefore needs an explicit,
 * non-authorizing view of the omitted typed mutation candidates.
 */
export function shouldExposeBroaderRiskCandidates(query: string, requestedRisk: string): boolean {
  return requestedRisk.trim().toLowerCase() === "low" && MUTATION_DISCOVERY_TOKEN.test(query);
}

export function partitionRiskFilteredCandidates<T extends ToolSearchRiskCandidate>(
  candidates: readonly T[],
  requestedRisk: string,
  maxMatches: number,
  maxBroaderCandidates = 8
): { matches: T[]; broaderRiskCandidates: T[] } {
  const normalizedRisk = requestedRisk.trim().toLowerCase();
  if (!normalizedRisk) {
    return { matches: candidates.slice(0, maxMatches), broaderRiskCandidates: [] };
  }
  const matches = candidates
    .filter(candidate => String(candidate.risk ?? "").trim().toLowerCase() === normalizedRisk)
    .slice(0, maxMatches);
  const broaderRiskCandidates = candidates
    .filter(candidate => {
      const candidateRisk = String(candidate.risk ?? "").trim().toLowerCase();
      return candidateRisk.length > 0 && candidateRisk !== normalizedRisk;
    })
    .slice(0, maxBroaderCandidates);
  return { matches, broaderRiskCandidates };
}

export function buildToolSearchRiskFilterAdvisory<T extends ToolSearchRiskCandidate>(
  requestedRisk: string,
  broaderRiskCandidates: readonly T[]
) {
  return {
    schema: TOOL_SEARCH_RISK_FILTER_ADVISORY_V1,
    code: "risk_filter_excludes_mutation_capabilities",
    requested_endpoint_risk: requestedRisk.trim().toLowerCase(),
    meaning: "Registry risk classifies a route's possible committed effect; dry-run or rollback support does not reclassify the route as low risk.",
    authorization_effect: "none",
    guidance: "Prefer a dedicated typed route from broader_risk_candidates when it supports the required preview or dry-run contract. Omit the risk filter for full discovery. Existing admission, write-grant, approval, and effect controls still apply.",
    broader_risk_candidates: broaderRiskCandidates
  };
}
