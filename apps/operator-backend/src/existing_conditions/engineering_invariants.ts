export type ExistingConditionsBenchmarkTaskClass =
  | "exact_reconstruction"
  | "standards_compliance_repair"
  | "generative_layout";

export type EngineeringSourceReference = {
  authority: string;
  title: string;
  edition: string;
  section: string;
  subsection?: string | null;
  table?: string | null;
  url: string;
  sha256: string;
  local_amendment_id?: string | null;
};

export type EngineeringStandardsContext = {
  profile_id: string;
  profile_revision: string;
  jurisdiction: string;
  authority_having_jurisdiction: string;
  code_family: string;
  edition: string;
  effective_date: string;
  occupancy_or_use_classification: string;
  local_amendments: Array<{
    id: string;
    revision: string;
    source_url: string;
    sha256: string;
    affected_sections: string[];
  }>;
  project_criteria: Array<{
    id: string;
    revision: string;
    source_url: string;
    sha256: string;
  }>;
  conflict_precedence: string[];
  sources: EngineeringSourceReference[];
};

export type EngineeringAcceptanceBasis =
  | "hidden_truth_geometry"
  | "engineering_invariants"
  | "system_topology"
  | "constructability"
  | "drawing_legibility"
  | "scope_safety";

export type EngineeringBenchmarkTaskContract = {
  task_class: ExistingConditionsBenchmarkTaskClass;
  acceptance_basis: EngineeringAcceptanceBasis[];
  allows_multiple_valid_solutions: boolean;
  requires_exact_element_ids: boolean;
  requires_exact_coordinates: boolean;
  hidden_truth_fingerprint?: string | null;
  standards_context?: EngineeringStandardsContext | null;
  standards_profile_artifact_sha256?: string | null;
  requires_evaluator_change_receipt: boolean;
  requires_evaluator_access_provenance: boolean;
};

export type EngineeringCheckResult = {
  check_id: string;
  passed: boolean;
  failure_classification: string | null;
  details: Record<string, string | number | boolean | null>;
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map(text).filter(Boolean))];
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function validSha256(value: unknown): boolean {
  return /^[a-f0-9]{64}$/i.test(text(value));
}

export function validateEngineeringStandardsContext(context: EngineeringStandardsContext | null | undefined): string[] {
  if (!context) return ["standards_context_missing"];
  const errors: string[] = [];
  if (!text(context.profile_id)) errors.push("standards_profile_id_missing");
  if (!text(context.profile_revision)) errors.push("standards_profile_revision_missing");
  if (!text(context.jurisdiction)) errors.push("jurisdiction_missing");
  if (!text(context.authority_having_jurisdiction)) errors.push("authority_having_jurisdiction_missing");
  if (!text(context.code_family)) errors.push("code_family_missing");
  if (!text(context.edition)) errors.push("code_edition_missing");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text(context.effective_date))) errors.push("effective_date_invalid");
  if (!text(context.occupancy_or_use_classification)) errors.push("occupancy_or_use_classification_missing");
  if (!Array.isArray(context.local_amendments)) errors.push("local_amendments_missing");
  if (!Array.isArray(context.project_criteria)) errors.push("project_criteria_missing");
  if (!Array.isArray(context.conflict_precedence) || context.conflict_precedence.length === 0) errors.push("conflict_precedence_missing");
  if (!Array.isArray(context.sources) || context.sources.length === 0) errors.push("source_references_missing");
  for (const [index, source] of (context.sources ?? []).entries()) {
    if (!text(source.authority) || !text(source.title) || !text(source.edition) || !text(source.section)
      || !text(source.url) || !validSha256(source.sha256)) {
      errors.push(`source_reference_incomplete:${index}`);
    }
  }
  for (const [index, amendment] of (context.local_amendments ?? []).entries()) {
    if (!text(amendment.id) || !text(amendment.revision) || !text(amendment.source_url)
      || !validSha256(amendment.sha256) || !Array.isArray(amendment.affected_sections)) {
      errors.push(`local_amendment_incomplete:${index}`);
    }
  }
  for (const [index, criterion] of (context.project_criteria ?? []).entries()) {
    if (!text(criterion.id) || !text(criterion.revision) || !text(criterion.source_url) || !validSha256(criterion.sha256)) {
      errors.push(`project_criterion_incomplete:${index}`);
    }
  }
  return unique(errors);
}

