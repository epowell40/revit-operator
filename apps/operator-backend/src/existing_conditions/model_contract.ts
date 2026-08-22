/** Generic existing-conditions model contracts shared by production planning,
 * verification, and optional benchmark consumers. No benchmark identity or
 * answer-oracle policy belongs in this module. */
export type ExistingConditionsPoint3 = { x: number; y: number; z: number };
export type ExistingConditionsElementKind = "mep_curve" | "linear_element" | "fitting" | "family_instance" | "other";
export type ExistingConditionsDiscipline = "mechanical" | "plumbing" | "electrical" | "architectural" | "mixed" | "other";
export type ExistingConditionsRelationshipKind = "physical" | "wall_junction" | "host" | "electrical_circuit" | "system";

export type ExistingConditionsElement = {
  key: string;
  kind: ExistingConditionsElementKind;
  discipline?: ExistingConditionsDiscipline;
  role?: string | null;
  category: string;
  family?: string | null;
  type?: string | null;
  system_classification?: string | null;
  system_type?: string | null;
  location?: ExistingConditionsPoint3 | null;
  endpoints?: [ExistingConditionsPoint3, ExistingConditionsPoint3] | null;
  rotation_degrees?: number | null;
  level_name?: string | null;
  room_number?: string | null;
  space_number?: string | null;
  host_key?: string | null;
  electrical?: {
    panel?: string | null;
    circuit_number?: string | null;
    primary_label?: string | null;
    system_ids?: string[];
    power_system_ids?: string[];
    exact_power_system_count?: number;
  } | null;
  size?: {
    shape?: string | null;
    width_ft?: number | null;
    height_ft?: number | null;
    diameter_ft?: number | null;
  } | null;
  parameters?: Record<string, string | number | boolean | null>;
};

export type ExistingConditionsConnection = { a: string; b: string; kind?: ExistingConditionsRelationshipKind };
export type ExistingConditionsSnapshot = {
  native_readback: boolean;
  elements: ExistingConditionsElement[];
  connections: ExistingConditionsConnection[];
  open_connector_count: number;
};
export type ExistingConditionsEvidenceReceipt = { role: string; sha256: string };
export type ExistingConditionsDisciplineCoverageRequirement = {
  discipline: Exclude<ExistingConditionsDiscipline, "mixed" | "other">;
  minimum_precision: number;
  minimum_recall: number;
};
export type ExistingConditionsGroundTruth = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  discipline?: ExistingConditionsDiscipline;
  visible_evidence: ExistingConditionsEvidenceReceipt[];
  ground_truth_model?: { path: string; sha256: string };
  deletion_manifest?: {
    requested_element_ids: number[];
    deleted_element_ids: number[];
    dependent_element_ids: number[];
    dry_run_receipt_sha256: string;
  };
  evaluation_policy?: {
    require_evaluator_change_receipt?: boolean;
    elevation_evidence?: "plan_visible" | "project_context" | "not_visible";
    required_discipline_coverage?: ExistingConditionsDisciplineCoverageRequirement[];
    bounded_mep_region_coverage?: {
      required_coverage_status: "complete";
      source_evidence_sha256: string;
      registered_render_sha256: string;
      coverage_contract_sha256: string;
      region_sha256: string;
      clear_plan_visible_family_instance_keys: string[];
      clear_plan_visible_mep_curve_keys?: string[];
      route_trace_tolerance_ft?: number;
      minimum_route_trace_precision?: number;
      minimum_route_trace_recall?: number;
    };
  };
  snapshot: ExistingConditionsSnapshot;
};
