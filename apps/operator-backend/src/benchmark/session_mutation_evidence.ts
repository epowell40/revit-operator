import { canonicalBenchmarkRevitPath } from "./durable_tool_evidence.js";

export function verifiedSessionMutationPaths(evidence: Record<string, unknown>): Set<string> {
  const rows = Array.isArray(evidence.session_mutation_verifications)
    ? evidence.session_mutation_verifications
    : [];
  return new Set(rows.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const row = value as Record<string, unknown>;
    const readback = row.readback && typeof row.readback === "object" && !Array.isArray(row.readback)
      ? row.readback as Record<string, unknown> : {};
    const valid = row.schema === "revit-operator.session-mutation-verification/v1"
      && !!String(row.source_session_id || "").trim()
      && /^notification:\d+$/.test(String(row.apply_action_id || ""))
      && /^notification:\d+$/.test(String(row.verification_action_id || ""))
      && /^[a-f0-9]{64}$/.test(String(row.apply_result_sha256 || ""))
      && /^[a-f0-9]{64}$/.test(String(row.verification_result_sha256 || ""))
      && /^[a-f0-9]{64}$/.test(String(row.target_tokens_sha256 || ""))
      && /^[a-f0-9]{64}$/.test(String(row.value_tokens_sha256 || ""))
      && readback.matched_target === true
      && readback.matched_after_value === true;
    const path = canonicalBenchmarkRevitPath(String(row.apply_path || ""));
    return valid && path ? [path] : [];
  }));
}