export function validateEngineeringBenchmarkTaskContract(contract: EngineeringBenchmarkTaskContract): string[] {
  const errors: string[] = [];
  const basis = new Set(contract.acceptance_basis ?? []);
  if (contract.task_class === "exact_reconstruction") {
    if (!text(contract.hidden_truth_fingerprint)) errors.push("hidden_truth_fingerprint_missing");
  } else {
    errors.push(...validateEngineeringStandardsContext(contract.standards_context));
    if (!validSha256(contract.standards_profile_artifact_sha256)) errors.push("standards_profile_artifact_sha256_invalid");
    if (!basis.has("engineering_invariants")) errors.push("engineering_invariants_acceptance_missing");
    if (contract.requires_exact_element_ids) errors.push("non_reconstruction_requires_exact_element_ids");
    if (contract.requires_exact_coordinates && !contract.allows_multiple_valid_solutions) {
      errors.push("single_coordinate_answer_overfit_risk");
    }
    if (!contract.requires_evaluator_change_receipt) errors.push("evaluator_change_receipt_must_be_required");
    if (!contract.requires_evaluator_access_provenance) errors.push("evaluator_access_provenance_must_be_required");
  }
  if (contract.task_class === "generative_layout" && !contract.allows_multiple_valid_solutions) {
    errors.push("generative_layout_must_allow_multiple_valid_solutions");
  }
  if (!basis.has("scope_safety")) errors.push("scope_safety_acceptance_missing");
  return unique(errors);
}

export type GfciProtectionMethod =
  | "integral_device"
  | "upstream_device"
  | "branch_breaker"
  | "documented_equivalent";

export type GfciProtectionRule = {
  rule_id: string;
  source: EngineeringSourceReference;
  sink_distance_limit_ft: number;
  distance_measurement: string;
  applicable_location_classes: string[];
  applicable_voltage_to_ground_max: number;
  applicable_receptacle_amp_max: number;
  allowed_exception_ids: string[];
};

export type GfciReceptacleEvidence = {
  element_key: string;
  location_classes: string[];
  distance_to_sink_ft: number | null;
  voltage_to_ground: number;
  receptacle_amps: number;
  approved_exception_id?: string | null;
  approved_exception_evidence_sha256?: string | null;
  protection?: {
    method: GfciProtectionMethod;
    protection_device_key: string;
    path_element_keys: string[];
    native_path_verified: boolean;
    protected_circuit_id?: string | null;
    receptacle_circuit_id?: string | null;
    documented_equivalent_sha256?: string | null;
  } | null;
};

export function evaluateGfciProtection(
  rule: GfciProtectionRule,
  receptacles: GfciReceptacleEvidence[]
): EngineeringCheckResult[] {
  const locationClasses = new Set(rule.applicable_location_classes.map((value) => text(value).toLowerCase()));
  const allowedExceptions = new Set(rule.allowed_exception_ids.map(text));
  return receptacles.map((receptacle) => {
    const inApplicableLocation = receptacle.location_classes.some((value) => locationClasses.has(text(value).toLowerCase()));
    const distance = finite(receptacle.distance_to_sink_ft);
    const invalidApplicabilityEvidence = !Number.isFinite(rule.sink_distance_limit_ft)
      || rule.sink_distance_limit_ft < 0
      || !Number.isFinite(rule.applicable_voltage_to_ground_max)
      || rule.applicable_voltage_to_ground_max < 0
      || !Number.isFinite(rule.applicable_receptacle_amp_max)
      || rule.applicable_receptacle_amp_max < 0
      || !Number.isFinite(receptacle.voltage_to_ground)
      || receptacle.voltage_to_ground < 0
      || !Number.isFinite(receptacle.receptacle_amps)
      || receptacle.receptacle_amps < 0
      || (inApplicableLocation && distance === null)
      || (distance !== null && distance < 0);
    const applies = !invalidApplicabilityEvidence && inApplicableLocation
      && distance !== null
      && distance <= rule.sink_distance_limit_ft
      && receptacle.voltage_to_ground <= rule.applicable_voltage_to_ground_max
      && receptacle.receptacle_amps <= rule.applicable_receptacle_amp_max;
    const exceptionAccepted = applies
      && Boolean(text(receptacle.approved_exception_id))
      && allowedExceptions.has(text(receptacle.approved_exception_id))
      && validSha256(receptacle.approved_exception_evidence_sha256);
    const protection = receptacle.protection;
    const circuitMatches = protection?.method === "integral_device"
      || (Boolean(text(protection?.protected_circuit_id))
        && text(protection?.protected_circuit_id) === text(protection?.receptacle_circuit_id));
    const pathKeys = unique(protection?.path_element_keys ?? []);
    const subjectInPath = pathKeys.includes(receptacle.element_key);
    const deviceInPath = Boolean(text(protection?.protection_device_key)) && pathKeys.includes(text(protection?.protection_device_key));
    const methodEvidenceValid = protection?.method !== "integral_device"
      || text(protection.protection_device_key) === receptacle.element_key;
    const equivalentEvidenceValid = protection?.method !== "documented_equivalent"
      || validSha256(protection.documented_equivalent_sha256);
    const protectedByVerifiedPath = Boolean(
      protection?.native_path_verified
      && circuitMatches
      && subjectInPath
      && deviceInPath
      && methodEvidenceValid
      && equivalentEvidenceValid
    );
    const passed = !invalidApplicabilityEvidence && (!applies || exceptionAccepted || protectedByVerifiedPath);
    return {
      check_id: `${rule.rule_id}:${receptacle.element_key}`,
      passed,
      failure_classification: passed
        ? null
        : invalidApplicabilityEvidence ? "gfci_applicability_evidence_invalid" : "gfci_protection_missing_or_unverified",
      details: {
        applies,
        exception_accepted: exceptionAccepted,
        protection_method: protection?.method ?? null,
        native_path_verified: protection?.native_path_verified ?? false,
        protection_path_length: pathKeys.length,
        distance_to_sink_ft: distance,
        distance_measurement: rule.distance_measurement
      }
    };
  });
}

