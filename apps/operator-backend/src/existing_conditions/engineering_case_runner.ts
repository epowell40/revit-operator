import crypto from "node:crypto";
import {
  evaluateDwellingWallCoverage,
  evaluateGfciProtection,
  evaluatePlumbingFixtureServices,
  evaluateReceptacleCircuitLoading,
  type CircuitCapacityEvidence,
  type DwellingCoverageReceptacle,
  type DwellingWallSegment,
  type DwellingWallSpaceRule,
  type EngineeringCheckResult,
  type EngineeringSourceReference,
  type ExistingConditionsBenchmarkTaskClass,
  type GfciProtectionRule,
  type GfciReceptacleEvidence,
  type PlumbingFixtureEvidence,
  type PlumbingFixtureServiceRule,
  type ReceptacleCircuitLoadRule
} from "./engineering_invariants.js";

export type EngineeringCaseDefinition = {
  schema_version: 1;
  case_id: string;
  task_class: Extract<ExistingConditionsBenchmarkTaskClass, "standards_compliance_repair" | "generative_layout">;
  discipline: "electrical" | "plumbing" | "mixed";
  standards_profile_sha256: string;
  checks: EngineeringCaseCheckDefinition[];
};

export type EngineeringCaseCheckDefinition =
  | {
    check_id: string;
    type: "gfci_protection";
    rule: GfciProtectionRule;
  }
  | {
    check_id: string;
    type: "dwelling_wall_coverage";
    rule: DwellingWallSpaceRule;
    segments: DwellingWallSegment[];
  }
  | {
    check_id: string;
    type: "receptacle_circuit_loading";
    rule: ReceptacleCircuitLoadRule;
  }
  | {
    check_id: string;
    type: "plumbing_fixture_services";
    rules: PlumbingFixtureServiceRule[];
  };

export type EngineeringCaseNativeEvidence = {
  schema_version: 1;
  case_id: string;
  standards_profile_sha256: string;
  native_evidence_owner: "evaluator";
  native_readback: boolean;
  checks: EngineeringCaseCheckEvidence[];
};

export type EngineeringCaseCheckEvidence =
  | {
    check_id: string;
    type: "gfci_protection";
    receptacles: GfciReceptacleEvidence[];
  }
  | {
    check_id: string;
    type: "dwelling_wall_coverage";
    receptacles: DwellingCoverageReceptacle[];
  }
  | {
    check_id: string;
    type: "receptacle_circuit_loading";
    circuits: CircuitCapacityEvidence[];
  }
  | {
    check_id: string;
    type: "plumbing_fixture_services";
    fixtures: PlumbingFixtureEvidence[];
  };

export type EngineeringCaseEvaluation = {
  schema_version: 1;
  case_id: string;
  valid: boolean;
  passed: boolean;
  invalid_reasons: string[];
  checks: EngineeringCheckResult[];
};

export type EngineeringCaseEvidenceProvenance = {
  schema_version: 1;
  case_id: string;
  case_definition_sha256: string;
  native_evidence_sha256: string;
  standards_profile_sha256: string;
  evaluator_owned: true;
  runner_isolation_verified: true;
  signature_algorithm: "hmac-sha256";
  signature: string;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function validSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(text(value));
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function engineeringCaseArtifactSha256(value: unknown): string {
  return crypto.createHash("sha256").update(stableJson(value), "utf8").digest("hex");
}

function provenancePayload(provenance: Omit<EngineeringCaseEvidenceProvenance, "signature">): string {
  return stableJson(provenance);
}

function normalizedEvaluatorKey(evaluatorKey: string | Buffer): Buffer {
  const key = Buffer.isBuffer(evaluatorKey) ? evaluatorKey : Buffer.from(evaluatorKey, "utf8");
  if (key.length < 32) throw new Error("Evaluator provenance key must contain at least 32 bytes.");
  return key;
}

export function createEngineeringCaseEvidenceProvenance(
  definition: EngineeringCaseDefinition,
  evidence: EngineeringCaseNativeEvidence,
  evaluatorKey: string | Buffer
): EngineeringCaseEvidenceProvenance {
  const unsigned: Omit<EngineeringCaseEvidenceProvenance, "signature"> = {
    schema_version: 1,
    case_id: text(definition.case_id),
    case_definition_sha256: engineeringCaseArtifactSha256(definition),
    native_evidence_sha256: engineeringCaseArtifactSha256(evidence),
    standards_profile_sha256: text(definition.standards_profile_sha256).toLowerCase(),
    evaluator_owned: true,
    runner_isolation_verified: true,
    signature_algorithm: "hmac-sha256"
  };
  return {
    ...unsigned,
    signature: crypto.createHmac("sha256", normalizedEvaluatorKey(evaluatorKey))
      .update(provenancePayload(unsigned), "utf8")
      .digest("hex")
  };
}

function provenanceSignatureValid(
  provenance: EngineeringCaseEvidenceProvenance,
  evaluatorKey: string | Buffer
): boolean {
  if (!/^[a-f0-9]{64}$/i.test(text(provenance.signature))) return false;
  const { signature: _signature, ...unsigned } = provenance;
  const expected = crypto.createHmac("sha256", normalizedEvaluatorKey(evaluatorKey))
    .update(provenancePayload(unsigned), "utf8")
    .digest();
  const actual = Buffer.from(provenance.signature, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))];
}

