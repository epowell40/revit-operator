import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import {
  createEngineeringCaseEvidenceProvenance,
  evaluateEngineeringInvariantCase,
  type EngineeringCaseDefinition,
  type EngineeringCaseNativeEvidence
} from "../src/existing_conditions/engineering_case_runner.js";
import {
  auditBenchmarkDatasetLeakage,
  validateEngineeringStandardsContext,
  type BenchmarkDatasetCase,
  type EngineeringStandardsContext
} from "../src/existing_conditions/engineering_invariants.js";

const FIXTURES = path.resolve(process.cwd(), "test/fixtures/existing_conditions/engineering_compliance");
const PROFILE_HASH = "e28ae52a495eaeec357987854c75d5f1cfec1b455a71c6612f74b5a235ef373e";
const EVALUATOR_KEY = "test-only-evaluator-signing-key-0123456789abcdef0123456789abcdef";

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), "utf8")) as T;
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function evaluate(caseName: string, evidenceName: string) {
  const definition = readJson<EngineeringCaseDefinition>(caseName);
  const evidence = readJson<EngineeringCaseNativeEvidence>(evidenceName);
  const provenance = createEngineeringCaseEvidenceProvenance(definition, evidence, EVALUATOR_KEY);
  return evaluateEngineeringInvariantCase(definition, evidence, provenance, EVALUATOR_KEY);
}

test("benchmark profile is immutable, explicit about benchmark-only use, and has valid primary-source receipts", () => {
  const profilePath = path.join(FIXTURES, "benchmark_standards_profile.json");
  const profile = readJson<EngineeringStandardsContext & { benchmark_only: boolean }>("benchmark_standards_profile.json");
  assert.equal(sha256(profilePath), PROFILE_HASH);
  assert.equal(profile.benchmark_only, true);
  assert.deepEqual(validateEngineeringStandardsContext(profile), []);
  assert.match(profile.jurisdiction, /not a permit-jurisdiction adoption/i);
});

test("GFCI holdout accepts a verified breaker path and rejects a GFCI-looking family without native protection proof", () => {
  const passing = evaluate("electrical_gfci_holdout.case.json", "electrical_gfci_holdout.pass_breaker.evidence.json");
  const labelOnly = evaluate("electrical_gfci_holdout.case.json", "electrical_gfci_holdout.fail_label_only.evidence.json");
  assert.equal(passing.valid, true);
  assert.equal(passing.passed, true);
  assert.equal(labelOnly.valid, true);
  assert.equal(labelOnly.passed, false);
  assert.equal(labelOnly.checks[0]?.failure_classification, "gfci_protection_missing_or_unverified");
});

test("dwelling holdout accepts different valid layouts and rejects uncovered wall space", () => {
  const definition = readJson<EngineeringCaseDefinition>("electrical_wall_coverage_holdout.case.json");
  const alternate = readJson<EngineeringCaseNativeEvidence>("electrical_wall_coverage_holdout.pass_alternate_layout.evidence.json");
  const secondSolution = structuredClone(alternate);
  const check = secondSolution.checks[0];
  if (check?.type !== "dwelling_wall_coverage") throw new Error("Unexpected fixture evidence type.");
  check.receptacles = [
    { element_key: "host:west-alt-1", segment_id: "living-west-of-door", offset_along_segment_ft: 2, counts_for_coverage: true },
    { element_key: "host:west-alt-2", segment_id: "living-west-of-door", offset_along_segment_ft: 11, counts_for_coverage: true },
    { element_key: "host:east-alt-1", segment_id: "living-east-of-door", offset_along_segment_ft: 6, counts_for_coverage: true }
  ];
  assert.equal(evaluateEngineeringInvariantCase(
    definition,
    alternate,
    createEngineeringCaseEvidenceProvenance(definition, alternate, EVALUATOR_KEY),
    EVALUATOR_KEY
  ).passed, true);
  assert.equal(evaluateEngineeringInvariantCase(
    definition,
    secondSolution,
    createEngineeringCaseEvidenceProvenance(definition, secondSolution, EVALUATOR_KEY),
    EVALUATOR_KEY
  ).passed, true);
  const gap = evaluate("electrical_wall_coverage_holdout.case.json", "electrical_wall_coverage_holdout.fail_gap.evidence.json");
  assert.equal(gap.valid, true);
  assert.equal(gap.passed, false);
  assert.ok(gap.checks.some((result) => result.failure_classification === "dwelling_wall_space_coverage_gap"));
});

test("circuit holdout scores native yokes and calculated load, not a memorized receptacle count", () => {
  const passing = evaluate("electrical_circuit_loading_holdout.case.json", "electrical_circuit_loading_holdout.pass_rebalanced.evidence.json");
  const overloaded = evaluate("electrical_circuit_loading_holdout.case.json", "electrical_circuit_loading_holdout.fail_overloaded.evidence.json");
  assert.equal(passing.passed, true);
  assert.deepEqual(passing.checks.map((check) => check.details.required_va), [2070, 2065]);
  assert.equal(overloaded.passed, false);
  assert.equal(overloaded.checks[0]?.details.required_va, 2585);
  assert.equal(overloaded.checks[0]?.details.circuit_capacity_va, 2400);
  assert.equal(overloaded.checks[0]?.failure_classification, "circuit_calculated_load_exceeds_capacity");
});