export type DwellingWallSpaceRule = {
  rule_id: string;
  source: EngineeringSourceReference;
  minimum_qualifying_wall_width_ft: number;
  maximum_point_distance_to_receptacle_ft: number;
  maximum_floor_receptacle_distance_from_wall_ft: number;
  no_qualifying_segments: "pass_not_applicable" | "fail_invalid_fixture";
};

export type DwellingWallSegment = {
  segment_id: string;
  length_ft: number;
  interrupted: boolean;
};

export type DwellingCoverageReceptacle = {
  element_key: string;
  segment_id: string;
  offset_along_segment_ft: number;
  counts_for_coverage: boolean;
  floor_distance_from_wall_ft?: number | null;
};

export function evaluateDwellingWallCoverage(
  rule: DwellingWallSpaceRule,
  segments: DwellingWallSegment[],
  receptacles: DwellingCoverageReceptacle[]
): EngineeringCheckResult[] {
  const invalidRule = !Number.isFinite(rule.minimum_qualifying_wall_width_ft)
    || rule.minimum_qualifying_wall_width_ft < 0
    || !Number.isFinite(rule.maximum_point_distance_to_receptacle_ft)
    || rule.maximum_point_distance_to_receptacle_ft <= 0
    || !Number.isFinite(rule.maximum_floor_receptacle_distance_from_wall_ft)
    || rule.maximum_floor_receptacle_distance_from_wall_ft < 0;
  const invalidSegments = segments.some((segment) => !text(segment.segment_id)
    || !Number.isFinite(segment.length_ft)
    || segment.length_ft < 0);
  if (invalidRule || invalidSegments) {
    return [{
      check_id: `${rule.rule_id}:scope`,
      passed: false,
      failure_classification: "dwelling_wall_space_evidence_invalid",
      details: { invalid_rule: invalidRule, invalid_segments: invalidSegments }
    }];
  }
  const qualifyingSegments = segments
    .filter((segment) => !segment.interrupted && segment.length_ft >= rule.minimum_qualifying_wall_width_ft);
  if (qualifyingSegments.length === 0) {
    const passed = rule.no_qualifying_segments === "pass_not_applicable";
    return [{
      check_id: `${rule.rule_id}:scope`,
      passed,
      failure_classification: passed ? null : "dwelling_wall_space_scope_has_no_qualifying_segments",
      details: { qualifying_segment_count: 0, explicitly_not_applicable: passed }
    }];
  }
  return qualifyingSegments
    .map((segment) => {
      const segmentReceptacles = receptacles
        .filter((receptacle) => receptacle.segment_id === segment.segment_id && receptacle.counts_for_coverage);
      const duplicateElementKeys = unique(segmentReceptacles.map((item) => item.element_key)).length !== segmentReceptacles.length;
      const invalidEvidence = duplicateElementKeys || segmentReceptacles.some((receptacle) =>
        !Number.isFinite(receptacle.offset_along_segment_ft)
        || receptacle.offset_along_segment_ft < 0
        || receptacle.offset_along_segment_ft > segment.length_ft
        || (receptacle.floor_distance_from_wall_ft != null
          && (!Number.isFinite(receptacle.floor_distance_from_wall_ft) || receptacle.floor_distance_from_wall_ft < 0)));
      const intervals = segmentReceptacles
        .filter((receptacle) => receptacle.offset_along_segment_ft >= 0 && receptacle.offset_along_segment_ft <= segment.length_ft)
        .filter((receptacle) => receptacle.floor_distance_from_wall_ft == null
          || receptacle.floor_distance_from_wall_ft <= rule.maximum_floor_receptacle_distance_from_wall_ft)
        .map((receptacle) => [
          Math.max(0, receptacle.offset_along_segment_ft - rule.maximum_point_distance_to_receptacle_ft),
          Math.min(segment.length_ft, receptacle.offset_along_segment_ft + rule.maximum_point_distance_to_receptacle_ft)
        ] as const)
        .sort((a, b) => a[0] - b[0]);
      let coveredThrough = 0;
      let maximumUncoveredGap = 0;
      for (const [start, end] of intervals) {
        if (start > coveredThrough) maximumUncoveredGap = Math.max(maximumUncoveredGap, start - coveredThrough);
        coveredThrough = Math.max(coveredThrough, end);
      }
      maximumUncoveredGap = Math.max(maximumUncoveredGap, segment.length_ft - coveredThrough);
      const passed = !invalidEvidence && maximumUncoveredGap <= 1e-9;
      return {
        check_id: `${rule.rule_id}:${segment.segment_id}`,
        passed,
        failure_classification: passed
          ? null
          : invalidEvidence ? "dwelling_wall_space_evidence_invalid" : "dwelling_wall_space_coverage_gap",
        details: {
          segment_length_ft: segment.length_ft,
          qualifying_receptacle_count: intervals.length,
          maximum_uncovered_gap_ft: maximumUncoveredGap,
          duplicate_element_keys: duplicateElementKeys,
          invalid_evidence: invalidEvidence
        }
      };
    });
}