function validSource(source: EngineeringSourceReference | null | undefined): boolean {
  return Boolean(source
    && text(source.authority)
    && text(source.title)
    && text(source.edition)
    && text(source.section)
    && text(source.url)
    && validSha256(source.sha256));
}

function definitionSources(check: EngineeringCaseCheckDefinition): EngineeringSourceReference[] {
  if (check.type === "plumbing_fixture_services") {
    return check.rules.flatMap((rule) => [
      rule.source,
      ...(rule.connection_sizes ?? []).map((size) => size.source)
    ]);
  }
  return [check.rule.source];
}

function prefixChecks(caseId: string, checkId: string, checks: EngineeringCheckResult[]): EngineeringCheckResult[] {
  return checks.map((check) => ({
    ...check,
    check_id: `${caseId}/${checkId}/${check.check_id}`
  }));
}

export function evaluateEngineeringInvariantCase(
  definition: EngineeringCaseDefinition,
  evidence: EngineeringCaseNativeEvidence,
  provenance?: EngineeringCaseEvidenceProvenance | null,
  evaluatorKey?: string | Buffer | null
): EngineeringCaseEvaluation {
  const invalidReasons: string[] = [];
  const caseId = text(definition?.case_id);
  if (definition?.schema_version !== 1) invalidReasons.push("case_schema_version_unsupported");
  if (!caseId) invalidReasons.push("case_id_missing");
  if (!new Set(["standards_compliance_repair", "generative_layout"]).has(text(definition?.task_class))) {
    invalidReasons.push("case_task_class_invalid");
  }
  if (!validSha256(definition?.standards_profile_sha256)) invalidReasons.push("case_standards_profile_sha256_invalid");
  if (!Array.isArray(definition?.checks) || definition.checks.length === 0) invalidReasons.push("case_checks_missing");

  const definitionIds = (definition?.checks ?? []).map((check) => text(check.check_id));
  if (definitionIds.some((id) => !id) || unique(definitionIds).length !== definitionIds.length) {
    invalidReasons.push("case_check_ids_invalid");
  }
  for (const check of definition?.checks ?? []) {
    if (definitionSources(check).some((source) => !validSource(source))) {
      invalidReasons.push(`case_check_source_invalid:${text(check.check_id) || "unknown"}`);
    }
    if (check.type === "plumbing_fixture_services" && check.rules.length === 0) {
      invalidReasons.push(`case_plumbing_rules_missing:${text(check.check_id) || "unknown"}`);
    }
  }

  if (evidence?.schema_version !== 1) invalidReasons.push("evidence_schema_version_unsupported");
  if (text(evidence?.case_id) !== caseId) invalidReasons.push("evidence_case_id_mismatch");
  if (text(evidence?.standards_profile_sha256) !== text(definition?.standards_profile_sha256)) {
    invalidReasons.push("evidence_standards_profile_hash_mismatch");
  }
  if (evidence?.native_evidence_owner !== "evaluator") invalidReasons.push("evidence_not_evaluator_owned");
  if (!evidence?.native_readback) invalidReasons.push("evidence_native_readback_missing");
  if (!Array.isArray(evidence?.checks)) invalidReasons.push("evidence_checks_missing");

  if (!provenance) {
    invalidReasons.push("evaluator_provenance_missing");
  } else {
    if (provenance.schema_version !== 1) invalidReasons.push("evaluator_provenance_schema_version_unsupported");
    if (text(provenance.case_id) !== caseId) invalidReasons.push("evaluator_provenance_case_id_mismatch");
    if (text(provenance.case_definition_sha256) !== engineeringCaseArtifactSha256(definition)) {
      invalidReasons.push("evaluator_provenance_case_hash_mismatch");
    }
    if (text(provenance.native_evidence_sha256) !== engineeringCaseArtifactSha256(evidence)) {
      invalidReasons.push("evaluator_provenance_evidence_hash_mismatch");
    }
    if (text(provenance.standards_profile_sha256) !== text(definition?.standards_profile_sha256).toLowerCase()) {
      invalidReasons.push("evaluator_provenance_standards_profile_hash_mismatch");
    }
    if (provenance.evaluator_owned !== true || provenance.runner_isolation_verified !== true) {
      invalidReasons.push("evaluator_provenance_ownership_invalid");
    }
    if (provenance.signature_algorithm !== "hmac-sha256") invalidReasons.push("evaluator_provenance_signature_algorithm_invalid");
    if (evaluatorKey == null) {
      invalidReasons.push("evaluator_provenance_key_missing");
    } else {
      try {
        if (!provenanceSignatureValid(provenance, evaluatorKey)) invalidReasons.push("evaluator_provenance_signature_invalid");
      } catch {
        invalidReasons.push("evaluator_provenance_key_invalid");
      }
    }
  }

  const evidenceIds = (evidence?.checks ?? []).map((check) => text(check.check_id));
  if (evidenceIds.some((id) => !id) || unique(evidenceIds).length !== evidenceIds.length) {
    invalidReasons.push("evidence_check_ids_invalid");
  }
  for (const id of definitionIds) {
    if (!evidenceIds.includes(id)) invalidReasons.push(`evidence_check_missing:${id}`);
  }
  for (const id of evidenceIds) {
    if (!definitionIds.includes(id)) invalidReasons.push(`evidence_check_unexpected:${id}`);
  }

  const checks: EngineeringCheckResult[] = [];
  for (const definitionCheck of definition?.checks ?? []) {
    const checkId = text(definitionCheck.check_id);
    const nativeEvidence = (evidence?.checks ?? []).find((candidate) => text(candidate.check_id) === checkId);
    if (!nativeEvidence) continue;
    if (nativeEvidence.type !== definitionCheck.type) {
      invalidReasons.push(`evidence_check_type_mismatch:${checkId}`);
      continue;
    }
    let evaluated: EngineeringCheckResult[] = [];
    if (definitionCheck.type === "gfci_protection" && nativeEvidence.type === "gfci_protection") {
      evaluated = evaluateGfciProtection(definitionCheck.rule, nativeEvidence.receptacles);
    } else if (definitionCheck.type === "dwelling_wall_coverage" && nativeEvidence.type === "dwelling_wall_coverage") {
      evaluated = evaluateDwellingWallCoverage(definitionCheck.rule, definitionCheck.segments, nativeEvidence.receptacles);
    } else if (definitionCheck.type === "receptacle_circuit_loading" && nativeEvidence.type === "receptacle_circuit_loading") {
      evaluated = evaluateReceptacleCircuitLoading(definitionCheck.rule, nativeEvidence.circuits);
    } else if (definitionCheck.type === "plumbing_fixture_services" && nativeEvidence.type === "plumbing_fixture_services") {
      evaluated = evaluatePlumbingFixtureServices(definitionCheck.rules, nativeEvidence.fixtures);
    }
    if (evaluated.length === 0) invalidReasons.push(`evidence_check_empty:${checkId}`);
    checks.push(...prefixChecks(caseId, checkId, evaluated));
  }

  const distinctInvalidReasons = unique(invalidReasons);
  const valid = distinctInvalidReasons.length === 0;
  return {
    schema_version: 1,
    case_id: caseId,
    valid,
    passed: valid && checks.length > 0 && checks.every((check) => check.passed),
    invalid_reasons: distinctInvalidReasons,
    checks
  };
}