test("plumbing holdout requires lavatory hot and cold while prohibiting conventional water-closet hot water", () => {
  const passing = evaluate("plumbing_fixture_services_holdout.case.json", "plumbing_fixture_services_holdout.pass.evidence.json");
  const failing = evaluate("plumbing_fixture_services_holdout.case.json", "plumbing_fixture_services_holdout.fail_missing_hot_and_prohibited_hot.evidence.json");
  assert.equal(passing.passed, true);
  assert.equal(failing.valid, true);
  assert.equal(failing.passed, false);
  assert.ok(failing.checks.some((check) => check.details.missing_services === "domestic_hot_water"));
  assert.ok(failing.checks.some((check) => check.details.prohibited_services_present === "domestic_hot_water"));
});

test("case runner rejects forged evaluator fields, hash drift, missing checks, and extra evidence before scoring", () => {
  const definition = readJson<EngineeringCaseDefinition>("electrical_gfci_holdout.case.json");
  const evidence = readJson<EngineeringCaseNativeEvidence>("electrical_gfci_holdout.pass_breaker.evidence.json");
  const signedOriginal = createEngineeringCaseEvidenceProvenance(definition, evidence, EVALUATOR_KEY);
  const tampered = {
    ...evidence,
    standards_profile_sha256: "0".repeat(64),
    native_evidence_owner: "agent" as "evaluator",
    checks: [
      ...evidence.checks.map((check) => ({ ...check, check_id: "unexpected-check" }))
    ]
  };
  const result = evaluateEngineeringInvariantCase(definition, tampered, signedOriginal, EVALUATOR_KEY);
  assert.equal(result.valid, false);
  assert.equal(result.passed, false);
  assert.ok(result.invalid_reasons.includes("evidence_standards_profile_hash_mismatch"));
  assert.ok(result.invalid_reasons.includes("evidence_not_evaluator_owned"));
  assert.ok(result.invalid_reasons.includes("evidence_check_missing:sink-protection"));
  assert.ok(result.invalid_reasons.includes("evidence_check_unexpected:unexpected-check"));
  assert.ok(result.invalid_reasons.includes("evaluator_provenance_evidence_hash_mismatch"));
  const resignedWithWrongKey = createEngineeringCaseEvidenceProvenance(definition, tampered, "wrong-evaluator-key-0123456789abcdef0123456789abcdef");
  const wrongKeyResult = evaluateEngineeringInvariantCase(definition, tampered, resignedWithWrongKey, EVALUATOR_KEY);
  assert.ok(wrongKeyResult.invalid_reasons.includes("evaluator_provenance_signature_invalid"));
});

test("corpus manifest passes strict cross-split leakage checks", () => {
  const manifest = readJson<{ cases: BenchmarkDatasetCase[] }>("corpus_manifest.json");
  assert.deepEqual(auditBenchmarkDatasetLeakage(manifest.cases), []);
  assert.ok(manifest.cases.filter((item) => item.split === "evaluation")
    .every((item) => item.geometry_origin === "independently_generated"));
});

test("CLI requires signed evaluator provenance and exits nonzero for valid failing cases", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "engineering-case-cli-"));
  try {
    const keyPath = path.join(temp, "evaluator.key");
    fs.writeFileSync(keyPath, EVALUATOR_KEY, "utf8");
    const provenancePath = path.join(temp, "passing-provenance.json");
    const out = path.join(temp, "evaluation.json");
    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const seal = spawnSync(process.execPath, [
      cli,
      "seal-engineering-evidence",
      "--case", path.join(FIXTURES, "electrical_gfci_holdout.case.json"),
      "--native-evidence", path.join(FIXTURES, "electrical_gfci_holdout.pass_breaker.evidence.json"),
      "--evaluator-key-file", keyPath,
      "--out", provenancePath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(seal.status, 0, seal.stderr || seal.stdout);
    const result = spawnSync(process.execPath, [
      cli,
      "evaluate-engineering-case",
      "--case", path.join(FIXTURES, "electrical_gfci_holdout.case.json"),
      "--native-evidence", path.join(FIXTURES, "electrical_gfci_holdout.pass_breaker.evidence.json"),
      "--evaluator-provenance", provenancePath,
      "--evaluator-key-file", keyPath,
      "--out", out
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evaluation = JSON.parse(fs.readFileSync(out, "utf8"));
    assert.equal(evaluation.valid, true);
    assert.equal(evaluation.passed, true);
    assert.match(evaluation.checks[0].check_id, /holdout-electrical-gfci-sink-breaker-v1\/sink-protection/);

    const failingProvenancePath = path.join(temp, "failing-provenance.json");
    const failingOut = path.join(temp, "failing-evaluation.json");
    const sealFailing = spawnSync(process.execPath, [
      cli,
      "seal-engineering-evidence",
      "--case", path.join(FIXTURES, "electrical_gfci_holdout.case.json"),
      "--native-evidence", path.join(FIXTURES, "electrical_gfci_holdout.fail_label_only.evidence.json"),
      "--evaluator-key-file", keyPath,
      "--out", failingProvenancePath
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(sealFailing.status, 0, sealFailing.stderr || sealFailing.stdout);
    const failingResult = spawnSync(process.execPath, [
      cli,
      "evaluate-engineering-case",
      "--case", path.join(FIXTURES, "electrical_gfci_holdout.case.json"),
      "--native-evidence", path.join(FIXTURES, "electrical_gfci_holdout.fail_label_only.evidence.json"),
      "--evaluator-provenance", failingProvenancePath,
      "--evaluator-key-file", keyPath,
      "--out", failingOut
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(failingResult.status, 0);
    assert.match(failingResult.stderr, /engineering_case_failed:gfci_protection_missing_or_unverified/);
    assert.equal(JSON.parse(fs.readFileSync(failingOut, "utf8")).passed, false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