export type ReceptacleCircuitLoadRule = {
  rule_id: string;
  source: EngineeringSourceReference;
  applicable_load_scope: "non_dwelling_general_use" | "dwelling_profile" | "project_specific";
  capacity_calculation: "single_phase_va" | "three_phase_line_to_line_va";
  volt_amperes_per_yoke_or_strap: number;
  continuous_load_multiplier: number;
};

export type ReceptacleCircuitLoad = {
  element_key: string;
  yoke_or_strap_count: number;
  yoke_or_strap_count_profile_verified: boolean;
  continuous: boolean;
  continuous_classification_profile_verified: boolean;
};

export type CircuitCapacityEvidence = {
  circuit_id: string;
  load_scope: "non_dwelling_general_use" | "dwelling_profile" | "project_specific";
  voltage: number;
  phase_count: 1 | 3;
  breaker_amps: number;
  native_membership_verified: boolean;
  native_ocpd_verified: boolean;
  native_conductor_verified: boolean;
  conductor_ampacity_amps: number;
  conductor_ocpd_compatibility_verified: boolean;
  receptacles: ReceptacleCircuitLoad[];
  other_continuous_va: number;
  other_noncontinuous_va: number;
  other_loads_native_verified: boolean;
  listed_for_100_percent_continuous_operation?: boolean;
  continuous_rating_evidence_sha256?: string | null;
  continuous_rating_native_verified?: boolean;
};

