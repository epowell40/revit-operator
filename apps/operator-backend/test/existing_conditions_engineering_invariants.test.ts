import assert from "node:assert/strict";
import test from "node:test";
import {
  auditBenchmarkDatasetLeakage,
  evaluateDwellingWallCoverage,
  evaluateGfciProtection,
  evaluatePlumbingFixtureServices,
  evaluateReceptacleCircuitLoading,
  scoreEngineeringInvariantBenchmark,
  validateEngineeringBenchmarkTaskContract,
  validateEngineeringStandardsContext,
  type EngineeringSourceReference,
  type EngineeringStandardsContext
} from "../src/existing_conditions/engineering_invariants.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);

function nec(section: string): EngineeringSourceReference {
  return {
    authority: "NFPA",
    title: "NFPA 70 National Electrical Code",
    edition: "2023",
    section,
    url: "https://link.nfpa.org/",
    sha256: HASH_A
  };
}

const IPC: EngineeringSourceReference = {
  authority: "ICC",
  title: "International Plumbing Code",
  edition: "2024",
  section: "fixture profile source section",
  url: "https://codes.iccsafe.org/",
  sha256: HASH_B
};

const PROJECT_PLUMBING: EngineeringSourceReference = {
  authority: "Benchmark AHJ",
  title: "Project plumbing fixture schedule",
  edition: "Revision 1",
  section: "P-01 conventional flush-tank water closet",
  url: "https://example.invalid/project-criteria",
  sha256: HASH_C
};

const STANDARDS: EngineeringStandardsContext = {
  profile_id: "benchmark-nec-2023",
  profile_revision: "1",
  jurisdiction: "Synthetic benchmark jurisdiction",
  authority_having_jurisdiction: "Benchmark AHJ",
  code_family: "NFPA 70",
  edition: "2023",
  effective_date: "2026-01-01",
  occupancy_or_use_classification: "dwelling unit",
  local_amendments: [],
  project_criteria: [{
    id: "electrical-basis-of-design",
    revision: "1",
    source_url: "https://example.invalid/electrical-bod",
    sha256: HASH_B
  }],
  conflict_precedence: ["local_amendments", "adopted_code", "project_criteria"],
  sources: [nec("210.8")]
};

const LEGACY_NEC: EngineeringSourceReference = {
  authority: "NFPA",
  title: "NFPA 70 National Electrical Code",
  edition: "2023",
  section: "210.8",
  url: "",
  sha256: "not-a-hash"
};

test("task contracts separate exact reconstruction from standards and generative work", () => {
  assert.deepEqual(validateEngineeringBenchmarkTaskContract({
    task_class: "exact_reconstruction",
    acceptance_basis: ["hidden_truth_geometry", "scope_safety"],
    allows_multiple_valid_solutions: false,
    requires_exact_element_ids: false,
    requires_exact_coordinates: true,
    hidden_truth_fingerprint: "truth-sha256",
    requires_evaluator_change_receipt: true,
    requires_evaluator_access_provenance: true
  }), []);
  assert.deepEqual(validateEngineeringBenchmarkTaskContract({
    task_class: "generative_layout",
    acceptance_basis: ["engineering_invariants", "system_topology", "scope_safety"],
    allows_multiple_valid_solutions: true,
    requires_exact_element_ids: false,
    requires_exact_coordinates: false,
    standards_context: STANDARDS,
    standards_profile_artifact_sha256: HASH_A,
    requires_evaluator_change_receipt: true,
    requires_evaluator_access_provenance: true
  }), []);
  assert.ok(validateEngineeringBenchmarkTaskContract({
    task_class: "standards_compliance_repair",
    acceptance_basis: ["hidden_truth_geometry", "scope_safety"],
    allows_multiple_valid_solutions: false,
    requires_exact_element_ids: true,
    requires_exact_coordinates: true,
    requires_evaluator_change_receipt: false,
    requires_evaluator_access_provenance: false
  }).includes("standards_context_missing"));
});

test("standards context rejects source references without immutable provenance", () => {
  assert.ok(validateEngineeringStandardsContext({ ...STANDARDS, sources: [LEGACY_NEC] })
    .includes("source_reference_incomplete:0"));
});