export function evaluateReceptacleCircuitLoading(
  rule: ReceptacleCircuitLoadRule,
  circuits: CircuitCapacityEvidence[],
  scope?: {
    receptacle_element_keys: string[];
    native_scope_inventory_verified: boolean;
  }
): EngineeringCheckResult[] {
  const duplicateCircuitIds = unique(circuits.map((circuit) => circuit.circuit_id)).length !== circuits.length;
  const assignedKeys = circuits.flatMap((circuit) => circuit.receptacles.map((receptacle) => text(receptacle.element_key)));
  const duplicateAssignedKeys = unique(assignedKeys).length !== assignedKeys.length;
  const results: EngineeringCheckResult[] = circuits.map((circuit) => {
    const phaseMatchesCalculation = (circuit.phase_count === 1 && rule.capacity_calculation === "single_phase_va")
      || (circuit.phase_count === 3 && rule.capacity_calculation === "three_phase_line_to_line_va");
    const invalidCircuitMetadata = !Number.isFinite(rule.volt_amperes_per_yoke_or_strap)
      || rule.volt_amperes_per_yoke_or_strap <= 0
      || !Number.isFinite(rule.continuous_load_multiplier)
      || rule.continuous_load_multiplier < 1
      || circuit.load_scope !== rule.applicable_load_scope
      || !phaseMatchesCalculation
      || duplicateCircuitIds
      || !Number.isFinite(circuit.voltage)
      || circuit.voltage <= 0
      || !Number.isFinite(circuit.breaker_amps)
      || circuit.breaker_amps <= 0
      || !Number.isFinite(circuit.conductor_ampacity_amps)
      || circuit.conductor_ampacity_amps <= 0
      || ![1, 3].includes(circuit.phase_count)
      || !Number.isFinite(circuit.other_continuous_va)
      || circuit.other_continuous_va < 0
      || !Number.isFinite(circuit.other_noncontinuous_va)
      || circuit.other_noncontinuous_va < 0
      || !circuit.other_loads_native_verified;
    const invalidReceptacleMetadata = circuit.receptacles.some((receptacle) =>
      !text(receptacle.element_key)
      || !Number.isInteger(receptacle.yoke_or_strap_count)
      || receptacle.yoke_or_strap_count <= 0
      || !receptacle.yoke_or_strap_count_profile_verified
      || !receptacle.continuous_classification_profile_verified)
      || duplicateAssignedKeys;
    let continuousVa = circuit.other_continuous_va;
    let noncontinuousVa = circuit.other_noncontinuous_va;
    for (const receptacle of circuit.receptacles) {
      const va = receptacle.yoke_or_strap_count * rule.volt_amperes_per_yoke_or_strap;
      if (receptacle.continuous) continuousVa += va;
      else noncontinuousVa += va;
    }
    const verified100PercentRating = Boolean(
      circuit.listed_for_100_percent_continuous_operation
      && circuit.continuous_rating_native_verified
      && validSha256(circuit.continuous_rating_evidence_sha256)
    );
    const multiplier = verified100PercentRating ? 1 : rule.continuous_load_multiplier;
    const requiredVa = noncontinuousVa + continuousVa * multiplier;
    const capacityVa = circuit.voltage * circuit.breaker_amps
      * (rule.capacity_calculation === "three_phase_line_to_line_va" ? Math.sqrt(3) : 1);
    const nativeBasisVerified = circuit.native_membership_verified
      && circuit.native_ocpd_verified
      && circuit.native_conductor_verified;
    const passed = !invalidCircuitMetadata
      && !invalidReceptacleMetadata
      && nativeBasisVerified
      && circuit.conductor_ocpd_compatibility_verified
      && requiredVa <= capacityVa + 1e-9;
    const failure = invalidCircuitMetadata || invalidReceptacleMetadata
      ? "circuit_load_evidence_invalid"
      : !nativeBasisVerified ? "circuit_basis_unverified"
        : !circuit.conductor_ocpd_compatibility_verified ? "circuit_conductor_ocpd_compatibility_unverified"
          : "circuit_calculated_load_exceeds_capacity";
    return {
      check_id: `${rule.rule_id}:${circuit.circuit_id}`,
      passed,
      failure_classification: passed ? null : failure,
      details: {
        continuous_va: continuousVa,
        noncontinuous_va: noncontinuousVa,
        continuous_multiplier: multiplier,
        load_scope: circuit.load_scope,
        capacity_calculation: rule.capacity_calculation,
        required_va: requiredVa,
        circuit_capacity_va: capacityVa,
        native_membership_verified: circuit.native_membership_verified,
        native_ocpd_verified: circuit.native_ocpd_verified,
        native_conductor_verified: circuit.native_conductor_verified,
        conductor_ampacity_amps: circuit.conductor_ampacity_amps,
        conductor_ocpd_compatibility_verified: circuit.conductor_ocpd_compatibility_verified,
        other_loads_native_verified: circuit.other_loads_native_verified,
        verified_100_percent_rating: verified100PercentRating
      }
    };
  });
  if (scope) {
    const scopedKeys = scope.receptacle_element_keys.map(text).filter(Boolean);
    const uniqueScopedKeys = unique(scopedKeys);
    const uniqueAssignedKeys = unique(assignedKeys);
    const duplicateScopedKeys = uniqueScopedKeys.length !== scopedKeys.length;
    const missing = uniqueScopedKeys.filter((key) => !uniqueAssignedKeys.includes(key));
    const unexpected = uniqueAssignedKeys.filter((key) => !uniqueScopedKeys.includes(key));
    const passed = scope.native_scope_inventory_verified
      && !duplicateScopedKeys
      && !duplicateAssignedKeys
      && missing.length === 0
      && unexpected.length === 0;
    results.unshift({
      check_id: `${rule.rule_id}:scope`,
      passed,
      failure_classification: passed ? null : "circuit_scope_membership_incomplete_or_duplicated",
      details: {
        native_scope_inventory_verified: scope.native_scope_inventory_verified,
        scoped_receptacle_count: uniqueScopedKeys.length,
        assigned_receptacle_count: uniqueAssignedKeys.length,
        duplicate_scope_element_keys: duplicateScopedKeys,
        duplicate_circuit_membership: duplicateAssignedKeys,
        missing_receptacle_element_keys: missing.join(",") || null,
        unexpected_receptacle_element_keys: unexpected.join(",") || null
      }
    });
  }
  return results;
}

export type PlumbingServiceKind = "domestic_cold_water" | "domestic_hot_water" | "sanitary" | "vented_drainage";

export type PlumbingFixtureServiceRule = {
  rule_id: string;
  fixture_class: string;
  fixture_subtype?: string | null;
  source: EngineeringSourceReference;
  required_services: PlumbingServiceKind[];
  prohibited_services: PlumbingServiceKind[];
  expected_system_classifications: Partial<Record<PlumbingServiceKind, string[]>>;
  required_connection_mode: Partial<Record<PlumbingServiceKind, "direct" | "network">>;
  connection_sizes?: Array<{
    service: PlumbingServiceKind;
    minimum_inches?: number | null;
    maximum_inches?: number | null;
    allowed_inches?: number[];
    source: EngineeringSourceReference;
  }>;
};

export type PlumbingFixtureEvidence = {
  element_key: string;
  fixture_class: string;
  fixture_subtype?: string | null;
  services: Array<{
    service: PlumbingServiceKind;
    native_reachable: boolean;
    native_path_verified: boolean;
    direct_connection: boolean;
    path_element_keys: string[];
    system_ids: string[];
    system_classification: string;
    connection_size_inches?: number | null;
    connection_size_native_verified?: boolean;
  }>;
};

export function evaluatePlumbingFixtureServices(
  rules: PlumbingFixtureServiceRule[],
  fixtures: PlumbingFixtureEvidence[]
): EngineeringCheckResult[] {
  const results: EngineeringCheckResult[] = [];
  for (const fixture of fixtures) {
    const fixtureClass = text(fixture.fixture_class).toLowerCase();
    const fixtureSubtype = text(fixture.fixture_subtype).toLowerCase();
    const classRules = rules.filter((candidate) => text(candidate.fixture_class).toLowerCase() === fixtureClass);
    const exactRules = classRules.filter((candidate) => text(candidate.fixture_subtype).toLowerCase() === fixtureSubtype && fixtureSubtype.length > 0);
    const genericRules = classRules.filter((candidate) => !text(candidate.fixture_subtype));
    const matchingRules = exactRules.length > 0 ? exactRules : genericRules;
    const rule = matchingRules.length === 1 ? matchingRules[0] : null;
    if (!rule) {
      results.push({
        check_id: `plumbing_service_profile:${fixture.element_key}`,
        passed: false,
        failure_classification: matchingRules.length > 1
          ? "plumbing_fixture_service_profile_ambiguous"
          : "plumbing_fixture_service_profile_missing",
        details: {
          fixture_class: fixture.fixture_class,
          fixture_subtype: fixture.fixture_subtype ?? null,
          exact_profile_count: exactRules.length,
          generic_profile_count: genericRules.length
        }
      });
      continue;
    }
    const serviceNames = fixture.services.map((service) => service.service);
    const duplicateServices = unique(serviceNames).length !== serviceNames.length;
    const malformedServices = fixture.services.filter((service) => {
      const path = unique(service.path_element_keys);
      const fixtureInPath = path.includes(fixture.element_key);
      const directPathValid = !service.direct_connection || (path[0] === fixture.element_key && path.length >= 2);
      return service.native_reachable && (!service.native_path_verified
        || !fixtureInPath
        || !directPathValid
        || unique(service.system_ids).length === 0
        || !text(service.system_classification));
    });
    const provenServices = fixture.services.filter((service) => service.native_reachable
      && service.native_path_verified
      && unique(service.path_element_keys).includes(fixture.element_key)
      && (!service.direct_connection || (unique(service.path_element_keys)[0] === fixture.element_key
        && unique(service.path_element_keys).length >= 2))
      && unique(service.system_ids).length > 0
      && text(service.system_classification));
    const reachable = new Set(provenServices.map((service) => service.service));
    const missing = rule.required_services.filter((service) => !reachable.has(service));
    const prohibited = rule.prohibited_services.filter((service) => fixture.services.some((candidate) =>
      candidate.service === service && candidate.native_reachable));
    const topologyFailures: string[] = [];
    if (duplicateServices) topologyFailures.push("duplicate_service_evidence");
    if (malformedServices.length > 0) topologyFailures.push(`malformed_native_paths:${unique(malformedServices.map((service) => service.service)).join("|")}`);
    for (const service of rule.required_services) {
      const evidence = provenServices.find((candidate) => candidate.service === service);
      if (!evidence) continue;
      const expectedClassifications = (rule.expected_system_classifications[service] ?? []).map((value) => text(value).toLowerCase());
      if (expectedClassifications.length > 0 && !expectedClassifications.includes(text(evidence.system_classification).toLowerCase())) {
        topologyFailures.push(`${service}:wrong_system_classification`);
      }
      if (rule.required_connection_mode[service] === "direct" && !evidence.direct_connection) {
        topologyFailures.push(`${service}:direct_connection_required`);
      }
      if (rule.required_connection_mode[service] === "network" && evidence.direct_connection) {
        topologyFailures.push(`${service}:network_reachability_required`);
      }
    }
    const vent = provenServices.find((candidate) => candidate.service === "vented_drainage");
    const sanitary = provenServices.find((candidate) => candidate.service === "sanitary");
    if (rule.required_services.includes("vented_drainage") && vent) {
      const ventPath = unique(vent.path_element_keys);
      const sanitaryPath = new Set(unique(sanitary?.path_element_keys ?? []));
      const distinctVentContinuation = ventPath.length >= 3
        && ventPath.some((key) => key !== fixture.element_key && !sanitaryPath.has(key));
      if (!distinctVentContinuation) topologyFailures.push("vented_drainage:distinct_network_continuation_unverified");
    }
    const sizeFailures: string[] = [];
    for (const sizeRule of rule.connection_sizes ?? []) {
      const evidence = provenServices.find((service) => service.service === sizeRule.service);
      const size = finite(evidence?.connection_size_inches);
      if (size === null || !evidence?.connection_size_native_verified) {
        sizeFailures.push(`${sizeRule.service}:missing`);
        continue;
      }
      if (sizeRule.minimum_inches != null && size < sizeRule.minimum_inches - 1e-9) sizeFailures.push(`${sizeRule.service}:below_minimum`);
      if (sizeRule.maximum_inches != null && size > sizeRule.maximum_inches + 1e-9) sizeFailures.push(`${sizeRule.service}:above_maximum`);
      if (sizeRule.allowed_inches?.length && !sizeRule.allowed_inches.some((allowed) => Math.abs(allowed - size) <= 1e-9)) {
        sizeFailures.push(`${sizeRule.service}:not_allowed`);
      }
    }
    const passed = missing.length === 0 && prohibited.length === 0 && topologyFailures.length === 0 && sizeFailures.length === 0;
    results.push({
      check_id: `${rule.rule_id}:${fixture.element_key}`,
      passed,
      failure_classification: passed ? null : "plumbing_fixture_service_invariant_failed",
      details: {
        missing_services: missing.join(",") || null,
        prohibited_services_present: prohibited.join(",") || null,
        topology_failures: topologyFailures.join(",") || null,
        size_failures: sizeFailures.join(",") || null,
        vent_checked_by_network_reachability: rule.required_services.includes("vented_drainage")
      }
    });
  }
  return results;
}