test("GFCI checks accept verified upstream protection and reject a visual type label alone", () => {
  const results = evaluateGfciProtection({
    rule_id: "sink-gfci",
    source: nec("210.8"),
    sink_distance_limit_ft: 6,
    distance_measurement: "fixture-supplied adopted-code method",
    applicable_location_classes: ["sink"],
    applicable_voltage_to_ground_max: 150,
    applicable_receptacle_amp_max: 50,
    allowed_exception_ids: []
  }, [
    {
      element_key: "breaker-protected",
      location_classes: ["sink"],
      distance_to_sink_ft: 4,
      voltage_to_ground: 120,
      receptacle_amps: 20,
      protection: {
        method: "branch_breaker",
        protection_device_key: "breaker:P1-4",
        path_element_keys: ["breaker:P1-4", "breaker-protected"],
        native_path_verified: true,
        protected_circuit_id: "P1-4",
        receptacle_circuit_id: "P1-4"
      }
    },
    {
      element_key: "family-name-only",
      location_classes: ["sink"],
      distance_to_sink_ft: 4,
      voltage_to_ground: 120,
      receptacle_amps: 20,
      protection: {
        method: "integral_device",
        protection_device_key: "family-name-only",
        path_element_keys: ["family-name-only"],
        native_path_verified: false
      }
    }
  ]);
  assert.equal(results[0].passed, true);
  assert.equal(results[1].passed, false);
  const invalid = evaluateGfciProtection({
    rule_id: "sink-gfci",
    source: nec("210.8"),
    sink_distance_limit_ft: 6,
    distance_measurement: "fixture-supplied adopted-code method",
    applicable_location_classes: ["sink"],
    applicable_voltage_to_ground_max: 150,
    applicable_receptacle_amp_max: 50,
    allowed_exception_ids: []
  }, [{
    element_key: "negative-rating",
    location_classes: ["sink"],
    distance_to_sink_ft: -1,
    voltage_to_ground: -120,
    receptacle_amps: -20,
    protection: null
  }])[0];
  assert.equal(invalid.passed, false);
  assert.equal(invalid.failure_classification, "gfci_applicability_evidence_invalid");
});

test("dwelling wall coverage accepts multiple layouts and detects an uncovered gap", () => {
  const rule = {
    rule_id: "dwelling-wall-coverage",
    source: nec("210.52(A)"),
    minimum_qualifying_wall_width_ft: 2,
    maximum_point_distance_to_receptacle_ft: 6,
    maximum_floor_receptacle_distance_from_wall_ft: 1.5,
    no_qualifying_segments: "fail_invalid_fixture" as const
  };
  const segments = [{ segment_id: "wall-a", length_ft: 18, interrupted: false }];
  assert.equal(evaluateDwellingWallCoverage(rule, segments, [
    { element_key: "r1", segment_id: "wall-a", offset_along_segment_ft: 3, counts_for_coverage: true },
    { element_key: "r2", segment_id: "wall-a", offset_along_segment_ft: 13, counts_for_coverage: true }
  ])[0].passed, true);
  assert.equal(evaluateDwellingWallCoverage(rule, segments, [
    { element_key: "r1", segment_id: "wall-a", offset_along_segment_ft: 2, counts_for_coverage: true }
  ])[0].passed, false);
  assert.equal(evaluateDwellingWallCoverage(rule, [], [])[0].failure_classification,
    "dwelling_wall_space_scope_has_no_qualifying_segments");
  assert.equal(evaluateDwellingWallCoverage(rule, segments, [
    { element_key: "bad", segment_id: "wall-a", offset_along_segment_ft: 25, counts_for_coverage: true }
  ])[0].failure_classification, "dwelling_wall_space_evidence_invalid");
});

test("circuit loading uses yokes or straps and does not impose a blanket 80 percent limit", () => {
  const result = evaluateReceptacleCircuitLoading({
    rule_id: "receptacle-circuit-load",
    source: nec("220.14(I), 210.20(A)"),
    volt_amperes_per_yoke_or_strap: 180,
    continuous_load_multiplier: 1.25
  }, [{
    circuit_id: "P1-6",
    voltage: 120,
    phase_count: 1,
    breaker_amps: 20,
    native_membership_verified: true,
    native_ocpd_verified: true,
    native_conductor_verified: true,
    conductor_ampacity_amps: 20,
    conductor_ocpd_compatibility_verified: true,
    receptacles: [
      { element_key: "duplex", yoke_or_strap_count: 1, native_yoke_or_strap_count_verified: true, continuous: false },
      { element_key: "quad-two-yokes", yoke_or_strap_count: 2, native_yoke_or_strap_count_verified: true, continuous: false }
    ],
    other_continuous_va: 1200,
    other_noncontinuous_va: 300
  }])[0];
  assert.equal(result.details.required_va, 2340);
  assert.equal(result.details.circuit_capacity_va, 2400);
  assert.equal(result.passed, true);
  const invalid = evaluateReceptacleCircuitLoading({
    rule_id: "bad-load",
    source: nec("220.14(I)"),
    volt_amperes_per_yoke_or_strap: 180,
    continuous_load_multiplier: 1.25
  }, [{
    circuit_id: "bad",
    voltage: Number.POSITIVE_INFINITY,
    phase_count: 1,
    breaker_amps: 20,
    native_membership_verified: true,
    native_ocpd_verified: true,
    native_conductor_verified: true,
    conductor_ampacity_amps: 20,
    conductor_ocpd_compatibility_verified: true,
    receptacles: [{ element_key: "bad-yoke", yoke_or_strap_count: -1, native_yoke_or_strap_count_verified: true, continuous: false }],
    other_continuous_va: -1,
    other_noncontinuous_va: 0
  }])[0];
  assert.equal(invalid.passed, false);
  assert.equal(invalid.failure_classification, "circuit_load_evidence_invalid");
});

test("plumbing services score system reachability and enforce a sourced conventional fixture subtype profile", () => {
  const rules = [
    {
      rule_id: "lavatory-services",
      fixture_class: "lavatory",
      source: IPC,
      required_services: ["domestic_cold_water", "domestic_hot_water", "sanitary", "vented_drainage"] as const,
      prohibited_services: [],
      expected_system_classifications: {
        domestic_cold_water: ["Domestic Cold Water"],
        domestic_hot_water: ["Domestic Hot Water"],
        sanitary: ["Sanitary"],
        vented_drainage: ["Sanitary"]
      },
      required_connection_mode: {
        domestic_cold_water: "direct" as const,
        domestic_hot_water: "direct" as const,
        sanitary: "direct" as const,
        vented_drainage: "network" as const
      }
    },
    {
      rule_id: "tank-water-closet-services",
      fixture_class: "water_closet",
      fixture_subtype: "flush_tank",
      source: PROJECT_PLUMBING,
      required_services: ["domestic_cold_water", "sanitary", "vented_drainage"] as const,
      prohibited_services: ["domestic_hot_water"] as const,
      expected_system_classifications: {
        domestic_cold_water: ["Domestic Cold Water"],
        sanitary: ["Sanitary"],
        vented_drainage: ["Sanitary"]
      },
      required_connection_mode: {
        domestic_cold_water: "direct" as const,
        sanitary: "direct" as const,
        vented_drainage: "network" as const
      },
      connection_sizes: [{ service: "domestic_cold_water" as const, allowed_inches: [0.5], source: PROJECT_PLUMBING }]
    }
  ];
  const results = evaluatePlumbingFixtureServices(rules.map((rule) => ({
    ...rule,
    required_services: [...rule.required_services],
    prohibited_services: [...rule.prohibited_services]
  })), [
    {
      element_key: "lav-1",
      fixture_class: "lavatory",
      services: [
        { service: "domestic_cold_water", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["lav-1", "dcw-1"], system_ids: ["dcw-system"], system_classification: "Domestic Cold Water", connection_size_inches: 0.5, connection_size_native_verified: true },
        { service: "domestic_hot_water", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["lav-1", "dhw-1"], system_ids: ["dhw-system"], system_classification: "Domestic Hot Water", connection_size_inches: 0.5, connection_size_native_verified: true },
        { service: "sanitary", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["lav-1", "san-1"], system_ids: ["san-system"], system_classification: "Sanitary", connection_size_inches: 1.5, connection_size_native_verified: true },
        { service: "vented_drainage", native_reachable: true, native_path_verified: true, direct_connection: false, path_element_keys: ["lav-1", "san-1", "vent-1"], system_ids: ["san-system"], system_classification: "Sanitary" }
      ]
    },
    {
      element_key: "wc-1",
      fixture_class: "water_closet",
      fixture_subtype: "flush_tank",
      services: [
        { service: "domestic_cold_water", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["wc-1", "dcw-2"], system_ids: ["dcw-system"], system_classification: "Domestic Cold Water", connection_size_inches: 0.5, connection_size_native_verified: true },
        { service: "domestic_hot_water", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["wc-1", "dhw-2"], system_ids: ["dhw-system"], system_classification: "Domestic Hot Water", connection_size_inches: 0.5, connection_size_native_verified: true },
        { service: "sanitary", native_reachable: true, native_path_verified: true, direct_connection: true, path_element_keys: ["wc-1", "san-2"], system_ids: ["san-system"], system_classification: "Sanitary", connection_size_inches: 3, connection_size_native_verified: true },
        { service: "vented_drainage", native_reachable: true, native_path_verified: true, direct_connection: false, path_element_keys: ["wc-1", "san-2", "vent-2"], system_ids: ["san-system"], system_classification: "Sanitary" }
      ]
    }
  ]);
  assert.equal(results[0].passed, true);
  assert.equal(results[0].details.vent_checked_by_network_reachability, true);
  assert.equal(results[1].passed, false);
  assert.equal(results[1].details.prohibited_services_present, "domestic_hot_water");
});