export type BenchmarkDatasetCase = {
  case_id: string;
  split: "train" | "development" | "evaluation";
  task_class: ExistingConditionsBenchmarkTaskClass;
  source_model_family: string;
  source_region_id: string;
  visible_evidence_fingerprint: string;
  prompt_template_fingerprint: string;
  mutation_family: string;
  geometry_origin: "source_model" | "parametric_mutation" | "independently_generated";
  standards_profile_sha256?: string | null;
  hidden_answer_fingerprint?: string | null;
};

export type BenchmarkLeakagePolicy = {
  require_model_family_holdout: boolean;
  require_region_holdout: boolean;
  require_visible_evidence_holdout: boolean;
  require_prompt_template_holdout: boolean;
  require_mutation_family_holdout: boolean;
};

export const DEFAULT_BENCHMARK_LEAKAGE_POLICY: BenchmarkLeakagePolicy = {
  require_model_family_holdout: false,
  require_region_holdout: true,
  require_visible_evidence_holdout: true,
  require_prompt_template_holdout: true,
  require_mutation_family_holdout: true
};

export function auditBenchmarkDatasetLeakage(
  cases: BenchmarkDatasetCase[],
  policy: BenchmarkLeakagePolicy = DEFAULT_BENCHMARK_LEAKAGE_POLICY
): string[] {
  const issues: string[] = [];
  const training = cases.filter((item) => item.split !== "evaluation");
  for (const evaluation of cases.filter((item) => item.split === "evaluation")) {
    if (evaluation.hidden_answer_fingerprint && training.some((item) => item.hidden_answer_fingerprint === evaluation.hidden_answer_fingerprint)) {
      issues.push(`answer_fingerprint_leakage:${evaluation.case_id}`);
    }
    if (policy.require_model_family_holdout && training.some((item) => item.source_model_family === evaluation.source_model_family)) {
      issues.push(`source_model_family_leakage:${evaluation.case_id}`);
    }
    if (policy.require_region_holdout && training.some((item) => item.source_model_family === evaluation.source_model_family && item.source_region_id === evaluation.source_region_id)) {
      issues.push(`source_region_leakage:${evaluation.case_id}`);
    }
    if (policy.require_visible_evidence_holdout && training.some((item) => item.visible_evidence_fingerprint === evaluation.visible_evidence_fingerprint)) {
      issues.push(`visible_evidence_leakage:${evaluation.case_id}`);
    }
    if (policy.require_prompt_template_holdout && training.some((item) => item.prompt_template_fingerprint === evaluation.prompt_template_fingerprint)) {
      issues.push(`prompt_template_leakage:${evaluation.case_id}`);
    }
    if (policy.require_mutation_family_holdout && training.some((item) => item.mutation_family === evaluation.mutation_family)) {
      issues.push(`mutation_family_leakage:${evaluation.case_id}`);
    }
    if (evaluation.task_class !== "exact_reconstruction" && evaluation.mutation_family === "exact_deleted_source_replay") {
      issues.push(`non_reconstruction_exact_replay:${evaluation.case_id}`);
    }
    if (evaluation.task_class !== "exact_reconstruction" && evaluation.geometry_origin === "source_model") {
      issues.push(`non_reconstruction_source_geometry:${evaluation.case_id}`);
    }
    if (evaluation.task_class !== "exact_reconstruction" && !validSha256(evaluation.standards_profile_sha256)) {
      issues.push(`standards_profile_fingerprint_missing:${evaluation.case_id}`);
    }
  }
  return unique(issues);
}