test("dataset audit catches answer and source-region leakage plus fake compliance replay", () => {
  const issues = auditBenchmarkDatasetLeakage([
    {
      case_id: "train-1",
      split: "train",
      task_class: "exact_reconstruction",
      source_model_family: "snowdon-electrical",
      source_region_id: "L4-403",
      mutation_family: "bounded_deletion",
      visible_evidence_fingerprint: "same-pdf",
      prompt_template_fingerprint: "same-prompt",
      geometry_origin: "source_model",
      hidden_answer_fingerprint: "same-answer"
    },
    {
      case_id: "eval-1",
      split: "evaluation",
      task_class: "standards_compliance_repair",
      source_model_family: "snowdon-electrical",
      source_region_id: "L4-403",
      mutation_family: "exact_deleted_source_replay",
      visible_evidence_fingerprint: "same-pdf",
      prompt_template_fingerprint: "same-prompt",
      geometry_origin: "source_model",
      hidden_answer_fingerprint: "same-answer"
    }
  ]);
  assert.deepEqual(issues, [
    "answer_fingerprint_leakage:eval-1",
    "source_region_leakage:eval-1",
    "visible_evidence_leakage:eval-1",
    "prompt_template_leakage:eval-1",
    "non_reconstruction_exact_replay:eval-1",
    "non_reconstruction_source_geometry:eval-1",
    "standards_profile_fingerprint_missing:eval-1"
  ]);
});

test("compliance scoring uses evaluator checks and provenance without hidden coordinate matching", () => {
  const contract = {
    task_class: "standards_compliance_repair" as const,
    acceptance_basis: ["engineering_invariants", "system_topology", "drawing_legibility", "scope_safety"] as const,
    allows_multiple_valid_solutions: true,
    requires_exact_element_ids: false,
    requires_exact_coordinates: false,
    standards_context: STANDARDS,
    standards_profile_artifact_sha256: HASH_A,
    requires_evaluator_change_receipt: true,
    requires_evaluator_access_provenance: true
  };
  const score = scoreEngineeringInvariantBenchmark({
    contract: { ...contract, acceptance_basis: [...contract.acceptance_basis] },
    evaluator_checks: [{ check_id: "wall-coverage", passed: true, failure_classification: null, details: { solution: "alternate-valid-layout" } }],
    evaluator_change_receipt: {
      native_diff_readback: true,
      changed_element_keys: ["host:101", "host:102"],
      out_of_scope_changed_element_keys: [],
      receipt_sha256: HASH_B
    },
    evaluator_access_provenance: {
      evaluator_owned: true,
      runner_isolation_verified: true,
      observed_artifact_roles: ["agent_visible_package", "source_pdf", "standards_profile"],
      forbidden_artifact_roles_accessed: [],
      standards_profile_sha256: HASH_A,
      receipt_sha256: HASH_C
    },
    constructability_passed: true,
    drawing_legibility_passed: true
  });
  assert.equal(score.valid_run, true);
  assert.equal(score.passed, true);
  assert.equal(score.score, 100);
});

test("compliance scoring fails closed without evaluator-owned access and scope receipts", () => {
  const score = scoreEngineeringInvariantBenchmark({
    contract: {
      task_class: "standards_compliance_repair",
      acceptance_basis: ["engineering_invariants", "scope_safety"],
      allows_multiple_valid_solutions: true,
      requires_exact_element_ids: false,
      requires_exact_coordinates: false,
      standards_context: STANDARDS,
      standards_profile_artifact_sha256: HASH_A,
      requires_evaluator_change_receipt: true,
      requires_evaluator_access_provenance: true
    },
    evaluator_checks: [{ check_id: "rule", passed: true, failure_classification: null, details: {} }],
    evaluator_change_receipt: null,
    evaluator_access_provenance: null,
    constructability_passed: true,
    drawing_legibility_passed: true
  });
  assert.equal(score.valid_run, false);
  assert.ok(score.invalid_reasons.includes("evaluator_change_receipt_invalid"));
  assert.ok(score.invalid_reasons.includes("evaluator_access_provenance_invalid"));
});