export type EvaluatorOwnedAccessProvenance = {
  evaluator_owned: true;
  runner_isolation_verified: boolean;
  observed_artifact_roles: string[];
  forbidden_artifact_roles_accessed: string[];
  standards_profile_sha256?: string | null;
  receipt_sha256: string;
};

export type EvaluatorOwnedChangeReceipt = {
  native_diff_readback: true;
  changed_element_keys: string[];
  out_of_scope_changed_element_keys: string[];
  receipt_sha256: string;
};

export type EngineeringInvariantBenchmarkScore = {
  schema_version: 1;
  task_class: "standards_compliance_repair" | "generative_layout";
  valid_run: boolean;
  passed: boolean;
  score: number;
  invalid_reasons: string[];
  failure_classifications: string[];
  metrics: {
    engineering_invariants: number;
    scope_safety: number;
    access_provenance: number;
    constructability: number;
    drawing_legibility: number;
  };
  check_results: EngineeringCheckResult[];
};

export function scoreEngineeringInvariantBenchmark(input: {
  contract: EngineeringBenchmarkTaskContract;
  evaluator_checks: EngineeringCheckResult[];
  evaluator_change_receipt: EvaluatorOwnedChangeReceipt | null;
  evaluator_access_provenance: EvaluatorOwnedAccessProvenance | null;
  constructability_passed: boolean;
  drawing_legibility_passed: boolean;
}): EngineeringInvariantBenchmarkScore {
  if (input.contract.task_class === "exact_reconstruction") {
    throw new Error("engineering_invariant_scorer_does_not_accept_exact_reconstruction");
  }
  const invalidReasons = validateEngineeringBenchmarkTaskContract(input.contract);
  const checkIds = input.evaluator_checks.map((check) => text(check.check_id));
  if (input.evaluator_checks.length === 0) invalidReasons.push("evaluator_checks_missing");
  if (checkIds.some((id) => !id) || unique(checkIds).length !== checkIds.length) invalidReasons.push("evaluator_check_ids_invalid");

  const changeReceipt = input.evaluator_change_receipt;
  if (!changeReceipt?.native_diff_readback || !validSha256(changeReceipt?.receipt_sha256)) {
    invalidReasons.push("evaluator_change_receipt_invalid");
  }
  const outOfScope = unique(changeReceipt?.out_of_scope_changed_element_keys ?? []);

  const access = input.evaluator_access_provenance;
  if (!access?.evaluator_owned || !access.runner_isolation_verified || !validSha256(access.receipt_sha256)) {
    invalidReasons.push("evaluator_access_provenance_invalid");
  }
  if (unique(access?.forbidden_artifact_roles_accessed ?? []).length > 0) {
    invalidReasons.push("forbidden_artifact_access_observed");
  }
  if (access && text(access.standards_profile_sha256) !== text(input.contract.standards_profile_artifact_sha256)) {
    invalidReasons.push("standards_profile_hash_mismatch");
  }

  const invariantMetric = input.evaluator_checks.length === 0
    ? 0
    : input.evaluator_checks.filter((check) => check.passed).length / input.evaluator_checks.length;
  const scopeMetric = changeReceipt?.native_diff_readback && outOfScope.length === 0 ? 1 : 0;
  const accessMetric = access?.evaluator_owned
    && access.runner_isolation_verified
    && unique(access.forbidden_artifact_roles_accessed).length === 0 ? 1 : 0;
  const constructabilityMetric = input.constructability_passed ? 1 : 0;
  const drawingMetric = input.drawing_legibility_passed ? 1 : 0;
  const score = Math.round((
    invariantMetric * 70
    + scopeMetric * 10
    + accessMetric * 10
    + constructabilityMetric * 5
    + drawingMetric * 5
  ) * 1000) / 1000;
  const failureClassifications = unique([
    ...input.evaluator_checks.filter((check) => !check.passed).map((check) => check.failure_classification ?? "engineering_invariant_failed"),
    ...(outOfScope.length > 0 ? ["out_of_scope_model_change"] : []),
    ...(!input.constructability_passed ? ["constructability_failed"] : []),
    ...(!input.drawing_legibility_passed ? ["drawing_legibility_failed"] : [])
  ]);
  const validRun = unique(invalidReasons).length === 0;
  const passed = validRun
    && invariantMetric === 1
    && scopeMetric === 1
    && accessMetric === 1
    && constructabilityMetric === 1
    && drawingMetric === 1;
  return {
    schema_version: 1,
    task_class: input.contract.task_class,
    valid_run: validRun,
    passed,
    score,
    invalid_reasons: unique(invalidReasons),
    failure_classifications: failureClassifications,
    metrics: {
      engineering_invariants: invariantMetric,
      scope_safety: scopeMetric,
      access_provenance: accessMetric,
      constructability: constructabilityMetric,
      drawing_legibility: drawingMetric
    },
    check_results: input.evaluator_checks
  };
}
