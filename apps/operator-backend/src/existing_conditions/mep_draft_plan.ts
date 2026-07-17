import crypto from "node:crypto";
import {
  solveExistingConditionsRegistration,
  transformExistingConditionsPlanPoint,
  type ExistingConditionsPlanPoint,
  type ExistingConditionsRegistrationInput,
  type ExistingConditionsRegistrationReceipt
} from "./registration.js";
import type {
  ExistingConditionsAmbiguity,
  ExistingConditionsPlanElement,
  ExistingConditionsSourceObservation
} from "./controller.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonMap = { [key: string]: JsonValue };

export type MepDraftVisibility = "clear" | "partial" | "occluded";

export type MepDraftAttributeProvenance = {
  attribute: string;
  basis: "source_observation" | "native_model_precedent" | "user_direction" | "declared_heuristic";
  reference: string;
};

export type MepDraftAnnotationTag = {
  view_reference_key: string;
  family_name: string;
  type_name: string;
  offset_x_ft: number;
  offset_y_ft: number;
  add_leader?: boolean;
};

type MepDraftObservationBase = {
  observation_id: string;
  evidence_role?: string;
  visibility: MepDraftVisibility;
  confidence: number;
  supported_attributes: string[];
  attribute_provenance?: MepDraftAttributeProvenance[];
};

export type MepDraftPlacement =
  | {
      mode: "unhosted_family";
      family_name: string;
      type_name: string;
      rotation_degrees?: number;
      /** Exact view-bound annotation tags required to reproduce source-visible labels. */
      annotation_tags?: MepDraftAnnotationTag[];
    }
  | {
      /**
       * Draw an explicitly provisional, view-specific symbol when the source
       * establishes a plan location and visible symbol form but not a
       * defensible native family/type, host, elevation, or service identity.
       * This preserves useful drafting progress without pretending a
       * DetailCurve is a modeled MEP element.
       */
      mode: "provisional_plan_symbol";
      view_reference_key: string;
      view_type: "FloorPlan" | "EngineeringPlan" | "CeilingPlan";
      symbol_form:
        | "hollow_circle"
        | "filled_circle"
        | "unclassified_circle"
        | "square"
        | "square_with_x"
        | "x_mark"
        | "cross"
        | "triangle"
        | "diamond";
      host_direction: "left" | "right" | "up" | "down" | "unresolved";
      radius_ft?: number;
      stem_length_ft?: number;
      line_style_name?: string;
    }
  | {
      /** Place an exact loaded family/type on an exact native host face without borrowing a source exemplar. */
      mode: "hosted_family_symbol";
      family_name: string;
      type_name: string;
      /** Optional same-category native precedent used only for project metadata such as workset assignment. */
      metadata_source_reference_key?: string;
      /** Optional same-category precedent used only to establish plan-readable family orientation. */
      orientation_source_reference_key?: string;
      /** Exact view-bound annotation tags required to reproduce source-visible labels. */
      annotation_tags?: MepDraftAnnotationTag[];
      host_reference_key: string;
      /** Exact model element inside a linked-model host, resolved from a separate hash-bound native reference. */
      linked_host_reference_key?: string;
      host_category: string;
      room_side?: string;
      /** Omit package room validation only when source evidence proves the observed instance is in adjacent visible scope. */
      require_room_membership_validation?: boolean;
      /** Exact source-grounded project electrical settings required before assigning a created panel. */
      ensure_distribution_system?: {
        name: string;
        electrical_phase: "SinglePhase" | "ThreePhase";
        phase_configuration: "Undefined" | "Delta" | "Wye";
        num_wires: number;
        voltage_line_to_line?: { name: string; actual_value: number; min_value: number; max_value: number };
        voltage_line_to_ground?: { name: string; actual_value: number; min_value: number; max_value: number };
      };
    }
  | {
      /** Place an air terminal on a duct segment created earlier in this atomic workflow. */
      mode: "created_route_host";
      family_name: string;
      type_name: string;
      route_observation_id: string;
      route_segment_index: number;
      rotation_degrees?: number;
    }
  | {
      /** Place an air terminal and connect it to a duct segment with source-grounded branch geometry. */
      mode: "created_route_branch";
      family_name: string;
      type_name: string;
      route_observation_id: string;
      route_segment_index: number;
      branch_points: ExistingConditionsPlanPoint[];
      branch_size: string;
      tee_family_name: string;
      tee_type_name: string;
      rotation_degrees?: number;
    }
  | {
      mode: "hosted_exemplar";
      source_reference_key: string;
      host_reference_key: string;
      host_category: string;
      /** Optional wall-chainage override. Omit when the registered world point is the placement authority. */
      target_chainage_ft?: number;
      room_side?: string;
      /** Omit package room validation only when source evidence proves the observed instance is in adjacent visible scope. */
      require_room_membership_validation?: boolean;
      match_orientation_from_source?: boolean;
      /** Panelboards must inherit a compatible native Distribution System before circuit assignment. */
      copy_distribution_system_from_source?: boolean;
    };

type PlumbingPipeRouteObservationBase = MepDraftObservationBase & {
  kind: "pipe_route";
  discipline: "plumbing";
  service: "domestic_cold_water" | "domestic_hot_water" | "domestic_hot_water_return" | "sanitary" | "vent" | "unclassified";
  /**
   * Explicit source- or precedent-grounded size. Omit only when the plotted
   * source is genuinely unreadable and pipe_size_policy records that the
   * created route is a non-scored drafting placeholder.
   */
  pipe_size?: string;
  pipe_size_policy?: "explicit_required" | "unresolved_placeholder";
  /**
   * The requested project-local pipe type may serve only as an editable native
   * drafting container when the record drawing does not establish type.
   */
  type_policy?: "explicit_required" | "unresolved_placeholder";
  pipe_type: string;
  /**
   * An unclassified source route may use an existing project system as an
   * editable, non-scored native drafting container until better evidence exists.
   */
  system_classification_policy?: "explicit_required" | "unresolved_placeholder";
  system_type: string;
};

export type PlumbingSourcePointRouteObservation = PlumbingPipeRouteObservationBase & {
  geometry_mode?: "source_points";
  points: ExistingConditionsPlanPoint[];
  elevation_ft: number;
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
  connect_to_existing?: boolean;
  require_existing_endpoint_connections?: boolean;
  external_connection_tolerance_ft?: number;
};

export type PlumbingSourceBranchTeeObservation = PlumbingPipeRouteObservationBase & {
  /** Create a source-visible branch from one exact segment of a route drafted earlier in the same atomic graph. */
  geometry_mode: "source_branch_tee";
  main_route_observation_id: string;
  points: ExistingConditionsPlanPoint[];
  elevation_ft: number;
  tee_family_name: string;
  tee_type_name: string;
};

export type PlumbingNativeConnectorBridgeObservation = PlumbingPipeRouteObservationBase & {
  /**
   * Resolve both endpoints from native open connectors after placing the source
   * fixture. This is for short service stubs whose exact offsets are not legible
   * in the plotted plan; the hidden geometry remains an explicit inference.
   */
  geometry_mode: "native_connector_bridge";
  source_fixture_observation_id: string;
  target_reference_key: string;
  maximum_length_ft?: number;
  size_tolerance_ft?: number;
};

export type PlumbingCreatedRouteConnectorBridgeObservation = PlumbingPipeRouteObservationBase & {
  /**
   * Resolve the fixture endpoint from its native open connector and the target
   * endpoint from a source-grounded route created earlier in the same atomic
   * workflow. The short concealed stub is a labeled runtime inference.
   */
  geometry_mode: "created_route_connector_bridge";
  source_fixture_observation_id: string;
  target_route_observation_id: string;
  target_route_endpoint: "start" | "end";
  maximum_length_ft?: number;
  size_tolerance_ft?: number;
};

type PlumbingDownstreamVentTeeObservationBase = PlumbingPipeRouteObservationBase & {
  /**
   * Create a Vent-classified tee branch from a sanitary main, then verify
   * downstream reachability from explicit native fixture references.
   * This is deliberately not a direct fixture service connection.
   */
  geometry_mode: "downstream_vent_tee";
  service: "vent";
  /** Retained native fixtures to verify after the tee is created. */
  verification_fixture_reference_keys?: string[];
  /** Fixture observations placed and connected earlier in the same atomic workflow. */
  verification_fixture_observation_ids?: string[];
  /**
   * Native reachability is the acceptance path. Plan-topology-only is an
   * explicitly weaker drafting fallback for connectorless fixture graphics.
   */
  verification_mode?: "native_fixture_reachability" | "plan_topology_only";
  points: ExistingConditionsPlanPoint[];
  /** Branch endpoint/routing offset above level; may be a labeled heuristic. */
  elevation_ft: number;
  max_vent_search_elements?: number;
  max_vent_search_hops?: number;
};

export type PlumbingDownstreamVentTeeObservation = PlumbingDownstreamVentTeeObservationBase & (
  | {
      /** Exact retained native sanitary main. */
      main_reference_key: string;
      main_route_observation_id?: never;
      /** Exact retained-main offset above level, grounded in native evidence. */
      main_elevation_ft: number;
    }
  | {
      /** Source-point sanitary route created earlier in the same atomic workflow. */
      main_route_observation_id: string;
      main_reference_key?: never;
      main_elevation_ft?: never;
    }
);

export type PlumbingPipeRouteObservation =
  | PlumbingSourcePointRouteObservation
  | PlumbingSourceBranchTeeObservation
  | PlumbingNativeConnectorBridgeObservation
  | PlumbingCreatedRouteConnectorBridgeObservation
  | PlumbingDownstreamVentTeeObservation;

export type MechanicalHydronicPipeRouteObservation = MepDraftObservationBase & {
  kind: "pipe_route";
  discipline: "mechanical";
  service:
    | "heating_hot_water_supply"
    | "heating_hot_water_return"
    | "chilled_water_supply"
    | "chilled_water_return"
    | "condenser_water_supply"
    | "condenser_water_return"
    | "unclassified";
  geometry_mode?: "source_points";
  points: ExistingConditionsPlanPoint[];
  elevation_ft: number;
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
  pipe_size?: string;
  pipe_size_policy?: "explicit_required" | "unresolved_placeholder";
  type_policy?: "explicit_required" | "unresolved_placeholder";
  pipe_type: string;
  system_classification_policy?: "explicit_required" | "unresolved_placeholder";
  system_type: string;
  connect_to_existing?: boolean;
  require_existing_endpoint_connections?: boolean;
  external_connection_tolerance_ft?: number;
};

export type MepPipeRouteObservation = PlumbingPipeRouteObservation | MechanicalHydronicPipeRouteObservation;

export type PlumbingFixtureRepresentationClassification = {
  /** What the source-visible plan graphic actually depicts. */
  source_graphic:
    | "architectural_fixture"
    | "mep_connection_symbol"
    | "combined_fixture_and_connection"
    | "unresolved";
  /** What the compiled placement will create. */
  native_target: "architectural_fixture" | "mep_connection" | "plan_only_marker";
  /** Classification must be grounded in the visible source or explicit direction, never an implicit family-name guess. */
  basis: "source_observation" | "user_direction";
  evidence_role: string;
  reference: string;
  /** Exact family/type mapping for a declared native target representation. Omitted for a plan-only marker. */
  native_target_evidence?: {
    basis: "native_model_precedent" | "user_direction";
    evidence_role: string;
    reference: string;
    family_name: string;
    type_name: string;
  };
};

export type PlumbingFixtureObservation = MepDraftObservationBase & {
  kind: "plumbing_fixture";
  discipline: "plumbing";
  role: string;
  point: ExistingConditionsPlanPoint;
  elevation_ft?: number;
  placement: MepDraftPlacement;
  representation_classification: PlumbingFixtureRepresentationClassification;
  /**
   * Plan proximity places visible fixture graphics and records source-visible
   * service adjacency without claiming a native Revit connector relationship.
   */
  service_connection_mode?: "native_connectivity" | "plan_proximity";
  service_route_connections: Array<{
    route_observation_id: string;
    route_endpoint: "start" | "end" | "native_source" | "nearest_plan_segment";
    maximum_plan_distance_ft?: number;
  }>;
  service_boundary?: {
    basis: "source_observation" | "native_model_precedent";
    evidence_role: string;
    required_services: PlumbingPipeRouteObservation["service"][];
    prohibited_services: PlumbingPipeRouteObservation["service"][];
  };
};

export type MechanicalDuctRouteObservation = MepDraftObservationBase & {
  kind: "duct_route";
  discipline: "mechanical";
  service: "supply_air" | "return_air" | "exhaust_air" | "outside_air" | "unclassified";
  points: ExistingConditionsPlanPoint[];
  elevation_ft: number;
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
  /** Omit when duct_size_policy records a disclosed, non-scored drafting fallback. */
  duct_size?: string;
  duct_size_policy?: "explicit_required" | "unresolved_placeholder";
  type_policy?: "explicit_required" | "unresolved_placeholder";
  duct_type: string;
  /** Optional stable native type id used to disambiguate duplicate duct type names. */
  duct_type_id?: number;
  system_classification_policy?: "explicit_required" | "unresolved_placeholder";
  system_type: string;
  connect_to_existing?: boolean;
  require_existing_endpoint_connections?: boolean;
  external_connection_tolerance_ft?: number;
};

export type ElectricalConduitRouteObservation = MepDraftObservationBase & {
  kind: "conduit_route";
  discipline: "electrical";
  service: "branch_circuit" | "feeder" | "communications" | "fire_alarm" | "other" | "unclassified";
  points: ExistingConditionsPlanPoint[];
  elevation_ft: number;
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
  /** Omit only when conduit_size_policy records a non-scored drafting placeholder. */
  conduit_size?: string;
  conduit_size_policy?: "explicit_required" | "unresolved_placeholder";
  type_policy?: "explicit_required" | "unresolved_placeholder";
  conduit_type: string;
  conduit_type_id?: number;
  connect_to_existing?: boolean;
  require_existing_endpoint_connections?: boolean;
  external_connection_tolerance_ft?: number;
};

type MechanicalFamilyInstanceObservationBase = MepDraftObservationBase & {
  discipline: "mechanical";
  role: string;
  point: ExistingConditionsPlanPoint;
  elevation_ft?: number;
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
  placement: MepDraftPlacement;
};

export type MechanicalEquipmentObservation = MechanicalFamilyInstanceObservationBase & {
  kind: "mechanical_equipment";
};

export type AirTerminalObservation = MechanicalFamilyInstanceObservationBase & {
  kind: "air_terminal";
  /** Source-visible terminal airflow in engineer-facing CFM. */
  airflow_cfm?: number;
};

type ElectricalFamilyInstanceObservationBase = MepDraftObservationBase & {
  discipline: "electrical";
  role: string;
  point: ExistingConditionsPlanPoint;
  elevation_ft?: number;
  placement: MepDraftPlacement;
};

export type ElectricalDeviceObservation = ElectricalFamilyInstanceObservationBase & {
  kind: "electrical_device";
  /** Source-visible, non-membership instance parameters such as GFI labels or mounting graphics. */
  instance_parameters?: Record<string, string>;
};

export type LightFixtureObservation = ElectricalFamilyInstanceObservationBase & {
  kind: "light_fixture";
  /** Exact project workset name, supported by project-native precedent or explicit direction. */
  workset_name?: string;
};

export type ElectricalEquipmentObservation = ElectricalFamilyInstanceObservationBase & {
  kind: "electrical_equipment";
  /** Source-visible panel identity applied to Revit's writable Panel Name parameter. */
  panel_name?: string;
};

type ElectricalCircuitObservationBase = MepDraftObservationBase & {
  kind: "electrical_circuit";
  discipline: "electrical";
  member_observation_ids: string[];
  /** Existing hash-bound native elements that participate directly without creating a duplicate family instance. */
  native_member_reference_keys?: string[];
  panel_circuit_label?: string;
};

export type ElectricalSourceCircuitObservation = ElectricalCircuitObservationBase & {
  circuit_mode?: "match_source_power_system";
  source_reference_key: string;
  expected_power_system_id: string;
  membership_basis: "native_source_power_system";
};

export type ElectricalNewCircuitObservation = ElectricalCircuitObservationBase & {
  circuit_mode: "create_new_power_system";
  system_type: "PowerCircuit";
  membership_basis: "legible_source_circuit_label" | "user_direction";
  panel_reference_key?: string;
  /** Electrical-equipment observation created earlier in this same atomic graph. */
  panel_observation_id?: string;
  member_label_evidence?: Array<{
    member_observation_id: string;
    evidence_role: string;
    reference: string;
    label: string;
  }>;
  native_member_label_evidence?: Array<{
    native_member_reference_key: string;
    evidence_role: string;
    reference: string;
    label: string;
  }>;
  user_direction_reference?: string;
};

export type ElectricalCircuitObservation = ElectricalSourceCircuitObservation | ElectricalNewCircuitObservation;

export type MepDraftObservation =
  | MechanicalDuctRouteObservation
  | ElectricalConduitRouteObservation
  | MechanicalEquipmentObservation
  | AirTerminalObservation
  | PlumbingPipeRouteObservation
  | MechanicalHydronicPipeRouteObservation
  | PlumbingFixtureObservation
  | ElectricalDeviceObservation
  | LightFixtureObservation
  | ElectricalEquipmentObservation
  | ElectricalCircuitObservation;

export type MepDraftPackage = {
  schema_version: 1;
  fixture_id: string;
  scope_id: string;
  source_evidence_sha256: string;
  visible_evidence: Array<{ role: string; sha256: string }>;
  native_element_references: Array<{
    reference_key: string;
    element_id: number;
    category: string;
    role: string;
    evidence_role: string;
    evidence_sha256: string;
    power_system_ids?: string[];
  }>;
  registration: ExistingConditionsRegistrationInput;
  level_name: string;
  /** Absolute model elevation of level_name. Observation elevation_ft values are offsets above this level. */
  level_elevation_ft: number;
  room_number?: string;
  material_confidence_threshold?: number;
  /**
   * Keep benchmark/acceptance compilation all-or-nothing by default. Explicit
   * iterative drafting may instead emit only independent, source-supported
   * actions while deferring ambiguous observations and their dependents.
   */
  partial_promotion_policy?: "all_or_nothing" | "defer_ambiguous_observations";
  observations: MepDraftObservation[];
};

export type MepDraftElementReference = {
  created_by_action: string;
  output?: "created" | "route_start" | "route_end" | "route_segment" | "split_main_start" | "split_main_end";
  index?: number;
};

export type MepDraftAction = {
  action_key: string;
  observation_ids: string[];
  method: "POST";
  path:
    | "/revit/mep-route-workflow"
    | "/revit/place-families"
    | "/revit/place-family-instance-on-host"
    | "/revit/connect-mep-elements"
    | "/revit/create-pipe-between-connectors"
    | "/revit/connect-mep-branch"
    | "/revit/audit-plumbing-fixture-services"
    | "/revit/assign-electrical-circuit"
    | "/revit/draw-detail-curves"
    | "/revit/tag-elements";
  depends_on: string[];
  dry_run_body?: JsonMap;
  apply_body?: JsonMap;
  deferred_body?: {
    host_element?: MepDraftElementReference;
    source_element?: MepDraftElementReference;
    main_element?: MepDraftElementReference;
    target_element?: MepDraftElementReference;
    target_elements?: MepDraftElementReference[];
    element_ids?: MepDraftElementReference[];
    existing_element_ids?: number[];
    source_element_id?: number;
    create_system_type?: "PowerCircuit";
    panel_element_id?: number;
    panel_element?: MepDraftElementReference;
    target_element_id?: number;
    required_connection_count?: number;
    fixture_elements?: MepDraftElementReference[];
    fixture_element_ids?: number[];
    require_downstream_vent?: boolean;
    tag_element?: MepDraftElementReference;
  };
  expected_model_point?: ExistingConditionsPlanPoint & { z: number };
  expected_created_min: number;
  expected_created_max: number;
  provisional_system_classification?: {
    policy: "unresolved_placeholder";
    native_system_type_role: "editable_native_drafting_container";
    benchmark_credit: false;
    complete_scope_credit: false;
  };
  provisional_route_attributes?: {
    unresolved_attributes: Array<"size" | "type">;
    native_type_role?: "editable_native_drafting_container";
    native_size_role?: "editable_default_drafting_placeholder";
    benchmark_credit: false;
    complete_scope_credit: false;
    external_topology_credit: false;
  };
  provisional_plan_representation?: {
    native_category: "OST_Lines";
    representation_role: "view_specific_plan_symbol_marker" | "view_specific_plan_route_trace";
    source_observation_kind:
      | "mechanical_equipment"
      | "air_terminal"
      | "plumbing_fixture"
      | "electrical_device"
      | "light_fixture"
      | "electrical_equipment"
      | "plan_trace_route_candidate";
    source_candidate_id?: string;
    source_path_count?: number;
    continuity?: "observed_contiguous" | "disconnected_dashes";
    modeled_element_created: false;
    modeled_device_created: false;
    modeled_route_created?: false;
    native_medium_classified?: false;
    benchmark_credit: false;
    complete_scope_credit: false;
  };
};

export type CompiledMepDraftPlan = {
  schema_version: 1;
  status: "ready" | "partially_ready" | "clarification_required" | "blocked";
  partial_promotion_policy: "all_or_nothing" | "defer_ambiguous_observations";
  promoted_observation_ids: string[];
  deferred_observation_ids: string[];
  provisional_observation_ids: string[];
  fixture_id: string;
  scope_id: string;
  input_fingerprint_sha256: string;
  registration: ExistingConditionsRegistrationReceipt;
  source_observations: ExistingConditionsSourceObservation[];
  plan_elements: ExistingConditionsPlanElement[];
  ambiguities: ExistingConditionsAmbiguity[];
  actions: MepDraftAction[];
  blockers: string[];
  warnings: string[];
};

export type AtomicMepDraftWorkflowRequest = {
  inputFingerprintSha256: string;
  operations: Array<Pick<MepDraftAction, "action_key" | "observation_ids" | "path" | "depends_on" | "apply_body" | "deferred_body" | "expected_created_min" | "expected_created_max" | "provisional_system_classification" | "provisional_route_attributes" | "provisional_plan_representation">>;
  provisionalObservationIds: string[];
  dryRun: boolean;
  verify: boolean;
  maximumCreatedElements: number;
  benchmarkCredit?: false;
  authorizationBasis?: "explicit_unscored_user_direction";
};

function clean(value: unknown): string {
  return String(value ?? "").trim();
}

function normalized(value: unknown): string {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, " ");
}

function isCircuitMembershipParameterName(value: unknown): boolean {
  const canonical = clean(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (!canonical) return false;
  const tokens = new Set(canonical.split(/\s+/));
  return tokens.has("panel")
    || tokens.has("panelboard")
    || tokens.has("circuit")
    || tokens.has("ckt")
    || canonical.includes("distribution system")
    || canonical.includes("electrical data")
    || canonical.includes("power system");
}

function routeWorksetName(observation: MepDraftObservation): string {
  return clean((observation as { workset_name?: string }).workset_name);
}

function pipeSizePolicy(observation: MepPipeRouteObservation): "explicit_required" | "unresolved_placeholder" {
  return observation.pipe_size_policy ?? "explicit_required";
}

function ductSizePolicy(observation: MechanicalDuctRouteObservation): "explicit_required" | "unresolved_placeholder" {
  return observation.duct_size_policy ?? "explicit_required";
}

function routeSystemClassificationPolicy(
  observation: MepPipeRouteObservation | MechanicalDuctRouteObservation
): "explicit_required" | "unresolved_placeholder" {
  return observation.system_classification_policy ?? "explicit_required";
}

function conduitSizePolicy(observation: ElectricalConduitRouteObservation): "explicit_required" | "unresolved_placeholder" {
  return observation.conduit_size_policy ?? "explicit_required";
}

function routeTypePolicy(
  observation: MepPipeRouteObservation | MechanicalDuctRouteObservation | ElectricalConduitRouteObservation
): "explicit_required" | "unresolved_placeholder" {
  return observation.type_policy ?? "explicit_required";
}

function requiresProvisionalRouteCredit(observation: MepDraftObservation): boolean {
  if (observation.kind !== "pipe_route"
    && observation.kind !== "duct_route"
    && observation.kind !== "conduit_route") {
    return false;
  }
  if (routeTypePolicy(observation) === "unresolved_placeholder") return true;
  if (observation.kind === "pipe_route" && pipeSizePolicy(observation) === "unresolved_placeholder") return true;
  if (observation.kind === "duct_route" && ductSizePolicy(observation) === "unresolved_placeholder") return true;
  if (observation.kind === "conduit_route"
    && (conduitSizePolicy(observation) === "unresolved_placeholder" || observation.service === "unclassified")) {
    return true;
  }
  return (observation.kind === "pipe_route" || observation.kind === "duct_route")
    && routeSystemClassificationPolicy(observation) === "unresolved_placeholder";
}

function provisionalRouteAttributes(
  observation: MepPipeRouteObservation | MechanicalDuctRouteObservation | ElectricalConduitRouteObservation
): MepDraftAction["provisional_route_attributes"] | undefined {
  const unresolved: Array<"size" | "type"> = [];
  if ((observation.kind === "pipe_route" && pipeSizePolicy(observation) === "unresolved_placeholder")
    || (observation.kind === "duct_route" && ductSizePolicy(observation) === "unresolved_placeholder")
    || (observation.kind === "conduit_route" && conduitSizePolicy(observation) === "unresolved_placeholder")) {
    unresolved.push("size");
  }
  if (routeTypePolicy(observation) === "unresolved_placeholder") unresolved.push("type");
  if (unresolved.length === 0) return undefined;
  return {
    unresolved_attributes: unresolved,
    ...(unresolved.includes("type") ? { native_type_role: "editable_native_drafting_container" as const } : {}),
    ...(unresolved.includes("size") ? { native_size_role: "editable_default_drafting_placeholder" as const } : {}),
    benchmark_credit: false,
    complete_scope_credit: false,
    external_topology_credit: false
  };
}

function fixtureConnectionMode(observation: PlumbingFixtureObservation): "native_connectivity" | "plan_proximity" {
  return observation.service_connection_mode ?? "native_connectivity";
}

function routePlanPoints(observation: MepPipeRouteObservation): ExistingConditionsPlanPoint[] | null {
  return observation.geometry_mode === "native_connector_bridge"
    || observation.geometry_mode === "created_route_connector_bridge"
    ? null
    : observation.points;
}

function requiredText(value: unknown, label: string): string {
  const result = clean(value);
  if (!result) throw new Error(`${label}_is_required`);
  return result;
}

function requiredSha256(value: unknown, label: string): string {
  const result = clean(value).toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label}_must_be_sha256`);
  return result;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label}_must_be_positive_integer`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) throw new Error(`${label}_must_be_nonnegative_integer`);
  return value;
}

function finite(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label}_must_be_finite`);
  return value;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = clean(raw);
    const key = normalized(value);
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function planDistanceToSegment(
  point: ExistingConditionsPlanPoint,
  start: ExistingConditionsPlanPoint,
  end: ExistingConditionsPlanPoint
): number {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const parameter = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared));
  return Math.hypot(point.x - (start.x + parameter * dx), point.y - (start.y + parameter * dy));
}

function resolveUniqueRouteSegmentIndex(
  routePoints: ExistingConditionsPlanPoint[],
  teePoint: ExistingConditionsPlanPoint,
  observationId: string
): number {
  const candidates = routePoints.slice(0, -1)
    .map((start, index) => ({ index, distance: planDistanceToSegment(teePoint, start, routePoints[index + 1]!) }))
    .sort((left, right) => left.distance - right.distance || left.index - right.index);
  const best = candidates[0];
  if (!best || best.distance > 0.1) throw new Error(`${observationId}_planned_main_tee_point_off_route`);
  const next = candidates[1];
  if (next && Math.abs(next.distance - best.distance) < 0.01) {
    throw new Error(`${observationId}_planned_main_tee_segment_ambiguous`);
  }
  return best.index;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function inputFingerprint(input: MepDraftPackage): string {
  return crypto.createHash("sha256").update(canonicalJson({
    source_evidence_sha256: input.source_evidence_sha256,
    visible_evidence: input.visible_evidence,
    native_element_references: input.native_element_references,
    registration: input.registration,
    level_name: input.level_name,
    level_elevation_ft: input.level_elevation_ft,
    room_number: input.room_number ?? null,
    material_confidence_threshold: input.material_confidence_threshold ?? null,
    partial_promotion_policy: input.partial_promotion_policy ?? "all_or_nothing",
    observations: input.observations
  })).digest("hex");
}

function materialAttributes(observation: MepDraftObservation): string[] {
  if (observation.kind === "duct_route") {
    return [
      "location",
      ...(ductSizePolicy(observation) === "explicit_required" ? ["size"] : []),
      "elevation",
      ...(routeSystemClassificationPolicy(observation) === "explicit_required" ? ["system"] : []),
      ...(routeTypePolicy(observation) === "explicit_required" ? ["type"] : [])
    ];
  }
  if (observation.kind === "conduit_route") {
    return [
      "location",
      ...(conduitSizePolicy(observation) === "explicit_required" ? ["size"] : []),
      "elevation",
      ...(observation.service === "unclassified" ? [] : ["system"]),
      ...(routeTypePolicy(observation) === "explicit_required" ? ["type"] : [])
    ];
  }
  if (observation.kind === "pipe_route") {
    const size = pipeSizePolicy(observation) === "explicit_required" ? ["size"] : [];
    const system = routeSystemClassificationPolicy(observation) === "explicit_required" ? ["system"] : [];
    return observation.geometry_mode === "downstream_vent_tee"
      ? ["location", ...size, ...(clean(observation.main_reference_key) ? ["main elevation"] : []), "elevation", ...system, ...(routeTypePolicy(observation) === "explicit_required" ? ["type"] : [])]
      : ["location", ...size, "elevation", ...system, ...(routeTypePolicy(observation) === "explicit_required" ? ["type"] : [])];
  }
  if ("placement" in observation && observation.placement.mode === "provisional_plan_symbol") {
    return [
      "location",
      "provisional plan representation",
      "symbol form",
      ...(observation.placement.host_direction === "unresolved" ? [] : ["host direction"])
    ];
  }
  if (observation.kind === "plumbing_fixture") {
    return observation.placement.mode === "hosted_exemplar" || observation.placement.mode === "hosted_family_symbol"
      ? ["location", "type", "host", "service topology"]
      : ["location", "type", "service topology"];
  }
  if (observation.kind === "mechanical_equipment" || observation.kind === "air_terminal"
    || observation.kind === "electrical_device" || observation.kind === "light_fixture" || observation.kind === "electrical_equipment") {
    const placementAttributes = observation.placement.mode === "hosted_exemplar"
      || observation.placement.mode === "hosted_family_symbol"
      || observation.placement.mode === "created_route_host"
      || observation.placement.mode === "created_route_branch"
      ? ["location", "type", "host"]
      : ["location", "type"];
    if (observation.kind === "air_terminal") {
      if (observation.airflow_cfm != null) placementAttributes.push("airflow");
      if (routeWorksetName(observation)) placementAttributes.push("workset");
    }
    if (observation.kind === "light_fixture") {
      placementAttributes.push("elevation");
      if (routeWorksetName(observation)) placementAttributes.push("workset");
    }
    if (observation.kind === "electrical_device" && observation.instance_parameters != null) {
      placementAttributes.push("instance parameters");
    }
    return placementAttributes;
  }
  return ["circuit"];
}

function category(observation: MepDraftObservation): string {
  if ("placement" in observation && observation.placement.mode === "provisional_plan_symbol") return "OST_Lines";
  if (observation.kind === "duct_route") return "OST_DuctCurves";
  if (observation.kind === "conduit_route") return "OST_Conduit";
  if (observation.kind === "mechanical_equipment") return "OST_MechanicalEquipment";
  if (observation.kind === "air_terminal") return "OST_DuctTerminal";
  if (observation.kind === "pipe_route") return "OST_PipeCurves";
  if (observation.kind === "plumbing_fixture") return "OST_PlumbingFixtures";
  if (observation.kind === "light_fixture") return "OST_LightingFixtures";
  if (observation.kind === "electrical_equipment") return "OST_ElectricalEquipment";
  return "OST_ElectricalFixtures";
}

function role(observation: MepDraftObservation): string {
  if ("placement" in observation && observation.placement.mode === "provisional_plan_symbol") {
    return `provisional ${observation.role} plan symbol marker`;
  }
  if (observation.kind === "duct_route") return observation.service.replaceAll("_", " ");
  if (observation.kind === "conduit_route") return `${observation.service.replaceAll("_", " ")} conduit`;
  if (observation.kind === "pipe_route") return observation.service.replaceAll("_", " ");
  if (observation.kind === "electrical_circuit") return observation.panel_circuit_label
    ? `electrical circuit ${observation.panel_circuit_label}`
    : "electrical circuit";
  return observation.role;
}

function action(observation: MepDraftObservation): ExistingConditionsPlanElement["action"] {
  return observation.kind === "electrical_circuit" ? "assign_circuit" : "create";
}

function validatePlacement(placement: MepDraftPlacement, observationId: string): void {
  if (placement.mode === "unhosted_family") {
    requiredText(placement.family_name, `${observationId}_family_name`);
    requiredText(placement.type_name, `${observationId}_type_name`);
    if (placement.rotation_degrees != null) finite(placement.rotation_degrees, `${observationId}_rotation_degrees`);
    return;
  }
  if (placement.mode === "provisional_plan_symbol") {
    requiredText(placement.view_reference_key, `${observationId}_view_reference_key`);
    if (!["FloorPlan", "EngineeringPlan", "CeilingPlan"].includes(placement.view_type)) {
      throw new Error(`${observationId}_provisional_view_type_invalid`);
    }
    if (![
      "hollow_circle",
      "filled_circle",
      "unclassified_circle",
      "square",
      "square_with_x",
      "x_mark",
      "cross",
      "triangle",
      "diamond"
    ].includes(placement.symbol_form)) {
      throw new Error(`${observationId}_provisional_symbol_form_invalid`);
    }
    if (!["left", "right", "up", "down", "unresolved"].includes(placement.host_direction)) {
      throw new Error(`${observationId}_provisional_host_direction_invalid`);
    }
    const radius = placement.radius_ft == null ? 0.25 : finite(placement.radius_ft, `${observationId}_radius_ft`);
    if (radius < 0.05 || radius > 2) throw new Error(`${observationId}_radius_ft_out_of_range`);
    const stemLength = placement.stem_length_ft == null
      ? (placement.host_direction === "unresolved" ? 0 : 0.5)
      : finite(placement.stem_length_ft, `${observationId}_stem_length_ft`);
    if (stemLength < 0 || stemLength > 5) throw new Error(`${observationId}_stem_length_ft_out_of_range`);
    if (placement.host_direction === "unresolved" && stemLength > 0) {
      throw new Error(`${observationId}_unresolved_host_direction_requires_zero_stem`);
    }
    if (placement.line_style_name != null) {
      requiredText(placement.line_style_name, `${observationId}_line_style_name`);
    }
    return;
  }
  if (placement.mode === "hosted_family_symbol") {
    requiredText(placement.family_name, `${observationId}_family_name`);
    requiredText(placement.type_name, `${observationId}_type_name`);
    requiredText(placement.host_reference_key, `${observationId}_host_reference_key`);
    if (placement.linked_host_reference_key != null) {
      requiredText(placement.linked_host_reference_key, `${observationId}_linked_host_reference_key`);
    }
    requiredText(placement.host_category, `${observationId}_host_category`);
    if (placement.room_side != null) requiredText(placement.room_side, `${observationId}_room_side`);
    if (placement.require_room_membership_validation === false && placement.room_side != null) {
      throw new Error(`${observationId}_room_side_requires_room_membership_validation`);
    }
    if (placement.ensure_distribution_system) {
      const definition = placement.ensure_distribution_system;
      requiredText(definition.name, `${observationId}_distribution_system_name`);
      if (!["SinglePhase", "ThreePhase"].includes(definition.electrical_phase)) {
        throw new Error(`${observationId}_distribution_system_electrical_phase_invalid`);
      }
      if (!["Undefined", "Delta", "Wye"].includes(definition.phase_configuration)) {
        throw new Error(`${observationId}_distribution_system_phase_configuration_invalid`);
      }
      const wires = positiveInteger(definition.num_wires, `${observationId}_distribution_system_num_wires`);
      if (wires < 2 || wires > 4) throw new Error(`${observationId}_distribution_system_num_wires_must_be_2_to_4`);
      for (const [role, voltage] of [["line_to_line", definition.voltage_line_to_line], ["line_to_ground", definition.voltage_line_to_ground]] as const) {
        if (!voltage) continue;
        requiredText(voltage.name, `${observationId}_${role}_voltage_name`);
        const actual = finite(voltage.actual_value, `${observationId}_${role}_voltage_actual`);
        const min = finite(voltage.min_value, `${observationId}_${role}_voltage_min`);
        const max = finite(voltage.max_value, `${observationId}_${role}_voltage_max`);
        if (min > actual || actual > max) throw new Error(`${observationId}_${role}_voltage_range_invalid`);
      }
    }
    return;
  }
  if (placement.mode === "created_route_host") {
    requiredText(placement.family_name, `${observationId}_family_name`);
    requiredText(placement.type_name, `${observationId}_type_name`);
    requiredText(placement.route_observation_id, `${observationId}_route_observation_id`);
    nonnegativeInteger(placement.route_segment_index, `${observationId}_route_segment_index`);
    if (placement.rotation_degrees != null) finite(placement.rotation_degrees, `${observationId}_rotation_degrees`);
    return;
  }
  if (placement.mode === "created_route_branch") {
    requiredText(placement.family_name, `${observationId}_family_name`);
    requiredText(placement.type_name, `${observationId}_type_name`);
    requiredText(placement.route_observation_id, `${observationId}_route_observation_id`);
    nonnegativeInteger(placement.route_segment_index, `${observationId}_route_segment_index`);
    requiredText(placement.branch_size, `${observationId}_branch_size`);
    requiredText(placement.tee_family_name, `${observationId}_tee_family_name`);
    requiredText(placement.tee_type_name, `${observationId}_tee_type_name`);
    if (!Array.isArray(placement.branch_points) || placement.branch_points.length < 2) {
      throw new Error(`${observationId}_requires_at_least_two_branch_points`);
    }
    placement.branch_points.forEach((entry, pointIndex) => {
      finite(entry.x, `${observationId}_branch_point_${pointIndex}_x`);
      finite(entry.y, `${observationId}_branch_point_${pointIndex}_y`);
    });
    if (placement.rotation_degrees != null) finite(placement.rotation_degrees, `${observationId}_rotation_degrees`);
    return;
  }
  requiredText(placement.source_reference_key, `${observationId}_source_reference_key`);
  requiredText(placement.host_reference_key, `${observationId}_host_reference_key`);
  requiredText(placement.host_category, `${observationId}_host_category`);
  if (placement.target_chainage_ft != null) {
    const chainage = finite(placement.target_chainage_ft, `${observationId}_target_chainage_ft`);
    if (chainage < 0) throw new Error(`${observationId}_target_chainage_ft_must_be_nonnegative`);
  }
  if (placement.require_room_membership_validation === false && placement.room_side != null) {
    throw new Error(`${observationId}_room_side_requires_room_membership_validation`);
  }
}

function validateAnnotationTags(
  placement: MepDraftPlacement,
  observationId: string,
  nativeReferences: Map<string, MepDraftPackage["native_element_references"][number]>
): void {
  if (placement.mode !== "unhosted_family" && placement.mode !== "hosted_family_symbol") return;
  if (placement.annotation_tags == null) return;
  if (!Array.isArray(placement.annotation_tags)
    || placement.annotation_tags.length < 1
    || placement.annotation_tags.length > 4) {
    throw new Error(`${observationId}_annotation_tags_count_out_of_range`);
  }
  placement.annotation_tags.forEach((tag, index) => {
    requiredText(tag.family_name, `${observationId}_annotation_tag_family_${index}`);
    requiredText(tag.type_name, `${observationId}_annotation_tag_type_${index}`);
    const viewReference = nativeReferences.get(requiredText(tag.view_reference_key, `${observationId}_annotation_tag_view_${index}`));
    if (!viewReference) throw new Error(`${observationId}_annotation_tag_view_reference_unknown:${index}`);
    if (!new Set(["view", "ost views"]).has(normalized(viewReference.category))) {
      throw new Error(`${observationId}_annotation_tag_view_reference_category_mismatch:${index}`);
    }
    const offsetX = finite(tag.offset_x_ft, `${observationId}_annotation_tag_offset_x_${index}`);
    const offsetY = finite(tag.offset_y_ft, `${observationId}_annotation_tag_offset_y_${index}`);
    if (Math.abs(offsetX) > 10 || Math.abs(offsetY) > 10) {
      throw new Error(`${observationId}_annotation_tag_offset_out_of_range:${index}`);
    }
  });
}

function validateObservation(
  observation: MepDraftObservation,
  index: number,
  nativeReferences: Map<string, MepDraftPackage["native_element_references"][number]>
): void {
  const id = requiredText(observation.observation_id, `observation_${index}_id`);
  if (!Number.isFinite(observation.confidence) || observation.confidence < 0 || observation.confidence > 1) {
    throw new Error(`${id}_confidence_must_be_between_zero_and_one`);
  }
  if (!["clear", "partial", "occluded"].includes(observation.visibility)) throw new Error(`${id}_visibility_is_invalid`);
  if (!Array.isArray(observation.supported_attributes)) throw new Error(`${id}_supported_attributes_must_be_array`);
  if (observation.attribute_provenance != null) {
    if (!Array.isArray(observation.attribute_provenance)) throw new Error(`${id}_attribute_provenance_must_be_array`);
    const supported = new Set(observation.supported_attributes.map(normalized));
    const seen = new Set<string>();
    for (const [provenanceIndex, provenance] of observation.attribute_provenance.entries()) {
      const attribute = normalized(requiredText(provenance.attribute, `${id}_attribute_provenance_${provenanceIndex}_attribute`));
      if (!supported.has(attribute)) throw new Error(`${id}_attribute_provenance_not_supported:${attribute}`);
      if (seen.has(attribute)) throw new Error(`${id}_attribute_provenance_duplicate:${attribute}`);
      seen.add(attribute);
      if (!["source_observation", "native_model_precedent", "user_direction", "declared_heuristic"].includes(provenance.basis)) {
        throw new Error(`${id}_attribute_provenance_basis_invalid:${attribute}`);
      }
      if (provenance.basis === "declared_heuristic"
        && ((observation.kind !== "pipe_route" && observation.kind !== "duct_route" && observation.kind !== "conduit_route") || attribute !== "elevation")) {
        throw new Error(`${id}_declared_heuristic_only_allowed_for_route_elevation`);
      }
      requiredText(provenance.reference, `${id}_${attribute}_provenance_reference`);
    }
  }
  if (observation.kind === "duct_route") {
    const ductServices = ["supply_air", "return_air", "exhaust_air", "outside_air", "unclassified"];
    if (!ductServices.includes(observation.service)) {
      throw new Error(`${id}_duct_service_invalid`);
    }
    if (!Array.isArray(observation.points) || observation.points.length < 2) throw new Error(`${id}_requires_at_least_two_points`);
    observation.points.forEach((entry, pointIndex) => {
      finite(entry.x, `${id}_point_${pointIndex}_x`);
      finite(entry.y, `${id}_point_${pointIndex}_y`);
    });
    finite(observation.elevation_ft, `${id}_elevation_ft`);
    const sizePolicy = ductSizePolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(sizePolicy)) {
      throw new Error(`${id}_duct_size_policy_invalid`);
    }
    if (sizePolicy === "explicit_required") {
      requiredText(observation.duct_size, `${id}_duct_size`);
    } else {
      if (clean(observation.duct_size)) throw new Error(`${id}_unresolved_placeholder_must_omit_duct_size`);
      if (observation.supported_attributes.some((attribute) => normalized(attribute) === "size")) {
        throw new Error(`${id}_unresolved_duct_size_cannot_claim_size_support`);
      }
    }
    requiredText(observation.duct_type, `${id}_duct_type`);
    if (observation.duct_type_id != null) positiveInteger(observation.duct_type_id, `${id}_duct_type_id`);
    const typePolicy = routeTypePolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(typePolicy)) {
      throw new Error(`${id}_type_policy_invalid`);
    }
    if (typePolicy === "unresolved_placeholder"
      && observation.supported_attributes.some((attribute) => normalized(attribute) === "type")) {
      throw new Error(`${id}_unresolved_type_cannot_claim_type_support`);
    }
    const systemPolicy = routeSystemClassificationPolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(systemPolicy)) {
      throw new Error(`${id}_system_classification_policy_invalid`);
    }
    if (observation.service === "unclassified") {
      if (systemPolicy !== "unresolved_placeholder") {
        throw new Error(`${id}_unclassified_route_requires_unresolved_system_placeholder`);
      }
      if (observation.supported_attributes.some((attribute) => normalized(attribute) === "system")) {
        throw new Error(`${id}_unclassified_route_cannot_claim_system_support`);
      }
      if (observation.connect_to_existing === true || observation.require_existing_endpoint_connections === true) {
        throw new Error(`${id}_unclassified_route_cannot_connect_to_existing`);
      }
    } else if (systemPolicy !== "explicit_required") {
      throw new Error(`${id}_classified_route_requires_explicit_system`);
    }
    requiredText(observation.system_type, `${id}_system_type`);
    if (routeWorksetName(observation)) requiredText(routeWorksetName(observation), `${id}_workset_name`);
    if (observation.require_existing_endpoint_connections && !observation.connect_to_existing) {
      throw new Error(`${id}_required_endpoint_connections_need_connect_to_existing`);
    }
    if ((sizePolicy === "unresolved_placeholder" || typePolicy === "unresolved_placeholder")
      && (observation.connect_to_existing === true || observation.require_existing_endpoint_connections === true)) {
      throw new Error(`${id}_provisional_duct_attributes_cannot_connect_to_existing`);
    }
    return;
  }
  if (observation.kind === "conduit_route") {
    if (!Array.isArray(observation.points) || observation.points.length < 2) throw new Error(`${id}_requires_at_least_two_points`);
    observation.points.forEach((entry, pointIndex) => {
      finite(entry.x, `${id}_point_${pointIndex}_x`);
      finite(entry.y, `${id}_point_${pointIndex}_y`);
    });
    finite(observation.elevation_ft, `${id}_elevation_ft`);
    const sizePolicy = conduitSizePolicy(observation);
    if (!['explicit_required', 'unresolved_placeholder'].includes(sizePolicy)) {
      throw new Error(`${id}_conduit_size_policy_invalid`);
    }
    if (sizePolicy === "explicit_required") {
      requiredText(observation.conduit_size, `${id}_conduit_size`);
    } else {
      if (clean(observation.conduit_size)) throw new Error(`${id}_unresolved_placeholder_must_omit_conduit_size`);
      if (observation.supported_attributes.some((attribute) => normalized(attribute) === "size")) {
        throw new Error(`${id}_unresolved_placeholder_cannot_claim_size_support`);
      }
    }
    if (observation.service === "unclassified"
      && observation.supported_attributes.some((attribute) => normalized(attribute) === "system")) {
      throw new Error(`${id}_unclassified_conduit_cannot_claim_system_support`);
    }
    requiredText(observation.conduit_type, `${id}_conduit_type`);
    const typePolicy = routeTypePolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(typePolicy)) {
      throw new Error(`${id}_type_policy_invalid`);
    }
    if (typePolicy === "unresolved_placeholder"
      && observation.supported_attributes.some((attribute) => normalized(attribute) === "type")) {
      throw new Error(`${id}_unresolved_type_cannot_claim_type_support`);
    }
    if (routeWorksetName(observation)) requiredText(routeWorksetName(observation), `${id}_workset_name`);
    if (observation.conduit_type_id != null) positiveInteger(observation.conduit_type_id, `${id}_conduit_type_id`);
    if (observation.require_existing_endpoint_connections && !observation.connect_to_existing) {
      throw new Error(`${id}_required_endpoint_connections_need_connect_to_existing`);
    }
    if ((sizePolicy === "unresolved_placeholder" || typePolicy === "unresolved_placeholder")
      && (observation.connect_to_existing === true || observation.require_existing_endpoint_connections === true)) {
      throw new Error(`${id}_provisional_conduit_attributes_cannot_connect_to_existing`);
    }
    return;
  }
  if (observation.kind === "pipe_route") {
    const plumbingServices = ["domestic_cold_water", "domestic_hot_water", "domestic_hot_water_return", "sanitary", "vent", "unclassified"];
    const mechanicalServices = [
      "heating_hot_water_supply",
      "heating_hot_water_return",
      "chilled_water_supply",
      "chilled_water_return",
      "condenser_water_supply",
      "condenser_water_return",
      "unclassified"
    ];
    if (observation.discipline === "plumbing" && !plumbingServices.includes(observation.service)) {
      throw new Error(`${id}_plumbing_pipe_service_invalid`);
    }
    if (observation.discipline === "mechanical" && !mechanicalServices.includes(observation.service)) {
      throw new Error(`${id}_mechanical_pipe_service_invalid`);
    }
    if (observation.discipline === "mechanical" && observation.geometry_mode !== undefined
      && observation.geometry_mode !== "source_points") {
      throw new Error(`${id}_mechanical_pipe_geometry_mode_invalid`);
    }
    const systemPolicy = routeSystemClassificationPolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(systemPolicy)) {
      throw new Error(`${id}_system_classification_policy_invalid`);
    }
    if (observation.service === "unclassified") {
      if (observation.geometry_mode !== undefined && observation.geometry_mode !== "source_points") {
        throw new Error(`${id}_unclassified_route_requires_source_points`);
      }
      if (systemPolicy !== "unresolved_placeholder") {
        throw new Error(`${id}_unclassified_route_requires_unresolved_system_placeholder`);
      }
      if (observation.supported_attributes.some((attribute) => normalized(attribute) === "system")) {
        throw new Error(`${id}_unclassified_route_cannot_claim_system_support`);
      }
      if (observation.connect_to_existing === true || observation.require_existing_endpoint_connections === true) {
        throw new Error(`${id}_unclassified_route_cannot_connect_to_existing`);
      }
    } else if (systemPolicy !== "explicit_required") {
      throw new Error(`${id}_classified_route_requires_explicit_system`);
    }
    const sizePolicy = pipeSizePolicy(observation);
    if (!['explicit_required', 'unresolved_placeholder'].includes(sizePolicy)) {
      throw new Error(`${id}_pipe_size_policy_invalid`);
    }
    if (sizePolicy === "explicit_required") {
      requiredText(observation.pipe_size, `${id}_pipe_size`);
    } else {
      if (clean(observation.pipe_size)) throw new Error(`${id}_unresolved_placeholder_must_omit_pipe_size`);
      if (observation.supported_attributes.some((attribute) => normalized(attribute) === "size")) {
        throw new Error(`${id}_unresolved_placeholder_cannot_claim_size_support`);
      }
      if (observation.geometry_mode === "native_connector_bridge"
        || observation.geometry_mode === "created_route_connector_bridge") {
        throw new Error(`${id}_connector_bridge_requires_explicit_pipe_size`);
      }
    }
    requiredText(observation.pipe_type, `${id}_pipe_type`);
    const typePolicy = routeTypePolicy(observation);
    if (!["explicit_required", "unresolved_placeholder"].includes(typePolicy)) {
      throw new Error(`${id}_type_policy_invalid`);
    }
    if (typePolicy === "unresolved_placeholder"
      && observation.supported_attributes.some((attribute) => normalized(attribute) === "type")) {
      throw new Error(`${id}_unresolved_type_cannot_claim_type_support`);
    }
    if (typePolicy === "unresolved_placeholder") {
      if (observation.geometry_mode != null && observation.geometry_mode !== "source_points") {
        throw new Error(`${id}_unresolved_type_requires_source_points_geometry`);
      }
      if (observation.connect_to_existing === true || observation.require_existing_endpoint_connections === true) {
        throw new Error(`${id}_provisional_pipe_type_cannot_connect_to_existing`);
      }
    }
    requiredText(observation.system_type, `${id}_system_type`);
    if (routeWorksetName(observation)) requiredText(routeWorksetName(observation), `${id}_workset_name`);
    if (observation.geometry_mode === "native_connector_bridge"
      || observation.geometry_mode === "created_route_connector_bridge") {
      requiredText(observation.source_fixture_observation_id, `${id}_source_fixture_observation_id`);
      if (observation.geometry_mode === "native_connector_bridge") {
        requiredText(observation.target_reference_key, `${id}_target_reference_key`);
      } else {
        requiredText(observation.target_route_observation_id, `${id}_target_route_observation_id`);
        if (observation.target_route_endpoint !== "start" && observation.target_route_endpoint !== "end") {
          throw new Error(`${id}_target_route_endpoint_invalid`);
        }
      }
      const maximumLength = observation.maximum_length_ft == null ? 5 : finite(observation.maximum_length_ft, `${id}_maximum_length_ft`);
      if (maximumLength <= 0 || maximumLength > 100) throw new Error(`${id}_maximum_length_ft_out_of_range`);
      const sizeTolerance = observation.size_tolerance_ft == null ? 1 / 192 : finite(observation.size_tolerance_ft, `${id}_size_tolerance_ft`);
      if (sizeTolerance < 0 || sizeTolerance > 0.25) throw new Error(`${id}_size_tolerance_ft_out_of_range`);
      const provenance = new Map((observation.attribute_provenance ?? []).map((entry) => [normalized(entry.attribute), entry]));
      for (const attribute of ["location", "elevation"]) {
        if (provenance.get(attribute)?.basis !== "native_model_precedent") {
          throw new Error(`${id}_${attribute}_must_be_native_model_precedent_for_connector_bridge`);
        }
      }
    } else {
      if (!Array.isArray(observation.points) || observation.points.length < 2) throw new Error(`${id}_requires_at_least_two_points`);
      observation.points.forEach((entry, pointIndex) => {
        finite(entry.x, `${id}_point_${pointIndex}_x`);
        finite(entry.y, `${id}_point_${pointIndex}_y`);
      });
      finite(observation.elevation_ft, `${id}_elevation_ft`);
      if (observation.geometry_mode === "downstream_vent_tee") {
        const mainReferenceKey = clean(observation.main_reference_key);
        const mainRouteObservationId = clean(observation.main_route_observation_id);
        if ((mainReferenceKey ? 1 : 0) + (mainRouteObservationId ? 1 : 0) !== 1) {
          throw new Error(`${id}_requires_exactly_one_main_reference`);
        }
        const fixtureReferenceKeys = observation.verification_fixture_reference_keys ?? [];
        const fixtureObservationIds = observation.verification_fixture_observation_ids ?? [];
        if (!Array.isArray(fixtureReferenceKeys) || !Array.isArray(fixtureObservationIds)
          || fixtureReferenceKeys.length + fixtureObservationIds.length === 0) {
          throw new Error(`${id}_verification_fixtures_are_required`);
        }
        fixtureReferenceKeys.forEach((key, fixtureIndex) =>
          requiredText(key, `${id}_verification_fixture_reference_${fixtureIndex}`));
        fixtureObservationIds.forEach((fixtureId, fixtureIndex) =>
          requiredText(fixtureId, `${id}_verification_fixture_observation_${fixtureIndex}`));
        if (new Set(fixtureReferenceKeys).size !== fixtureReferenceKeys.length) {
          throw new Error(`${id}_verification_fixture_reference_keys_must_be_unique`);
        }
        if (new Set(fixtureObservationIds).size !== fixtureObservationIds.length) {
          throw new Error(`${id}_verification_fixture_observation_ids_must_be_unique`);
        }
        const maximum = observation.max_vent_search_elements == null ? 10000 : positiveInteger(observation.max_vent_search_elements, `${id}_max_vent_search_elements`);
        if (maximum > 10000) throw new Error(`${id}_max_vent_search_elements_out_of_range`);
        const hops = observation.max_vent_search_hops == null ? 500 : positiveInteger(observation.max_vent_search_hops, `${id}_max_vent_search_hops`);
        if (hops > 500) throw new Error(`${id}_max_vent_search_hops_out_of_range`);
        if (normalized(observation.system_type) !== "vent") throw new Error(`${id}_system_type_must_be_vent`);
        const provenance = new Map((observation.attribute_provenance ?? []).map((entry) => [normalized(entry.attribute), entry]));
        if (mainReferenceKey) {
          finite(observation.main_elevation_ft, `${id}_main_elevation_ft`);
          if (provenance.get("main elevation")?.basis !== "native_model_precedent") {
            throw new Error(`${id}_main_elevation_must_be_native_model_precedent`);
          }
        } else if (provenance.has("main elevation")) {
          throw new Error(`${id}_planned_main_must_inherit_route_elevation`);
        }
      } else if (observation.geometry_mode === "source_branch_tee") {
        requiredText(observation.main_route_observation_id, `${id}_main_route_observation_id`);
        requiredText(observation.tee_family_name, `${id}_tee_family_name`);
        requiredText(observation.tee_type_name, `${id}_tee_type_name`);
        if ("connect_to_existing" in observation || "require_existing_endpoint_connections" in observation) {
          throw new Error(`${id}_source_branch_cannot_request_existing_endpoint_connections`);
        }
      } else if (observation.require_existing_endpoint_connections && !observation.connect_to_existing) {
        throw new Error(`${id}_required_endpoint_connections_need_connect_to_existing`);
      }
    }
    return;
  }
  if (observation.kind === "mechanical_equipment" || observation.kind === "air_terminal"
    || observation.kind === "plumbing_fixture" || observation.kind === "electrical_device" || observation.kind === "light_fixture" || observation.kind === "electrical_equipment") {
    requiredText(observation.role, `${id}_role`);
    finite(observation.point.x, `${id}_point_x`);
    finite(observation.point.y, `${id}_point_y`);
    validatePlacement(observation.placement, id);
    if (observation.placement.mode === "provisional_plan_symbol") {
      if (observation.elevation_ft != null) finite(observation.elevation_ft, `${id}_elevation_ft`);
      const viewReference = nativeReferences.get(observation.placement.view_reference_key);
      if (!viewReference) throw new Error(`${id}_provisional_view_reference_unknown`);
      if (!new Set(["view", "ost views"]).has(normalized(viewReference.category))) {
        throw new Error(`${id}_provisional_view_reference_category_mismatch`);
      }
      const provisionalAttributes = observation.supported_attributes.map(normalized);
      const allowedProvisionalAttributes = new Set([
        "location",
        "provisional plan representation",
        "symbol form",
        "host direction"
      ]);
      const forbiddenProvisionalAttributes = provisionalAttributes.filter(
        (attribute) => !allowedProvisionalAttributes.has(attribute)
      );
      if (forbiddenProvisionalAttributes.length > 0) {
        throw new Error(`${id}_provisional_plan_symbol_forbidden_supported_attributes:${forbiddenProvisionalAttributes.join(",")}`);
      }
      if (!provisionalAttributes.includes("provisional plan representation")) {
        throw new Error(`${id}_provisional_plan_representation_support_required`);
      }
      if (!provisionalAttributes.includes("symbol form")) {
        throw new Error(`${id}_provisional_symbol_form_support_required`);
      }
      if (observation.placement.host_direction !== "unresolved"
        && !provisionalAttributes.includes("host direction")) {
        throw new Error(`${id}_provisional_host_direction_support_required`);
      }
      if (observation.placement.host_direction === "unresolved"
        && provisionalAttributes.includes("host direction")) {
        throw new Error(`${id}_unresolved_host_direction_cannot_claim_support`);
      }
      if (observation.kind === "air_terminal" && observation.airflow_cfm != null) {
        throw new Error(`${id}_provisional_plan_symbol_cannot_set_airflow`);
      }
      if ((observation.kind === "air_terminal" || observation.kind === "light_fixture")
        && routeWorksetName(observation)) {
        throw new Error(`${id}_provisional_plan_symbol_cannot_set_workset`);
      }
      if (observation.kind === "electrical_equipment" && observation.panel_name != null) {
        throw new Error(`${id}_provisional_plan_symbol_cannot_set_panel_name`);
      }
    } else {
      finite(observation.elevation_ft, `${id}_elevation_ft`);
    }
    if (observation.kind === "air_terminal") {
      if (observation.airflow_cfm != null) {
        const airflow = finite(observation.airflow_cfm, `${id}_airflow_cfm`);
        if (airflow <= 0) throw new Error(`${id}_airflow_cfm_must_be_positive`);
        if (observation.placement.mode === "hosted_exemplar") {
          throw new Error(`${id}_airflow_cfm_cannot_override_hosted_exemplar`);
        }
      }
      if (routeWorksetName(observation)) {
        requiredText(routeWorksetName(observation), `${id}_workset_name`);
        if (observation.placement.mode === "hosted_exemplar" || observation.placement.mode === "hosted_family_symbol") {
          throw new Error(`${id}_workset_name_requires_place_families_mode`);
        }
      }
    }
    if (observation.kind === "light_fixture" && routeWorksetName(observation)) {
      requiredText(routeWorksetName(observation), `${id}_workset_name`);
      if (observation.placement.mode !== "unhosted_family") {
        throw new Error(`${id}_workset_name_requires_place_families_mode`);
      }
    }
    if (observation.kind === "electrical_equipment" && observation.panel_name != null) {
      requiredText(observation.panel_name, `${id}_panel_name`);
      const supported = new Set(observation.supported_attributes.map(normalized));
      const provenance = new Map((observation.attribute_provenance ?? []).map((entry) => [normalized(entry.attribute), entry]));
      if (!supported.has("panel name")) throw new Error(`${id}_panel_name_requires_supported_attribute`);
      const panelNameEvidence = provenance.get("panel name");
      if (!panelNameEvidence || panelNameEvidence.basis === "declared_heuristic") {
        throw new Error(`${id}_panel_name_requires_source_or_directed_evidence`);
      }
    }
    if (observation.kind === "electrical_device" && observation.instance_parameters != null) {
      if (observation.placement.mode === "provisional_plan_symbol") {
        throw new Error(`${id}_provisional_plan_symbol_cannot_set_instance_parameters`);
      }
      if (typeof observation.instance_parameters !== "object" || Array.isArray(observation.instance_parameters)) {
        throw new Error(`${id}_instance_parameters_must_be_object`);
      }
      const entries = Object.entries(observation.instance_parameters);
      if (entries.length === 0 || entries.length > 16) throw new Error(`${id}_instance_parameters_count_out_of_range`);
      for (const [parameterName, parameterValue] of entries) {
        const name = requiredText(parameterName, `${id}_instance_parameter_name`);
        if (name.length > 128) throw new Error(`${id}_instance_parameter_name_too_long`);
        if (isCircuitMembershipParameterName(name)) {
          throw new Error(`${id}_instance_parameter_cannot_assert_circuit_membership:${name}`);
        }
        if (typeof parameterValue !== "string" || parameterValue.length > 512) {
          throw new Error(`${id}_instance_parameter_value_invalid:${name}`);
        }
      }
      const supported = new Set(observation.supported_attributes.map(normalized));
      const provenance = new Map((observation.attribute_provenance ?? []).map((entry) => [normalized(entry.attribute), entry]));
      if (!supported.has("instance parameters")) throw new Error(`${id}_instance_parameters_require_supported_attribute`);
      const parameterEvidence = provenance.get("instance parameters");
      if (!parameterEvidence || parameterEvidence.basis === "declared_heuristic") {
        throw new Error(`${id}_instance_parameters_require_source_or_directed_evidence`);
      }
    }
    if ((observation.placement.mode === "hosted_exemplar" || observation.placement.mode === "hosted_family_symbol")
      && observation.placement.require_room_membership_validation === false) {
      const supported = new Set(observation.supported_attributes.map(normalized));
      const provenance = new Map((observation.attribute_provenance ?? []).map((entry) => [normalized(entry.attribute), entry]));
      if (!supported.has("spatial membership")) {
        throw new Error(`${id}_adjacent_scope_requires_spatial_membership_support`);
      }
      const spatialEvidence = provenance.get("spatial membership");
      if (!spatialEvidence || spatialEvidence.basis === "declared_heuristic") {
        throw new Error(`${id}_adjacent_scope_requires_source_or_directed_spatial_membership_evidence`);
      }
    }
    if ((observation.placement.mode === "created_route_host" || observation.placement.mode === "created_route_branch")
      && observation.kind !== "air_terminal") {
      throw new Error(`${id}_${observation.placement.mode}_requires_air_terminal`);
    }
    if (observation.placement.mode === "hosted_exemplar"
      && observation.placement.copy_distribution_system_from_source !== undefined
      && observation.kind !== "electrical_equipment") {
      throw new Error(`${id}_distribution_system_copy_requires_electrical_equipment`);
    }
    if (observation.kind === "plumbing_fixture") {
      const classification = observation.representation_classification;
      if (!classification || typeof classification !== "object") {
        throw new Error(`${id}_representation_classification_is_required`);
      }
      if (!["architectural_fixture", "mep_connection_symbol", "combined_fixture_and_connection", "unresolved"].includes(classification.source_graphic)) {
        throw new Error(`${id}_source_graphic_classification_invalid`);
      }
      if (!["architectural_fixture", "mep_connection", "plan_only_marker"].includes(classification.native_target)) {
        throw new Error(`${id}_native_target_classification_invalid`);
      }
      if (!["source_observation", "user_direction"].includes(classification.basis)) {
        throw new Error(`${id}_representation_classification_basis_invalid`);
      }
      requiredText(classification.evidence_role, `${id}_representation_classification_evidence_role`);
      requiredText(classification.reference, `${id}_representation_classification_reference`);
      if (!Array.isArray(observation.service_route_connections)) {
        throw new Error(`${id}_service_route_connections_must_be_array`);
      }
      const planOnlyMarker = classification.native_target === "plan_only_marker";
      if (planOnlyMarker) {
        if (observation.placement.mode !== "provisional_plan_symbol") {
          throw new Error(`${id}_plan_only_marker_requires_provisional_plan_symbol`);
        }
        if (classification.basis !== "source_observation") {
          throw new Error(`${id}_plan_only_marker_requires_source_observation_basis`);
        }
        const classificationEvidenceRole = normalized(classification.evidence_role);
        if ([...nativeReferences.values()].some((reference) =>
          normalized(reference.evidence_role) === classificationEvidenceRole)) {
          throw new Error(`${id}_plan_only_marker_requires_source_visible_evidence`);
        }
        if (classification.source_graphic !== "mep_connection_symbol") {
          throw new Error(`${id}_plan_only_marker_requires_mep_connection_symbol`);
        }
        if (classification.native_target_evidence != null) {
          throw new Error(`${id}_plan_only_marker_cannot_claim_native_target_evidence`);
        }
        if (observation.service_connection_mode != null
          || observation.service_route_connections.length > 0
          || observation.service_boundary != null) {
          throw new Error(`${id}_plan_only_marker_cannot_claim_service_topology`);
        }
      } else {
        if (observation.placement.mode === "provisional_plan_symbol") {
          throw new Error(`${id}_provisional_plumbing_symbol_requires_plan_only_marker`);
        }
        const targetEvidence = classification.native_target_evidence;
        if (!targetEvidence || typeof targetEvidence !== "object") {
          throw new Error(`${id}_native_target_evidence_is_required`);
        }
        if (!["native_model_precedent", "user_direction"].includes(targetEvidence.basis)) {
          throw new Error(`${id}_native_target_evidence_basis_invalid`);
        }
        requiredText(targetEvidence.evidence_role, `${id}_native_target_evidence_role`);
        requiredText(targetEvidence.reference, `${id}_native_target_evidence_reference`);
        const targetFamily = requiredText(targetEvidence.family_name, `${id}_native_target_family_name`);
        const targetType = requiredText(targetEvidence.type_name, `${id}_native_target_type_name`);
        if (observation.placement.mode === "hosted_exemplar") {
          throw new Error(`${id}_plumbing_fixture_hosted_exemplar_cannot_bind_target_family`);
        }
        if (observation.placement.mode !== "unhosted_family" && observation.placement.mode !== "hosted_family_symbol") {
          throw new Error(`${id}_plumbing_fixture_placement_mode_invalid`);
        }
        if (targetFamily !== clean(observation.placement.family_name)
          || targetType !== clean(observation.placement.type_name)) {
          throw new Error(`${id}_native_target_family_type_mismatch`);
        }
        if (classification.source_graphic === "unresolved") {
          throw new Error(`${id}_source_graphic_unresolved_no_native_placement`);
        }
        if (classification.source_graphic === "architectural_fixture" && classification.native_target !== "architectural_fixture") {
          throw new Error(`${id}_architectural_fixture_cannot_create_mep_connection`);
        }
        if (classification.source_graphic === "mep_connection_symbol" && classification.native_target !== "mep_connection") {
          throw new Error(`${id}_mep_connection_symbol_cannot_create_architectural_fixture`);
        }
      }
      observation.service_route_connections.forEach((connection, connectionIndex) => {
        requiredText(connection.route_observation_id, `${id}_service_route_connection_${connectionIndex}_route_observation_id`);
        if (connection.route_endpoint !== "start" && connection.route_endpoint !== "end"
          && connection.route_endpoint !== "native_source" && connection.route_endpoint !== "nearest_plan_segment") {
          throw new Error(`${id}_service_route_connection_${connectionIndex}_route_endpoint_invalid`);
        }
        if (connection.maximum_plan_distance_ft != null) {
          const maximum = finite(connection.maximum_plan_distance_ft, `${id}_service_route_connection_${connectionIndex}_maximum_plan_distance_ft`);
          if (maximum <= 0 || maximum > 25) throw new Error(`${id}_service_route_connection_${connectionIndex}_maximum_plan_distance_ft_out_of_range`);
        }
      });
    }
    return;
  }
  if (!Array.isArray(observation.member_observation_ids)) {
    throw new Error(`${id}_member_observation_ids_are_required`);
  }
  if (!Array.isArray(observation.native_member_reference_keys ?? [])) {
    throw new Error(`${id}_native_member_reference_keys_must_be_array`);
  }
  if (observation.member_observation_ids.length === 0 && (observation.native_member_reference_keys ?? []).length === 0) {
    throw new Error(`${id}_electrical_members_are_required`);
  }
  if (observation.circuit_mode === "create_new_power_system") {
    if (observation.system_type !== "PowerCircuit") throw new Error(`${id}_system_type_must_be_power_circuit`);
    requiredText(observation.panel_circuit_label, `${id}_panel_circuit_label`);
    if (observation.membership_basis === "legible_source_circuit_label") {
      const evidence = observation.member_label_evidence ?? [];
      if (evidence.length !== observation.member_observation_ids.length) {
        throw new Error(`${id}_member_label_evidence_must_cover_every_member`);
      }
      const memberSet = new Set(observation.member_observation_ids);
      const evidenceMembers = evidence.map((entry, index) => {
        const memberId = requiredText(entry.member_observation_id, `${id}_member_label_evidence_${index}_member_observation_id`);
        if (!memberSet.has(memberId)) throw new Error(`${id}_member_label_evidence_unknown_member:${memberId}`);
        requiredText(entry.evidence_role, `${id}_member_label_evidence_${index}_evidence_role`);
        requiredText(entry.reference, `${id}_member_label_evidence_${index}_reference`);
        const label = requiredText(entry.label, `${id}_member_label_evidence_${index}_label`);
        if (normalized(label) !== normalized(observation.panel_circuit_label)) {
          throw new Error(`${id}_member_label_evidence_label_mismatch:${memberId}`);
        }
        return memberId;
      });
      if (new Set(evidenceMembers).size !== evidenceMembers.length) {
        throw new Error(`${id}_member_label_evidence_members_must_be_unique`);
      }
      const nativeEvidence = observation.native_member_label_evidence ?? [];
      const nativeMembers = observation.native_member_reference_keys ?? [];
      if (nativeEvidence.length !== nativeMembers.length) {
        throw new Error(`${id}_native_member_label_evidence_must_cover_every_member`);
      }
      const nativeMemberSet = new Set(nativeMembers);
      const nativeEvidenceMembers = nativeEvidence.map((entry, index) => {
        const referenceKey = requiredText(entry.native_member_reference_key, `${id}_native_member_label_evidence_${index}_reference_key`);
        if (!nativeMemberSet.has(referenceKey)) throw new Error(`${id}_native_member_label_evidence_unknown_member:${referenceKey}`);
        requiredText(entry.evidence_role, `${id}_native_member_label_evidence_${index}_evidence_role`);
        requiredText(entry.reference, `${id}_native_member_label_evidence_${index}_reference`);
        const label = requiredText(entry.label, `${id}_native_member_label_evidence_${index}_label`);
        if (normalized(label) !== normalized(observation.panel_circuit_label)) {
          throw new Error(`${id}_native_member_label_evidence_label_mismatch:${referenceKey}`);
        }
        return referenceKey;
      });
      if (new Set(nativeEvidenceMembers).size !== nativeEvidenceMembers.length) {
        throw new Error(`${id}_native_member_label_evidence_members_must_be_unique`);
      }
    } else if (observation.membership_basis === "user_direction") {
      requiredText(observation.user_direction_reference, `${id}_user_direction_reference`);
      if ((observation.member_label_evidence ?? []).length > 0) {
        throw new Error(`${id}_user_direction_cannot_claim_member_label_evidence`);
      }
      if ((observation.native_member_label_evidence ?? []).length > 0) {
        throw new Error(`${id}_user_direction_cannot_claim_native_member_label_evidence`);
      }
    } else {
      throw new Error(`${id}_new_circuit_membership_basis_invalid`);
    }
    return;
  }
  requiredText(observation.source_reference_key, `${id}_source_reference_key`);
  requiredText(observation.expected_power_system_id, `${id}_expected_power_system_id`);
  if (observation.membership_basis !== "native_source_power_system") {
    throw new Error(`${id}_membership_basis_must_be_native_source_power_system`);
  }
}

function pointAction(
  observation: MechanicalEquipmentObservation | AirTerminalObservation | PlumbingFixtureObservation | ElectricalDeviceObservation | LightFixtureObservation | ElectricalEquipmentObservation,
  registration: ExistingConditionsRegistrationReceipt,
  transformed: ExistingConditionsPlanPoint,
  levelName: string,
  levelElevationFt: number,
  roomNumber: string | undefined,
  nativeReferences: Map<string, MepDraftPackage["native_element_references"][number]>
): MepDraftAction {
  const actionKey = `place:${observation.observation_id}`;
  const expected = {
    ...transformed,
    z: observation.placement.mode === "provisional_plan_symbol"
      ? levelElevationFt
      : levelElevationFt + observation.elevation_ft!
  };
  const airTerminalParameters = observation.kind === "air_terminal" && observation.airflow_cfm != null
    ? { Flow: String(observation.airflow_cfm / 60) }
    : undefined;
  const electricalDeviceParameters = observation.kind === "electrical_device"
    ? observation.instance_parameters
    : undefined;
  if (observation.placement.mode === "provisional_plan_symbol") {
    const viewReference = nativeReferences.get(observation.placement.view_reference_key)!;
    const radius = observation.placement.radius_ft ?? 0.25;
    const stemLength = observation.placement.stem_length_ft
      ?? (observation.placement.host_direction === "unresolved" ? 0 : 0.5);
    const xyz = (x: number, y: number): JsonMap => ({ xyz: [x, y, expected.z] });
    const left = xyz(expected.x - radius, expected.y);
    const right = xyz(expected.x + radius, expected.y);
    const top = xyz(expected.x, expected.y + radius);
    const bottom = xyz(expected.x, expected.y - radius);
    const topLeft = xyz(expected.x - radius, expected.y + radius);
    const topRight = xyz(expected.x + radius, expected.y + radius);
    const bottomLeft = xyz(expected.x - radius, expected.y - radius);
    const bottomRight = xyz(expected.x + radius, expected.y - radius);
    const symbolForm = observation.placement.symbol_form;
    const curves: JsonMap[] = symbolForm === "hollow_circle"
      || symbolForm === "filled_circle"
      || symbolForm === "unclassified_circle"
      ? [
          { kind: "arc", a: left, b: right, c: top },
          { kind: "arc", a: right, b: left, c: bottom }
        ]
      : symbolForm === "square" || symbolForm === "square_with_x"
        ? [
            { kind: "line", a: topLeft, b: topRight },
            { kind: "line", a: topRight, b: bottomRight },
            { kind: "line", a: bottomRight, b: bottomLeft },
            { kind: "line", a: bottomLeft, b: topLeft }
          ]
        : symbolForm === "x_mark"
          ? [
              { kind: "line", a: bottomLeft, b: topRight },
              { kind: "line", a: topLeft, b: bottomRight }
            ]
          : symbolForm === "cross"
            ? [
                { kind: "line", a: left, b: right },
                { kind: "line", a: bottom, b: top }
              ]
            : symbolForm === "triangle"
              ? [
                  { kind: "line", a: top, b: bottomRight },
                  { kind: "line", a: bottomRight, b: bottomLeft },
                  { kind: "line", a: bottomLeft, b: top }
                ]
              : [
                  { kind: "line", a: top, b: right },
                  { kind: "line", a: right, b: bottom },
                  { kind: "line", a: bottom, b: left },
                  { kind: "line", a: left, b: top }
                ];
    if (symbolForm === "square_with_x") {
      curves.push(
        { kind: "line", a: bottomLeft, b: topRight },
        { kind: "line", a: topLeft, b: bottomRight }
      );
    }
    if (stemLength > 0 && observation.placement.host_direction !== "unresolved") {
      const sourceDirection = {
        left: { x: -1, y: 0 },
        right: { x: 1, y: 0 },
        up: { x: 0, y: 1 },
        down: { x: 0, y: -1 }
      }[observation.placement.host_direction];
      const transformedDirectionPoint = transformExistingConditionsPlanPoint(registration, {
        x: observation.point.x + sourceDirection.x,
        y: observation.point.y + sourceDirection.y
      });
      const directionLength = Math.hypot(
        transformedDirectionPoint.x - transformed.x,
        transformedDirectionPoint.y - transformed.y
      );
      if (directionLength <= 1e-9) {
        throw new Error(`${observation.observation_id}_provisional_host_direction_transform_degenerate`);
      }
      const direction = {
        x: (transformedDirectionPoint.x - transformed.x) / directionLength,
        y: (transformedDirectionPoint.y - transformed.y) / directionLength
      };
      curves.push({
        kind: "line",
        a: xyz(expected.x + direction.x * radius, expected.y + direction.y * radius),
        b: xyz(expected.x + direction.x * (radius + stemLength), expected.y + direction.y * (radius + stemLength))
      });
    }
    if (observation.placement.symbol_form === "filled_circle") {
      for (const offsetRatio of [-0.8, -0.6, -0.4, -0.2, 0, 0.2, 0.4, 0.6, 0.8]) {
        const yOffset = radius * offsetRatio;
        const halfChord = Math.sqrt(Math.max(0, radius * radius - yOffset * yOffset));
        curves.push({
          kind: "line",
          a: xyz(expected.x - halfChord, expected.y + yOffset),
          b: xyz(expected.x + halfChord, expected.y + yOffset)
        });
      }
    } else if (observation.placement.symbol_form === "unclassified_circle") {
      curves.push({
        kind: "line",
        a: xyz(expected.x - radius * 0.7, expected.y - radius * 0.7),
        b: xyz(expected.x + radius * 0.7, expected.y + radius * 0.7)
      });
    }
    const common: JsonMap = {
      viewId: viewReference.element_id,
      expectedViewType: observation.placement.view_type,
      expectedLevelName: levelName,
      projectToViewPlane: true,
      curves
    };
    if (clean(observation.placement.line_style_name)) {
      common.lineStyleName = clean(observation.placement.line_style_name);
    }
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/draw-detail-curves",
      depends_on: [],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      expected_model_point: expected,
      expected_created_min: curves.length,
      expected_created_max: curves.length,
      provisional_plan_representation: {
        native_category: "OST_Lines",
        representation_role: "view_specific_plan_symbol_marker",
        source_observation_kind: observation.kind,
        modeled_element_created: false,
        modeled_device_created: false,
        benchmark_credit: false,
        complete_scope_credit: false
      }
    };
  }
  if (observation.placement.mode === "unhosted_family") {
    const instance: JsonMap = {
      x: transformed.x,
      y: transformed.y,
      z: expected.z,
      coordinateMode: "absolute_model"
    };
    if (observation.placement.rotation_degrees != null) instance.rotationDegrees = observation.placement.rotation_degrees;
    if (airTerminalParameters) instance.parameters = airTerminalParameters;
    if (electricalDeviceParameters) instance.parameters = electricalDeviceParameters;
    if (observation.kind === "electrical_equipment" && observation.panel_name) {
      instance.parameters = { "Panel Name": observation.panel_name };
    }
    const common: JsonMap = {
      levelName,
      familyName: observation.placement.family_name,
      symbolName: observation.placement.type_name,
      instances: [instance],
      idempotency: { enabled: true, toleranceFt: 0.05 },
      behavior: "allOrNothing"
    };
    if (observation.kind === "air_terminal" || observation.kind === "light_fixture") common.allowUnhostedWorkPlanePlacement = true;
    if ((observation.kind === "air_terminal" || observation.kind === "light_fixture") && observation.workset_name) common.worksetName = observation.workset_name;
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/place-families",
      depends_on: [],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      expected_model_point: expected,
      expected_created_min: 1,
      expected_created_max: 1
    };
  }
  if (observation.placement.mode === "created_route_host") {
    const instance: JsonMap = {
      x: transformed.x,
      y: transformed.y,
      z: expected.z,
      coordinateMode: "absolute_model"
    };
    if (observation.placement.rotation_degrees != null) instance.rotationDegrees = observation.placement.rotation_degrees;
    if (airTerminalParameters) instance.parameters = airTerminalParameters;
    const common: JsonMap = {
      levelName,
      familyName: observation.placement.family_name,
      symbolName: observation.placement.type_name,
      instances: [instance],
      idempotency: { enabled: true, toleranceFt: 0.05 },
      behavior: "allOrNothing"
    };
    if (observation.kind === "air_terminal" && observation.workset_name) common.worksetName = observation.workset_name;
    const routeActionKey = `route:${observation.placement.route_observation_id}`;
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/place-families",
      depends_on: [routeActionKey],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      deferred_body: {
        host_element: {
          created_by_action: routeActionKey,
          output: "route_segment",
          index: observation.placement.route_segment_index
        }
      },
      expected_model_point: expected,
      expected_created_min: 1,
      expected_created_max: 1
    };
  }
  if (observation.placement.mode === "created_route_branch") {
    const instance: JsonMap = {
      x: transformed.x,
      y: transformed.y,
      z: expected.z,
      coordinateMode: "absolute_model"
    };
    if (observation.placement.rotation_degrees != null) instance.rotationDegrees = observation.placement.rotation_degrees;
    if (airTerminalParameters) instance.parameters = airTerminalParameters;
    const common: JsonMap = {
      levelName,
      familyName: observation.placement.family_name,
      symbolName: observation.placement.type_name,
      instances: [instance],
      idempotency: { enabled: true, toleranceFt: 0.05 },
      behavior: "allOrNothing"
    };
    if (observation.kind === "air_terminal" && observation.workset_name) common.worksetName = observation.workset_name;
    const routeActionKey = `route:${observation.placement.route_observation_id}`;
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/place-families",
      depends_on: [routeActionKey],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false },
      expected_model_point: expected,
      expected_created_min: 1,
      expected_created_max: 1
    };
  }
  if (observation.placement.mode === "hosted_family_symbol") {
    const hostReference = nativeReferences.get(observation.placement.host_reference_key)!;
    const linkedHostReference = observation.placement.linked_host_reference_key
      ? nativeReferences.get(observation.placement.linked_host_reference_key)
      : undefined;
    const metadataSourceReference = observation.placement.metadata_source_reference_key
      ? nativeReferences.get(observation.placement.metadata_source_reference_key)
      : undefined;
    const orientationSourceReference = observation.placement.orientation_source_reference_key
      ? nativeReferences.get(observation.placement.orientation_source_reference_key)
      : undefined;
    const common: JsonMap = {
      familyName: observation.placement.family_name,
      symbolName: observation.placement.type_name,
      levelName,
      hostElementId: hostReference.element_id,
      pointXyz: [expected.x, expected.y, expected.z],
      matchOrientationFromSource: Boolean(orientationSourceReference),
      copyRotation: false,
      copyFacingHandState: false,
      includePreviewImage: true
    };
    if (linkedHostReference) {
      common.linkedHostElementId = linkedHostReference.element_id;
      common.linkedHostBuiltInCategory = linkedHostReference.category;
    }
    if (metadataSourceReference) {
      common.sourceElementId = metadataSourceReference.element_id;
      common.parameterNamesToCopy = ["Workset"];
    }
    if (orientationSourceReference) common.orientationSourceElementId = orientationSourceReference.element_id;
    if (roomNumber && observation.placement.require_room_membership_validation !== false) common.roomNumber = roomNumber;
    if (observation.placement.room_side) common.roomSide = observation.placement.room_side;
    if (observation.placement.ensure_distribution_system) {
      const definition = observation.placement.ensure_distribution_system;
      const voltage = (entry: NonNullable<typeof definition.voltage_line_to_line>): JsonMap => ({
        name: entry.name,
        actualValue: entry.actual_value,
        minValue: entry.min_value,
        maxValue: entry.max_value
      });
      common.ensureDistributionSystem = {
        name: definition.name,
        electricalPhase: definition.electrical_phase,
        phaseConfiguration: definition.phase_configuration,
        numWires: definition.num_wires,
        ...(definition.voltage_line_to_line ? { voltageLineToLine: voltage(definition.voltage_line_to_line) } : {}),
        ...(definition.voltage_line_to_ground ? { voltageLineToGround: voltage(definition.voltage_line_to_ground) } : {})
      };
    }
    if (observation.kind === "electrical_equipment" && observation.panel_name) {
      common.parameterOverrides = { "Panel Name": observation.panel_name };
    }
    if (airTerminalParameters) common.parameterOverrides = airTerminalParameters;
    if (electricalDeviceParameters) common.parameterOverrides = electricalDeviceParameters;
    return {
      action_key: actionKey,
      observation_ids: [observation.observation_id],
      method: "POST",
      path: "/revit/place-family-instance-on-host",
      depends_on: [],
      dry_run_body: { ...common, dryRun: true },
      apply_body: { ...common, dryRun: false, includePreviewImage: false },
      expected_model_point: expected,
      expected_created_min: 1,
      expected_created_max: 1
    };
  }
  const sourceReference = nativeReferences.get(observation.placement.source_reference_key)!;
  const hostReference = nativeReferences.get(observation.placement.host_reference_key)!;
  const matchOrientationFromSource = observation.placement.match_orientation_from_source !== false;
  const common: JsonMap = {
    sourceElementId: sourceReference.element_id,
    hostElementId: hostReference.element_id,
    pointXyz: [expected.x, expected.y, expected.z],
    orientationSourceElementId: sourceReference.element_id,
    matchOrientationFromSource,
    copyRotation: matchOrientationFromSource,
    copyFacingHandState: matchOrientationFromSource,
    includePreviewImage: true
  };
  if (observation.placement.target_chainage_ft != null) {
    common.targetChainageFt = observation.placement.target_chainage_ft;
  }
  if (roomNumber && observation.placement.require_room_membership_validation !== false) common.roomNumber = roomNumber;
  if (observation.placement.room_side) common.roomSide = observation.placement.room_side;
  if (observation.kind === "electrical_equipment" && observation.placement.copy_distribution_system_from_source === true) {
    common.parameterNamesToCopy = ["Distribution System"];
  }
  if (electricalDeviceParameters) common.parameterOverrides = electricalDeviceParameters;
  return {
    action_key: actionKey,
    observation_ids: [observation.observation_id],
    method: "POST",
    path: "/revit/place-family-instance-on-host",
    depends_on: [],
    dry_run_body: { ...common, dryRun: true },
    apply_body: { ...common, dryRun: false, includePreviewImage: false },
    expected_model_point: expected,
    expected_created_min: 1,
    expected_created_max: 1
  };
}

export function compileMepDraftPlan(input: MepDraftPackage): CompiledMepDraftPlan {
  if (input.schema_version !== 1) throw new Error("unsupported_mep_draft_package_schema_version");
  const fixtureId = requiredText(input.fixture_id, "fixture_id");
  const scopeId = requiredText(input.scope_id, "scope_id");
  const levelName = requiredText(input.level_name, "level_name");
  const levelElevationFt = finite(input.level_elevation_ft, "level_elevation_ft");
  const partialPromotionPolicy = input.partial_promotion_policy ?? "all_or_nothing";
  if (!["all_or_nothing", "defer_ambiguous_observations"].includes(partialPromotionPolicy)) {
    throw new Error("partial_promotion_policy_invalid");
  }
  if (!Array.isArray(input.visible_evidence) || input.visible_evidence.length === 0) throw new Error("visible_evidence_is_required");
  const visibleEvidence = input.visible_evidence.map((entry, index) => ({
    role: requiredText(entry.role, `visible_evidence_${index}_role`),
    sha256: requiredSha256(entry.sha256, `visible_evidence_${index}_sha256`)
  }));
  if (new Set(visibleEvidence.map((entry) => normalized(entry.role))).size !== visibleEvidence.length) {
    throw new Error("visible_evidence_roles_must_be_unique");
  }
  const visibleEvidenceByRole = new Map(visibleEvidence.map((entry) => [normalized(entry.role), entry.sha256]));
  const sourceEvidenceSha256 = requiredSha256(input.source_evidence_sha256, "source_evidence_sha256");
  if (visibleEvidenceByRole.get("source pdf") !== sourceEvidenceSha256) throw new Error("source_pdf_visible_evidence_hash_mismatch");
  if (!Array.isArray(input.native_element_references)) throw new Error("native_element_references_must_be_array");
  const nativeReferences = new Map<string, MepDraftPackage["native_element_references"][number]>();
  for (const [index, reference] of input.native_element_references.entries()) {
    const key = requiredText(reference.reference_key, `native_reference_${index}_key`);
    if (nativeReferences.has(key)) throw new Error(`native_reference_key_duplicate:${key}`);
    positiveInteger(reference.element_id, `${key}_element_id`);
    requiredText(reference.category, `${key}_category`);
    requiredText(reference.role, `${key}_role`);
    const evidenceRole = requiredText(reference.evidence_role, `${key}_evidence_role`);
    const evidenceSha256 = requiredSha256(reference.evidence_sha256, `${key}_evidence_sha256`);
    if (visibleEvidenceByRole.get(normalized(evidenceRole)) !== evidenceSha256) throw new Error(`${key}_native_evidence_hash_mismatch`);
    nativeReferences.set(key, { ...reference, reference_key: key, evidence_role: evidenceRole, evidence_sha256: evidenceSha256 });
  }
  if (!Array.isArray(input.observations) || input.observations.length === 0) throw new Error("observations_are_required");
  const registration = solveExistingConditionsRegistration(input.registration);
  if (registration.source_evidence_sha256 !== sourceEvidenceSha256) {
    throw new Error("registration_source_evidence_hash_mismatch");
  }
  input.observations.forEach((observation, index) => validateObservation(observation, index, nativeReferences));
  const provisionalObservationIds = input.observations
    .filter((observation) => (
      requiresProvisionalRouteCredit(observation)
      || ("placement" in observation && observation.placement.mode === "provisional_plan_symbol")
    ))
    .map((observation) => observation.observation_id);
  if (provisionalObservationIds.length > 0 && partialPromotionPolicy !== "defer_ambiguous_observations") {
    const hasPlanSymbol = input.observations.some((observation) =>
      "placement" in observation && observation.placement.mode === "provisional_plan_symbol");
    const hasUnresolvedSystem = input.observations.some((observation) =>
      (observation.kind === "pipe_route" || observation.kind === "duct_route")
      && routeSystemClassificationPolicy(observation) === "unresolved_placeholder");
    throw new Error(`${hasPlanSymbol
      ? "provisional_plan_symbol_requires_partial_promotion_policy"
      : hasUnresolvedSystem
        ? "unresolved_system_requires_partial_promotion_policy"
        : "provisional_route_attributes_require_partial_promotion_policy"}:${provisionalObservationIds.join(",")}`);
  }
  const ids = input.observations.map((entry) => entry.observation_id);
  if (new Set(ids).size !== ids.length) throw new Error("observation_ids_must_be_unique");
  const byId = new Map(input.observations.map((entry) => [entry.observation_id, entry]));
  const nativeEvidenceRoles = new Set(
    [...nativeReferences.values()].map((reference) => normalized(reference.evidence_role))
  );
  const claimedPipeEndpoints = new Map<string, string>();
  const assignedElectricalDevices = new Map<string, string>();
  for (const observation of input.observations) {
    const evidenceRole = clean(observation.evidence_role) || "source_pdf";
    const normalizedEvidenceRole = normalized(evidenceRole);
    if (!visibleEvidenceByRole.has(normalizedEvidenceRole)) {
      throw new Error(`${observation.observation_id}_references_unknown_visible_evidence_role:${evidenceRole}`);
    }
    if ("placement" in observation
      && observation.placement.mode === "provisional_plan_symbol"
      && nativeEvidenceRoles.has(normalizedEvidenceRole)) {
      throw new Error(`${observation.observation_id}_provisional_plan_symbol_requires_source_visible_evidence`);
    }
    if (observation.kind === "pipe_route" && (observation.geometry_mode === "native_connector_bridge"
      || observation.geometry_mode === "created_route_connector_bridge")) {
      const sourceFixture = byId.get(observation.source_fixture_observation_id);
      if (!sourceFixture || sourceFixture.kind !== "plumbing_fixture") {
        throw new Error(`${observation.observation_id}_references_unknown_source_fixture:${observation.source_fixture_observation_id}`);
      }
      if (observation.geometry_mode === "native_connector_bridge") {
        if (!nativeReferences.has(observation.target_reference_key)) {
          throw new Error(`${observation.observation_id}_target_reference_unknown:${observation.target_reference_key}`);
        }
      } else {
        const targetRoute = byId.get(observation.target_route_observation_id);
        if (!targetRoute || targetRoute.kind !== "pipe_route") {
          throw new Error(`${observation.observation_id}_target_route_observation_unknown:${observation.target_route_observation_id}`);
        }
        if (targetRoute.geometry_mode === "native_connector_bridge"
          || targetRoute.geometry_mode === "created_route_connector_bridge"
          || targetRoute.geometry_mode === "downstream_vent_tee") {
          throw new Error(`${observation.observation_id}_target_route_must_create_source_grounded_geometry`);
        }
        if (targetRoute.service !== observation.service
          || normalized(targetRoute.system_type) !== normalized(observation.system_type)
          || normalized(targetRoute.pipe_type) !== normalized(observation.pipe_type)
          || normalized(targetRoute.pipe_size) !== normalized(observation.pipe_size)) {
          throw new Error(`${observation.observation_id}_target_route_service_size_type_mismatch`);
        }
      }
    }
    if (observation.kind === "pipe_route" && observation.geometry_mode === "source_branch_tee") {
      const mainRoute = byId.get(observation.main_route_observation_id);
      if (!mainRoute || mainRoute.kind !== "pipe_route") {
        throw new Error(`${observation.observation_id}_main_route_observation_unknown:${observation.main_route_observation_id}`);
      }
      if (mainRoute.geometry_mode === "native_connector_bridge"
        || mainRoute.geometry_mode === "created_route_connector_bridge"
        || mainRoute.geometry_mode === "downstream_vent_tee"
        || mainRoute.geometry_mode === "source_branch_tee") {
        throw new Error(`${observation.observation_id}_main_route_must_use_source_points`);
      }
      if (mainRoute.service !== observation.service
        || normalized(mainRoute.system_type) !== normalized(observation.system_type)
        || normalized(mainRoute.pipe_type) !== normalized(observation.pipe_type)) {
        throw new Error(`${observation.observation_id}_main_route_service_type_mismatch`);
      }
      if (Math.abs(mainRoute.elevation_ft - observation.elevation_ft) > 1e-6) {
        throw new Error(`${observation.observation_id}_main_route_elevation_mismatch`);
      }
      resolveUniqueRouteSegmentIndex(mainRoute.points, observation.points[0]!, observation.observation_id);
    }
    if (observation.kind === "pipe_route" && observation.geometry_mode === "downstream_vent_tee") {
      const verificationMode = observation.verification_mode ?? "native_fixture_reachability";
      if (!['native_fixture_reachability', 'plan_topology_only'].includes(verificationMode)) {
        throw new Error(`${observation.observation_id}_vent_verification_mode_invalid`);
      }
      if (verificationMode === "plan_topology_only"
        && (observation.verification_fixture_reference_keys ?? []).length > 0) {
        throw new Error(`${observation.observation_id}_plan_topology_only_cannot_claim_native_fixture_references`);
      }
      if (clean(observation.main_reference_key)) {
        const mainReference = nativeReferences.get(observation.main_reference_key!);
        if (!mainReference) throw new Error(`${observation.observation_id}_main_reference_unknown:${observation.main_reference_key}`);
        const mainCategory = normalized(mainReference.category).replaceAll(" ", "");
        if (!mainCategory.includes("pipecurves") && !mainCategory.endsWith("pipes")) {
          throw new Error(`${observation.observation_id}_main_reference_category_mismatch`);
        }
      } else {
        const mainRoute = byId.get(observation.main_route_observation_id!);
        if (!mainRoute || mainRoute.kind !== "pipe_route") {
          throw new Error(`${observation.observation_id}_main_route_observation_unknown:${observation.main_route_observation_id}`);
        }
        if (mainRoute.geometry_mode === "native_connector_bridge"
          || mainRoute.geometry_mode === "created_route_connector_bridge"
          || mainRoute.geometry_mode === "downstream_vent_tee"
          || mainRoute.geometry_mode === "source_branch_tee") {
          throw new Error(`${observation.observation_id}_main_route_must_use_source_points`);
        }
        if (mainRoute.service !== "sanitary" || normalized(mainRoute.system_type) !== "sanitary") {
          throw new Error(`${observation.observation_id}_main_route_must_be_sanitary`);
        }
      }
      for (const fixtureKey of observation.verification_fixture_reference_keys ?? []) {
        const fixtureReference = nativeReferences.get(fixtureKey);
        if (!fixtureReference) throw new Error(`${observation.observation_id}_verification_fixture_reference_unknown:${fixtureKey}`);
        if (!normalized(fixtureReference.category).replaceAll(" ", "").includes("plumbingfixtures")) {
          throw new Error(`${observation.observation_id}_verification_fixture_reference_category_mismatch:${fixtureKey}`);
        }
      }
      for (const fixtureObservationId of observation.verification_fixture_observation_ids ?? []) {
        const fixtureObservation = byId.get(fixtureObservationId);
        if (!fixtureObservation || fixtureObservation.kind !== "plumbing_fixture") {
          throw new Error(`${observation.observation_id}_verification_fixture_observation_unknown:${fixtureObservationId}`);
        }
        if (!clean(observation.main_route_observation_id)) {
          throw new Error(`${observation.observation_id}_created_fixture_verification_requires_planned_main`);
        }
        if (!fixtureObservation.service_route_connections.some((connection) =>
          connection.route_observation_id === observation.main_route_observation_id)) {
          throw new Error(`${observation.observation_id}_created_fixture_must_connect_to_planned_main:${fixtureObservationId}`);
        }
        if (verificationMode === "plan_topology_only"
          && fixtureConnectionMode(fixtureObservation) !== "plan_proximity") {
          throw new Error(`${observation.observation_id}_plan_topology_fixture_must_use_plan_proximity:${fixtureObservationId}`);
        }
      }
    }
    if (observation.kind === "plumbing_fixture") {
      const classificationRole = requiredText(
        observation.representation_classification.evidence_role,
        `${observation.observation_id}_representation_classification_evidence_role`
      );
      if (!visibleEvidenceByRole.has(normalized(classificationRole))) {
        throw new Error(`${observation.observation_id}_representation_classification_evidence_role_unknown`);
      }
      const observationEvidenceRole = clean(observation.evidence_role) || "source_pdf";
      if (observation.representation_classification.basis === "source_observation"
        && normalized(classificationRole) !== normalized(observationEvidenceRole)) {
        throw new Error(`${observation.observation_id}_source_classification_must_use_observation_evidence`);
      }
      if (observation.representation_classification.basis === "source_observation"
        && nativeEvidenceRoles.has(normalized(classificationRole))) {
        throw new Error(`${observation.observation_id}_source_classification_cannot_use_native_evidence`);
      }
      if (observation.representation_classification.native_target === "plan_only_marker") {
        continue;
      }
      const targetEvidence = observation.representation_classification.native_target_evidence!;
      const targetEvidenceRole = requiredText(
        targetEvidence.evidence_role,
        `${observation.observation_id}_native_target_evidence_role`
      );
      if (!visibleEvidenceByRole.has(normalized(targetEvidenceRole))) {
        throw new Error(`${observation.observation_id}_native_target_evidence_role_unknown`);
      }
      if (targetEvidence.basis === "native_model_precedent"
        && normalized(targetEvidenceRole) === normalized(observationEvidenceRole)) {
        throw new Error(`${observation.observation_id}_native_target_precedent_cannot_use_source_observation`);
      }
      const connectionMode = fixtureConnectionMode(observation);
      if (!['native_connectivity', 'plan_proximity'].includes(connectionMode)) {
        throw new Error(`${observation.observation_id}_service_connection_mode_invalid`);
      }
      if (!observation.service_boundary || !["source_observation", "native_model_precedent"].includes(observation.service_boundary.basis)) {
        throw new Error(`${observation.observation_id}_service_boundary_basis_invalid`);
      }
      const boundaryRole = requiredText(observation.service_boundary?.evidence_role, `${observation.observation_id}_service_boundary_evidence_role`);
      if (!visibleEvidenceByRole.has(normalized(boundaryRole))) throw new Error(`${observation.observation_id}_service_boundary_evidence_role_unknown`);
      const requiredServices = unique(observation.service_boundary?.required_services ?? []);
      const prohibitedServices = unique(observation.service_boundary?.prohibited_services ?? []);
      if (requiredServices.length === 0) throw new Error(`${observation.observation_id}_required_services_are_required`);
      if (requiredServices.some((service) => prohibitedServices.includes(service))) throw new Error(`${observation.observation_id}_service_boundary_conflicts`);
      const referencedServices: string[] = [];
      for (const connection of observation.service_route_connections) {
        const routeId = connection.route_observation_id;
        const route = byId.get(routeId);
        if (!route || route.kind !== "pipe_route") throw new Error(`${observation.observation_id}_references_unknown_pipe_route:${routeId}`);
        if (route.service === "unclassified") {
          throw new Error(`${observation.observation_id}_unclassified_route_cannot_establish_fixture_service:${routeId}`);
        }
        if (connectionMode === "plan_proximity") {
          if (connection.route_endpoint !== "nearest_plan_segment") {
            throw new Error(`${observation.observation_id}_plan_proximity_requires_nearest_plan_segment:${routeId}`);
          }
          const routePoints = routePlanPoints(route);
          if (!routePoints || route.geometry_mode === "downstream_vent_tee") {
            throw new Error(`${observation.observation_id}_plan_proximity_requires_source_grounded_route:${routeId}`);
          }
          const fixturePoint = transformExistingConditionsPlanPoint(registration, observation.point);
          const transformedRoutePoints = routePoints.map((entry) => transformExistingConditionsPlanPoint(registration, entry));
          const distance = transformedRoutePoints.slice(0, -1).reduce((best, start, index) =>
            Math.min(best, planDistanceToSegment(fixturePoint, start, transformedRoutePoints[index + 1]!)), Number.POSITIVE_INFINITY);
          const maximum = connection.maximum_plan_distance_ft ?? 5;
          if (distance > maximum) {
            throw new Error(`${observation.observation_id}_plan_proximity_exceeds_limit:${routeId}:${distance.toFixed(3)}:${maximum.toFixed(3)}`);
          }
        } else if (connection.route_endpoint === "nearest_plan_segment") {
          throw new Error(`${observation.observation_id}_native_connectivity_cannot_use_nearest_plan_segment:${routeId}`);
        }
        if (route.geometry_mode === "native_connector_bridge"
          || route.geometry_mode === "created_route_connector_bridge") {
          if (route.source_fixture_observation_id !== observation.observation_id) {
            throw new Error(`${routeId}_source_fixture_mismatch:${route.source_fixture_observation_id}:${observation.observation_id}`);
          }
          if (connection.route_endpoint !== "native_source") {
            throw new Error(`${observation.observation_id}_connector_bridge_requires_native_source_endpoint:${routeId}`);
          }
        } else if (route.geometry_mode === "downstream_vent_tee") {
          throw new Error(`${routeId}_downstream_vent_cannot_be_direct_fixture_connection`);
        } else if (connection.route_endpoint === "native_source") {
          throw new Error(`${observation.observation_id}_source_points_route_cannot_use_native_source_endpoint:${routeId}`);
        }
        if (connectionMode === "native_connectivity") {
          const endpointKey = `${routeId}:${connection.route_endpoint}`;
          const existingClaim = claimedPipeEndpoints.get(endpointKey);
          if (existingClaim) {
            throw new Error(`pipe_route_endpoint_claimed_multiple_times:${endpointKey}:${existingClaim}:${observation.observation_id}`);
          }
          claimedPipeEndpoints.set(endpointKey, observation.observation_id);
        }
        referencedServices.push(route.service);
      }
      if (new Set(referencedServices).size !== referencedServices.length) throw new Error(`${observation.observation_id}_duplicates_service_routes`);
      const missingServices = requiredServices.filter((service) => !referencedServices.includes(service));
      const prohibitedPresent = referencedServices.filter((service) => prohibitedServices.includes(service));
      const undeclaredServices = referencedServices.filter((service) => !requiredServices.includes(service));
      if (missingServices.length > 0) throw new Error(`${observation.observation_id}_missing_required_services:${missingServices.join(",")}`);
      if (prohibitedPresent.length > 0) throw new Error(`${observation.observation_id}_prohibited_services_present:${prohibitedPresent.join(",")}`);
      if (undeclaredServices.length > 0) throw new Error(`${observation.observation_id}_undeclared_services_present:${undeclaredServices.join(",")}`);
    }
    if (observation.kind === "air_terminal"
      && (observation.placement.mode === "created_route_host" || observation.placement.mode === "created_route_branch")) {
      const routeId = observation.placement.route_observation_id;
      const route = byId.get(routeId);
      if (!route || route.kind !== "duct_route") {
        throw new Error(`${observation.observation_id}_host_route_observation_must_be_duct_route:${routeId}`);
      }
      if (route.service === "unclassified") {
        throw new Error(`${observation.observation_id}_unclassified_duct_cannot_establish_terminal_topology:${routeId}`);
      }
      if (routeSystemClassificationPolicy(route) !== "explicit_required"
        || routeTypePolicy(route) !== "explicit_required"
        || ductSizePolicy(route) !== "explicit_required") {
        throw new Error(`${observation.observation_id}_provisional_duct_cannot_establish_terminal_topology:${routeId}`);
      }
      const segmentIndex = observation.placement.route_segment_index;
      if (segmentIndex >= route.points.length - 1) {
        throw new Error(`${observation.observation_id}_host_route_segment_index_out_of_range:${segmentIndex}`);
      }
      if (observation.placement.mode === "created_route_host") {
        if (planDistanceToSegment(observation.point, route.points[segmentIndex]!, route.points[segmentIndex + 1]!) > 0.25) {
          throw new Error(`${observation.observation_id}_point_off_host_route_segment`);
        }
      } else {
        const branchStart = observation.placement.branch_points[0]!;
        const branchEnd = observation.placement.branch_points[observation.placement.branch_points.length - 1]!;
        if (planDistanceToSegment(branchStart, route.points[segmentIndex]!, route.points[segmentIndex + 1]!) > 0.25) {
          throw new Error(`${observation.observation_id}_branch_start_off_host_route_segment`);
        }
        if (Math.hypot(branchEnd.x - observation.point.x, branchEnd.y - observation.point.y) > 0.25) {
          throw new Error(`${observation.observation_id}_branch_end_must_match_terminal_point`);
        }
      }
    }
    if (observation.kind === "mechanical_equipment" || observation.kind === "air_terminal"
      || observation.kind === "plumbing_fixture" || observation.kind === "electrical_device"
      || observation.kind === "light_fixture" || observation.kind === "electrical_equipment") {
      validateAnnotationTags(observation.placement, observation.observation_id, nativeReferences);
    }
    if ((observation.kind === "plumbing_fixture" || observation.kind === "electrical_device" || observation.kind === "light_fixture" || observation.kind === "electrical_equipment")
      && (observation.placement.mode === "hosted_exemplar" || observation.placement.mode === "hosted_family_symbol")) {
      if (observation.placement.mode === "hosted_family_symbol") {
        const hostReference = nativeReferences.get(observation.placement.host_reference_key);
        if (!hostReference) throw new Error(`${observation.observation_id}_host_reference_unknown`);
        if (normalized(hostReference.category) !== normalized(observation.placement.host_category)) {
          throw new Error(`${observation.observation_id}_host_reference_category_mismatch`);
        }
        if (normalized(hostReference.category) === normalized("OST_RvtLinks")
          && !observation.placement.linked_host_reference_key) {
          throw new Error(`${observation.observation_id}_revit_link_host_requires_exact_linked_element_reference`);
        }
        if (observation.placement.linked_host_reference_key) {
          if (normalized(hostReference.category) !== normalized("OST_RvtLinks")) {
            throw new Error(`${observation.observation_id}_linked_host_reference_requires_revit_link_host`);
          }
          const linkedHostReference = nativeReferences.get(observation.placement.linked_host_reference_key);
          if (!linkedHostReference) throw new Error(`${observation.observation_id}_linked_host_reference_unknown`);
          if (normalized(linkedHostReference.category) === normalized("OST_RvtLinks")) {
            throw new Error(`${observation.observation_id}_linked_host_reference_must_resolve_inside_link`);
          }
        }
        if (observation.placement.metadata_source_reference_key) {
          const metadataSourceReference = nativeReferences.get(observation.placement.metadata_source_reference_key);
          if (!metadataSourceReference) throw new Error(`${observation.observation_id}_metadata_source_reference_unknown`);
          if (normalized(metadataSourceReference.category) !== normalized(category(observation))) {
            throw new Error(`${observation.observation_id}_metadata_source_reference_category_mismatch`);
          }
        }
        if (observation.placement.orientation_source_reference_key) {
          const orientationSourceReference = nativeReferences.get(observation.placement.orientation_source_reference_key);
          if (!orientationSourceReference) throw new Error(`${observation.observation_id}_orientation_source_reference_unknown`);
          if (normalized(orientationSourceReference.category) !== normalized(category(observation))) {
            throw new Error(`${observation.observation_id}_orientation_source_reference_category_mismatch`);
          }
        }
        continue;
      }
      const sourceReference = nativeReferences.get(observation.placement.source_reference_key);
      if (!sourceReference) throw new Error(`${observation.observation_id}_source_reference_unknown`);
      if (normalized(sourceReference.category) !== normalized(category(observation))) throw new Error(`${observation.observation_id}_source_reference_category_mismatch`);
      const hostReference = nativeReferences.get(observation.placement.host_reference_key);
      if (!hostReference) throw new Error(`${observation.observation_id}_host_reference_unknown`);
      if (normalized(hostReference.category) !== normalized(observation.placement.host_category)) {
        throw new Error(`${observation.observation_id}_host_reference_category_mismatch`);
      }
    }
    if (observation.kind === "electrical_circuit") {
      if (new Set(observation.member_observation_ids).size !== observation.member_observation_ids.length) {
        throw new Error(`${observation.observation_id}_member_observation_ids_must_be_unique`);
      }
      const nativeMemberReferenceKeys = observation.native_member_reference_keys ?? [];
      if (new Set(nativeMemberReferenceKeys).size !== nativeMemberReferenceKeys.length) {
        throw new Error(`${observation.observation_id}_native_member_reference_keys_must_be_unique`);
      }
      for (const memberId of observation.member_observation_ids) {
        const member = byId.get(memberId);
        if (!member || (member.kind !== "electrical_device" && member.kind !== "light_fixture" && member.kind !== "electrical_equipment")) {
          throw new Error(`${observation.observation_id}_references_unknown_electrical_device:${memberId}`);
        }
        if (member.placement.mode === "provisional_plan_symbol") {
          throw new Error(`${observation.observation_id}_provisional_plan_symbol_cannot_be_circuit_member:${memberId}`);
        }
        const existingCircuit = assignedElectricalDevices.get(memberId);
        if (existingCircuit) {
          throw new Error(`electrical_device_assigned_to_multiple_circuits:${memberId}:${existingCircuit}:${observation.observation_id}`);
        }
        assignedElectricalDevices.set(memberId, observation.observation_id);
      }
      for (const referenceKey of nativeMemberReferenceKeys) {
        const memberReference = nativeReferences.get(referenceKey);
        if (!memberReference) throw new Error(`${observation.observation_id}_native_member_reference_unknown:${referenceKey}`);
        if (!["OST_ElectricalFixtures", "OST_LightingFixtures", "OST_ElectricalEquipment", "OST_MechanicalEquipment"].map(normalized).includes(normalized(memberReference.category))) {
          throw new Error(`${observation.observation_id}_native_member_reference_category_mismatch:${referenceKey}`);
        }
        const assignmentKey = `native:${referenceKey}`;
        const existingCircuit = assignedElectricalDevices.get(assignmentKey);
        if (existingCircuit) {
          throw new Error(`electrical_device_assigned_to_multiple_circuits:${referenceKey}:${existingCircuit}:${observation.observation_id}`);
        }
        assignedElectricalDevices.set(assignmentKey, observation.observation_id);
      }
      if (observation.circuit_mode === "create_new_power_system") {
        if (observation.membership_basis === "legible_source_circuit_label") {
          for (const evidence of observation.member_label_evidence ?? []) {
            if (!visibleEvidenceByRole.has(normalized(evidence.evidence_role))) {
              throw new Error(`${observation.observation_id}_member_label_evidence_role_unknown:${evidence.member_observation_id}`);
            }
          }
          for (const evidence of observation.native_member_label_evidence ?? []) {
            if (!visibleEvidenceByRole.has(normalized(evidence.evidence_role))) {
              throw new Error(`${observation.observation_id}_native_member_label_evidence_role_unknown:${evidence.native_member_reference_key}`);
            }
          }
        }
        if (observation.panel_reference_key && observation.panel_observation_id) {
          throw new Error(`${observation.observation_id}_panel_reference_and_observation_are_mutually_exclusive`);
        }
        if (observation.panel_reference_key) {
          const panelReference = nativeReferences.get(observation.panel_reference_key);
          if (!panelReference) throw new Error(`${observation.observation_id}_panel_reference_unknown`);
          if (normalized(panelReference.category) !== normalized("OST_ElectricalEquipment")) {
            throw new Error(`${observation.observation_id}_panel_reference_category_mismatch`);
          }
          if (nativeMemberReferenceKeys.includes(observation.panel_reference_key)) {
            throw new Error(`${observation.observation_id}_panel_reference_cannot_be_circuit_member`);
          }
        }
        if (observation.panel_observation_id) {
          const panelObservation = byId.get(observation.panel_observation_id);
          if (!panelObservation || panelObservation.kind !== "electrical_equipment") {
            throw new Error(`${observation.observation_id}_panel_observation_must_be_electrical_equipment`);
          }
          if (observation.member_observation_ids.includes(observation.panel_observation_id)) {
            throw new Error(`${observation.observation_id}_panel_observation_cannot_be_circuit_member`);
          }
          const panelHasDistributionPrecedent = panelObservation.placement.mode === "hosted_exemplar"
            ? panelObservation.placement.copy_distribution_system_from_source === true
            : panelObservation.placement.mode === "hosted_family_symbol"
              ? panelObservation.placement.ensure_distribution_system != null
              : false;
          if (!panelHasDistributionPrecedent) {
            throw new Error(`${observation.observation_id}_created_panel_requires_native_distribution_system_precedent`);
          }
        }
        continue;
      }
      const sourceReference = nativeReferences.get(observation.source_reference_key);
      if (!sourceReference) throw new Error(`${observation.observation_id}_source_reference_unknown`);
      if (!["OST_ElectricalFixtures", "OST_LightingFixtures", "OST_ElectricalEquipment"].map(normalized).includes(normalized(sourceReference.category))) {
        throw new Error(`${observation.observation_id}_source_reference_category_mismatch`);
      }
      const powerSystemIds = unique(sourceReference.power_system_ids ?? []);
      if (powerSystemIds.length !== 1 || powerSystemIds[0] !== observation.expected_power_system_id) {
        throw new Error(`${observation.observation_id}_source_power_system_not_exactly_verified`);
      }
    }
  }

  const threshold = input.material_confidence_threshold == null
    ? 0.75
    : finite(input.material_confidence_threshold, "material_confidence_threshold");
  if (threshold < 0 || threshold > 1) throw new Error("material_confidence_threshold_must_be_between_zero_and_one");
  const ambiguities: ExistingConditionsAmbiguity[] = [];
  const warnings: string[] = [];
  const sourceObservations: ExistingConditionsSourceObservation[] = [];
  const planElements: ExistingConditionsPlanElement[] = [];

  for (const observation of input.observations) {
    const requiredAttributes = materialAttributes(observation);
    const supported = new Set(observation.supported_attributes.map(normalized));
    const missing = requiredAttributes.filter((attribute) => !supported.has(normalized(attribute)));
    const effectiveConfidence = observation.kind === "pipe_route"
      && (observation.geometry_mode === "native_connector_bridge"
        || observation.geometry_mode === "created_route_connector_bridge")
      ? observation.confidence
      : observation.visibility === "clear"
      ? observation.confidence
      : observation.visibility === "partial"
        ? observation.confidence * 0.8
        : observation.confidence * 0.55;
    const declaredHeuristics = (observation.attribute_provenance ?? [])
      .filter((entry) => entry.basis === "declared_heuristic")
      .map((entry) => `${normalized(entry.attribute)} inferred by declared heuristic: ${clean(entry.reference)}`);
    const nativeConnectorAssumptions = observation.kind === "pipe_route"
      && (observation.geometry_mode === "native_connector_bridge"
        || observation.geometry_mode === "created_route_connector_bridge")
      ? ["concealed route endpoints resolved from explicit native runtime connectors; not observed in the source plan"]
      : [];
    const downstreamVentAssumptions = observation.kind === "pipe_route" && observation.geometry_mode === "downstream_vent_tee"
      ? [
          clean(observation.main_reference_key)
            ? "vent continuation is connected downstream to a retained sanitary main; no direct fixture Vent connector is claimed"
            : "vent continuation is connected downstream to a source-grounded sanitary route created earlier in the same atomic workflow; no direct fixture Vent connector is claimed",
          (observation.verification_mode ?? "native_fixture_reachability") === "native_fixture_reachability"
            ? "fixture acceptance requires a complete native downstream reachability audit after the tee is created"
            : "connectorless fixture graphics are associated by source-visible plan proximity only; the created sanitary-to-vent tee is verified, but native fixture reachability is not claimed"
        ]
      : [];
    const unresolvedSizeAssumptions = observation.kind === "pipe_route"
      && pipeSizePolicy(observation) === "unresolved_placeholder"
      ? ["pipe size is unreadable in the source plan; runtime creates a clearly labeled one-inch drafting placeholder and size receives no source-evidence credit"]
      : [];
    const unresolvedConduitSizeAssumptions = observation.kind === "conduit_route"
      && conduitSizePolicy(observation) === "unresolved_placeholder"
      ? ["conduit size is unreadable in the source plan; runtime creates a clearly labeled one-inch drafting placeholder and size receives no source-evidence credit"]
      : [];
    const unresolvedDuctSizeAssumptions = observation.kind === "duct_route"
      && ductSizePolicy(observation) === "unresolved_placeholder"
      ? ["duct size is unreadable in the source plan; runtime creates a disclosed 8x8 drafting placeholder and size receives no source-evidence or benchmark credit"]
      : [];
    const unresolvedTypeAssumptions = (observation.kind === "pipe_route"
      || observation.kind === "duct_route"
      || observation.kind === "conduit_route")
      && routeTypePolicy(observation) === "unresolved_placeholder"
      ? [
          `source plan does not establish route type; runtime uses project-local type ${clean(
            observation.kind === "pipe_route"
              ? observation.pipe_type
              : observation.kind === "duct_route"
                ? observation.duct_type
                : observation.conduit_type
          )} as an editable native drafting container`,
          "native type selection receives no source-evidence or benchmark credit and cannot establish external endpoint topology"
        ]
      : [];
    const unresolvedSystemAssumptions = (observation.kind === "pipe_route" || observation.kind === "duct_route")
      && routeSystemClassificationPolicy(observation) === "unresolved_placeholder"
      ? [
          `source plan does not establish route system classification; runtime uses project-local system type ${clean(observation.system_type)} as an editable provisional drafting container`,
          "system classification receives no source-evidence or benchmark credit and must be revisited when legend, label, or user evidence becomes available"
        ]
      : [];
    const planProximityAssumptions = observation.kind === "plumbing_fixture"
      && fixtureConnectionMode(observation) === "plan_proximity"
      ? ["fixture service associations are source-visible plan proximity only; no native Revit connector relationship is claimed"]
      : [];
    const conduitAssociationAssumptions = observation.kind === "conduit_route"
      ? [`conduit service classification ${observation.service} is source-evidence metadata only; it does not establish panel association, circuit membership, or endpoint connectivity`]
      : [];
    const provisionalPlanSymbolAssumptions = "placement" in observation
      && observation.placement.mode === "provisional_plan_symbol"
      ? [
          `source evidence supports a plan location and ${observation.placement.symbol_form.replaceAll("_", " ")} graphic but not a defensible native ${observation.kind.replaceAll("_", " ")} family/type, host, elevation, or service identity`,
          "runtime creates view-specific DetailCurves only; no modeled MEP element, connector, service topology, airflow, circuit membership, panel association, or complete-scope benchmark credit is claimed",
          ...(observation.placement.symbol_form === "filled_circle"
            ? ["filled source graphics use a dense DetailCurve hatch approximation, not a native Revit FilledRegion or modeled family symbol"]
            : [])
        ]
      : [];
    sourceObservations.push({
      observation_id: observation.observation_id,
      evidence_role: clean(observation.evidence_role) || "source_pdf",
      discipline: observation.discipline,
      category: category(observation),
      role: role(observation),
      visibility: observation.visibility,
      confidence: observation.confidence,
      supported_attributes: unique(observation.supported_attributes)
    });
    planElements.push({
      plan_key: observation.observation_id,
      discipline: observation.discipline,
      category: category(observation),
      role: role(observation),
      action: action(observation),
      confidence: effectiveConfidence,
      assumptions: [
        ...declaredHeuristics,
        ...nativeConnectorAssumptions,
        ...downstreamVentAssumptions,
        ...unresolvedSizeAssumptions,
        ...unresolvedConduitSizeAssumptions,
        ...unresolvedDuctSizeAssumptions,
        ...unresolvedTypeAssumptions,
        ...unresolvedSystemAssumptions,
        ...planProximityAssumptions,
        ...conduitAssociationAssumptions,
        ...provisionalPlanSymbolAssumptions
      ],
      source_observation_ids: [observation.observation_id],
      required_source_attributes: requiredAttributes
    });
    if (effectiveConfidence < threshold || missing.length > 0) {
      const reasons = [
        ...(effectiveConfidence < threshold ? [`effective confidence ${effectiveConfidence.toFixed(3)} is below ${threshold.toFixed(3)}`] : []),
        ...(missing.length > 0 ? [`source does not support ${missing.join(", ")}`] : [])
      ];
      ambiguities.push({
        id: `clarify:${observation.observation_id}`,
        topic: `${role(observation)} source evidence`,
        description: reasons.join("; "),
        material: true,
        confidence: effectiveConfidence,
        choices: [],
        related_plan_keys: [observation.observation_id],
        material_attributes: missing,
        resolution: null,
        resolution_basis: null,
        resolution_evidence_reference: null
      });
    }
    if (declaredHeuristics.length > 0) {
      warnings.push(`${observation.observation_id}: ${declaredHeuristics.join("; ")}`);
    }
    if (nativeConnectorAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${nativeConnectorAssumptions.join("; ")}`);
    }
    if (downstreamVentAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${downstreamVentAssumptions.join("; ")}`);
    }
    if (unresolvedSizeAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${unresolvedSizeAssumptions.join("; ")}`);
    }
    if (unresolvedConduitSizeAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${unresolvedConduitSizeAssumptions.join("; ")}`);
    }
    if (unresolvedDuctSizeAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${unresolvedDuctSizeAssumptions.join("; ")}`);
    }
    if (unresolvedTypeAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${unresolvedTypeAssumptions.join("; ")}`);
    }
    if (unresolvedSystemAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${unresolvedSystemAssumptions.join("; ")}`);
    }
    if (planProximityAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${planProximityAssumptions.join("; ")}`);
    }
    if (provisionalPlanSymbolAssumptions.length > 0) {
      warnings.push(`${observation.observation_id}: ${provisionalPlanSymbolAssumptions.join("; ")}`);
    }
  }

  const blockers = registration.verified ? [] : [
    `registration_error_exceeds_limit:rms=${registration.rms_error_ft.toFixed(6)}/${registration.max_rms_error_ft.toFixed(6)}:max=${registration.maximum_error_ft.toFixed(6)}/${registration.max_point_error_ft.toFixed(6)}`
  ];
  if (!registration.verified) warnings.push("No Revit write plan was emitted because source-to-model registration is not verified.");
  if (ambiguities.length > 0 && partialPromotionPolicy === "all_or_nothing") {
    warnings.push("Material source ambiguities must be resolved before dry-run or apply.");
  }
  if (ambiguities.length > 0 && partialPromotionPolicy === "defer_ambiguous_observations") {
    warnings.push("Ambiguous observations and actions that depend on them are deferred; independent source-supported actions may proceed as an explicitly unscored provisional draft.");
  }
  const actions: MepDraftAction[] = [];
  const pendingVentBranches: MepDraftAction[] = [];
  const pendingVentAudits: MepDraftAction[] = [];

  if (blockers.length === 0
    && (ambiguities.length === 0 || partialPromotionPolicy === "defer_ambiguous_observations")) {
    for (const observation of input.observations) {
      if (observation.kind === "duct_route") {
        const points = observation.points.map((entry) => ({
          ...transformExistingConditionsPlanPoint(registration, entry),
          z: levelElevationFt + observation.elevation_ft
        }));
        const common: JsonMap = {
          kind: "duct",
          levelName,
          systemType: observation.system_type,
          ductType: observation.duct_type,
          ...(ductSizePolicy(observation) === "explicit_required" ? { ductSize: observation.duct_size! } : {}),
          sizePolicy: ductSizePolicy(observation) === "explicit_required"
            ? "explicit_required"
            : "use_default_with_warning",
          elevationPolicy: "explicit_points",
          points,
          connectSegments: true,
          connectToExisting: observation.connect_to_existing === true,
          requireExistingEndpointConnections: observation.require_existing_endpoint_connections === true,
          externalConnectionToleranceFt: observation.external_connection_tolerance_ft ?? 0.1,
          verify: true,
          visualVerify: true
        };
        if (observation.duct_type_id != null) common.ductTypeId = observation.duct_type_id;
        if (observation.workset_name) common.worksetName = observation.workset_name;
        if (input.room_number) common.roomNumber = input.room_number;
        actions.push({
          action_key: `route:${observation.observation_id}`,
          observation_ids: [observation.observation_id],
          method: "POST",
          path: "/revit/mep-route-workflow",
          depends_on: [],
          dry_run_body: { ...common, apply: false },
          apply_body: { ...common, apply: true },
          expected_created_min: observation.points.length - 1,
          expected_created_max: (observation.points.length - 1) + Math.max(0, observation.points.length - 2),
          ...(routeSystemClassificationPolicy(observation) === "unresolved_placeholder" ? {
            provisional_system_classification: {
              policy: "unresolved_placeholder" as const,
              native_system_type_role: "editable_native_drafting_container" as const,
              benchmark_credit: false as const,
              complete_scope_credit: false as const
            }
          } : {})
        });
        continue;
      }
      if (observation.kind === "conduit_route") {
        const points = observation.points.map((entry) => ({
          ...transformExistingConditionsPlanPoint(registration, entry),
          z: levelElevationFt + observation.elevation_ft
        }));
        const common: JsonMap = {
          kind: "conduit",
          levelName,
          conduitType: observation.conduit_type,
          ...(conduitSizePolicy(observation) === "explicit_required" ? { diameter: observation.conduit_size! } : {}),
          sizePolicy: conduitSizePolicy(observation) === "explicit_required" ? "explicit_required" : "placeholder_allowed",
          elevationPolicy: "explicit_points",
          points,
          connectSegments: true,
          connectToExisting: observation.connect_to_existing === true,
          requireExistingEndpointConnections: observation.require_existing_endpoint_connections === true,
          externalConnectionToleranceFt: observation.external_connection_tolerance_ft ?? 0.1,
          verify: true,
          visualVerify: true
        };
        if (observation.conduit_type_id != null) common.conduitTypeId = observation.conduit_type_id;
        if (observation.workset_name) common.worksetName = observation.workset_name;
        if (input.room_number) common.roomNumber = input.room_number;
        actions.push({
          action_key: `route:${observation.observation_id}`,
          observation_ids: [observation.observation_id],
          method: "POST",
          path: "/revit/mep-route-workflow",
          depends_on: [],
          dry_run_body: { ...common, apply: false },
          apply_body: { ...common, apply: true },
          expected_created_min: observation.points.length - 1,
          expected_created_max: (observation.points.length - 1) + Math.max(0, observation.points.length - 2)
        });
        continue;
      }
      if (observation.kind === "pipe_route") {
        if (observation.geometry_mode === "native_connector_bridge"
          || observation.geometry_mode === "created_route_connector_bridge"
          || observation.geometry_mode === "downstream_vent_tee"
          || observation.geometry_mode === "source_branch_tee") continue;
        const points = observation.points.map((entry) => ({
          ...transformExistingConditionsPlanPoint(registration, entry),
          z: levelElevationFt + observation.elevation_ft
        }));
        const common: JsonMap = {
          kind: "pipe",
          levelName,
          systemType: observation.system_type,
          pipeType: observation.pipe_type,
          ...(pipeSizePolicy(observation) === "explicit_required" ? { pipeSize: observation.pipe_size! } : {}),
          sizePolicy: pipeSizePolicy(observation) === "explicit_required" ? "explicit_required" : "placeholder_allowed",
          elevationPolicy: "explicit_points",
          points,
          connectSegments: true,
          connectToExisting: observation.connect_to_existing === true,
          requireExistingEndpointConnections: observation.require_existing_endpoint_connections === true,
          externalConnectionToleranceFt: observation.external_connection_tolerance_ft ?? 0.1,
          verify: true,
          visualVerify: true
        };
        if (routeWorksetName(observation)) common.worksetName = routeWorksetName(observation);
        if (input.room_number) common.roomNumber = input.room_number;
        actions.push({
          action_key: `route:${observation.observation_id}`,
          observation_ids: [observation.observation_id],
          method: "POST",
          path: "/revit/mep-route-workflow",
          depends_on: [],
          dry_run_body: { ...common, apply: false },
          apply_body: { ...common, apply: true },
          expected_created_min: observation.points.length - 1,
          expected_created_max: (observation.points.length - 1) + Math.max(0, observation.points.length - 2),
          ...(routeSystemClassificationPolicy(observation) === "unresolved_placeholder" ? {
            provisional_system_classification: {
              policy: "unresolved_placeholder" as const,
              native_system_type_role: "editable_native_drafting_container" as const,
              benchmark_credit: false as const,
              complete_scope_credit: false as const
            }
          } : {})
        });
        continue;
      }
      if (observation.kind === "mechanical_equipment" || observation.kind === "air_terminal"
        || observation.kind === "plumbing_fixture" || observation.kind === "electrical_device" || observation.kind === "light_fixture" || observation.kind === "electrical_equipment") {
        actions.push(pointAction(
          observation,
          registration,
          transformExistingConditionsPlanPoint(registration, observation.point),
          levelName,
          levelElevationFt,
          input.room_number,
          nativeReferences
        ));
        continue;
      }
      const memberDependencies = observation.member_observation_ids.map((id) => `place:${id}`);
      const existingMemberIds = (observation.native_member_reference_keys ?? [])
        .map((referenceKey) => nativeReferences.get(referenceKey)!.element_id);
      const panelDependency = observation.circuit_mode === "create_new_power_system" && observation.panel_observation_id
        ? `place:${observation.panel_observation_id}`
        : undefined;
      const dependencies = [...memberDependencies, ...(panelDependency ? [panelDependency] : [])];
      const sourceReference = observation.circuit_mode === "create_new_power_system"
        ? undefined
        : nativeReferences.get(observation.source_reference_key)!;
      const panelReference = observation.circuit_mode === "create_new_power_system" && observation.panel_reference_key
        ? nativeReferences.get(observation.panel_reference_key)
        : undefined;
      actions.push({
        action_key: `circuit:${observation.observation_id}`,
        observation_ids: [observation.observation_id, ...observation.member_observation_ids],
        method: "POST",
        path: "/revit/assign-electrical-circuit",
        depends_on: dependencies,
        deferred_body: {
          element_ids: memberDependencies.map((createdByAction) => ({ created_by_action: createdByAction })),
          ...(existingMemberIds.length > 0 ? { existing_element_ids: existingMemberIds } : {}),
          ...(sourceReference ? { source_element_id: sourceReference.element_id } : {}),
          ...(observation.circuit_mode === "create_new_power_system" ? { create_system_type: "PowerCircuit" as const } : {}),
          ...(panelReference ? { panel_element_id: panelReference.element_id } : {}),
          ...(panelDependency ? { panel_element: { created_by_action: panelDependency } } : {})
        },
        expected_created_min: observation.circuit_mode === "create_new_power_system" ? 1 : 0,
        expected_created_max: observation.circuit_mode === "create_new_power_system" ? 1 : 0
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "air_terminal" || observation.placement.mode !== "created_route_branch") continue;
      const placement = observation.placement;
      const route = byId.get(placement.route_observation_id)! as MechanicalDuctRouteObservation;
      const routeActionKey = `route:${placement.route_observation_id}`;
      const placeActionKey = `place:${observation.observation_id}`;
      const branchActionKey = `branch:${observation.observation_id}`;
      const transformedBranchPoints = placement.branch_points.map((entry) => ({
        ...transformExistingConditionsPlanPoint(registration, entry),
        z: levelElevationFt + route.elevation_ft
      }));
      const branchSegmentCount = transformedBranchPoints.length - 1;
      actions.push({
        action_key: branchActionKey,
        observation_ids: [observation.observation_id, placement.route_observation_id],
        method: "POST",
        path: "/revit/connect-mep-branch",
        depends_on: [routeActionKey],
        apply_body: {
          kind: "duct",
          branchPoints: transformedBranchPoints,
          branchSize: placement.branch_size,
          connectionMode: "tee",
          teeFamilyName: placement.tee_family_name,
          teeTypeName: placement.tee_type_name,
          levelName,
          verify: true,
          visualVerify: false
        },
        deferred_body: {
          main_element: {
            created_by_action: routeActionKey,
            output: "route_segment",
            index: placement.route_segment_index
          }
        },
        expected_created_min: branchSegmentCount + 2,
        expected_created_max: branchSegmentCount * 2 + 3
      });
      actions.push({
        action_key: `connect:${observation.observation_id}`,
        observation_ids: [observation.observation_id, placement.route_observation_id],
        method: "POST",
        path: "/revit/connect-mep-elements",
        depends_on: [placeActionKey, branchActionKey],
        deferred_body: {
          source_element: { created_by_action: placeActionKey, output: "created" },
          target_elements: [{ created_by_action: branchActionKey, output: "route_end" }],
          required_connection_count: 1
        },
        expected_created_min: 0,
        expected_created_max: 0
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "pipe_route" || observation.geometry_mode !== "source_branch_tee") continue;
      const mainRoute = byId.get(observation.main_route_observation_id)! as PlumbingSourcePointRouteObservation;
      const mainActionKey = `route:${observation.main_route_observation_id}`;
      const mainSegmentIndex = resolveUniqueRouteSegmentIndex(
        mainRoute.points,
        observation.points[0]!,
        observation.observation_id
      );
      const transformedPoints = observation.points.map((entry) => ({
        ...transformExistingConditionsPlanPoint(registration, entry),
        z: levelElevationFt + observation.elevation_ft
      }));
      const branchSegmentCount = transformedPoints.length - 1;
      actions.push({
        action_key: `route:${observation.observation_id}`,
        observation_ids: [observation.observation_id, observation.main_route_observation_id],
        method: "POST",
        path: "/revit/connect-mep-branch",
        depends_on: [mainActionKey],
        apply_body: {
          kind: "pipe",
          branchPoints: transformedPoints,
          ...(pipeSizePolicy(observation) === "explicit_required" ? { branchSize: observation.pipe_size! } : {}),
          branchSystemType: observation.system_type,
          branchPipeType: observation.pipe_type,
          connectionMode: "tee",
          teeFamilyName: observation.tee_family_name,
          teeTypeName: observation.tee_type_name,
          levelName,
          verify: true,
          visualVerify: false
        },
        deferred_body: {
          main_element: {
            created_by_action: mainActionKey,
            output: "route_segment",
            index: mainSegmentIndex
          }
        },
        expected_created_min: branchSegmentCount + 2,
        expected_created_max: branchSegmentCount * 2 + 3
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "pipe_route" || observation.geometry_mode !== "native_connector_bridge") continue;
      const sourceAction = `place:${observation.source_fixture_observation_id}`;
      const targetReference = nativeReferences.get(observation.target_reference_key)!;
      actions.push({
        action_key: `route:${observation.observation_id}`,
        observation_ids: [observation.observation_id, observation.source_fixture_observation_id],
        method: "POST",
        path: "/revit/create-pipe-between-connectors",
        depends_on: [sourceAction],
        apply_body: {
          service: observation.service,
          systemType: observation.system_type,
          pipeType: observation.pipe_type,
          pipeSize: observation.pipe_size!,
          levelName,
          maximumLengthFt: observation.maximum_length_ft ?? 5,
          sizeToleranceFt: observation.size_tolerance_ft ?? (1 / 192)
        },
        deferred_body: {
          source_element: { created_by_action: sourceAction, output: "created" },
          target_element_id: targetReference.element_id
        },
        expected_created_min: 1,
        expected_created_max: 1
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "pipe_route" || observation.geometry_mode !== "created_route_connector_bridge") continue;
      const sourceAction = `place:${observation.source_fixture_observation_id}`;
      const targetAction = `route:${observation.target_route_observation_id}`;
      actions.push({
        action_key: `route:${observation.observation_id}`,
        observation_ids: [
          observation.observation_id,
          observation.source_fixture_observation_id,
          observation.target_route_observation_id
        ],
        method: "POST",
        path: "/revit/create-pipe-between-connectors",
        depends_on: [sourceAction, targetAction],
        apply_body: {
          service: observation.service,
          systemType: observation.system_type,
          pipeType: observation.pipe_type,
          pipeSize: observation.pipe_size!,
          levelName,
          maximumLengthFt: observation.maximum_length_ft ?? 5,
          sizeToleranceFt: observation.size_tolerance_ft ?? (1 / 192)
        },
        deferred_body: {
          source_element: { created_by_action: sourceAction, output: "created" },
          target_element: {
            created_by_action: targetAction,
            output: observation.target_route_endpoint === "start" ? "route_start" : "route_end"
          }
        },
        expected_created_min: 1,
        expected_created_max: 1
      });
    }
    for (const observation of input.observations) {
      if (observation.kind !== "pipe_route" || observation.geometry_mode !== "downstream_vent_tee") continue;
      const mainReference = clean(observation.main_reference_key)
        ? nativeReferences.get(observation.main_reference_key!)!
        : undefined;
      const plannedMainCandidate = clean(observation.main_route_observation_id)
        ? byId.get(observation.main_route_observation_id!)
        : undefined;
      const plannedMain = plannedMainCandidate?.kind === "pipe_route"
        && plannedMainCandidate.geometry_mode !== "native_connector_bridge"
        && plannedMainCandidate.geometry_mode !== "created_route_connector_bridge"
        && plannedMainCandidate.geometry_mode !== "downstream_vent_tee"
        && plannedMainCandidate.geometry_mode !== "source_branch_tee"
        ? plannedMainCandidate
        : undefined;
      const fixtureElementIds = (observation.verification_fixture_reference_keys ?? [])
        .map((key) => nativeReferences.get(key)!.element_id);
      const fixtureObservationIds = observation.verification_fixture_observation_ids ?? [];
      const transformedPlanPoints = observation.points.map((entry) => transformExistingConditionsPlanPoint(registration, entry));
      const mainSegmentIndex = plannedMain
        ? resolveUniqueRouteSegmentIndex(
            plannedMain.points.map((entry) => transformExistingConditionsPlanPoint(registration, entry)),
            transformedPlanPoints[0]!,
            observation.observation_id
          )
        : null;
      const mainElevationFt = mainReference ? observation.main_elevation_ft! : plannedMain!.elevation_ft;
      const transformedPoints = transformedPlanPoints.map((entry, index) => ({
        ...entry,
        z: levelElevationFt + (index === 0 ? mainElevationFt : observation.elevation_ft)
      }));
      const routeActionKey = `route:${observation.observation_id}`;
      const mainActionKey = plannedMain ? `route:${plannedMain.observation_id}` : null;
      const fixturePlacementActions = fixtureObservationIds.map((id) => `place:${id}`);
      const fixtureConnectionActions = fixtureObservationIds.map((id) =>
        `connect:${id}:${observation.main_route_observation_id}`);
      const applyBody: JsonMap = {
        kind: "pipe",
        branchPoints: transformedPoints,
        ...(pipeSizePolicy(observation) === "explicit_required" ? { branchSize: observation.pipe_size! } : {}),
        branchSystemType: observation.system_type,
        branchPipeType: observation.pipe_type,
        connectionMode: "tee",
        levelName,
        verify: true,
        visualVerify: false
      };
      if (mainReference) applyBody.mainElementId = mainReference.element_id;
      pendingVentBranches.push({
        action_key: routeActionKey,
        observation_ids: [observation.observation_id, ...(plannedMain ? [plannedMain.observation_id] : [])],
        method: "POST",
        path: "/revit/connect-mep-branch",
        depends_on: mainActionKey ? [mainActionKey] : [],
        apply_body: applyBody,
        ...(mainActionKey ? {
          deferred_body: {
            main_element: {
              created_by_action: mainActionKey,
              output: "route_segment" as const,
              index: mainSegmentIndex!
            }
          }
        } : {}),
        expected_created_min: observation.points.length + 1,
        expected_created_max: observation.points.length * 3
      });
      if ((observation.verification_mode ?? "native_fixture_reachability") === "native_fixture_reachability") {
        pendingVentAudits.push({
          action_key: `verify:vent:${observation.observation_id}`,
          observation_ids: [observation.observation_id, ...fixtureObservationIds],
          method: "POST",
          path: "/revit/audit-plumbing-fixture-services",
          depends_on: unique([routeActionKey, ...fixturePlacementActions, ...fixtureConnectionActions]),
          apply_body: {
            levelName,
            maxElements: 5000,
            maxVentSearchElements: observation.max_vent_search_elements ?? 10000,
            maxVentSearchHops: observation.max_vent_search_hops ?? 500
          },
          deferred_body: {
            fixture_elements: fixturePlacementActions.map((createdByAction) => ({
              created_by_action: createdByAction,
              output: "created"
            })),
            fixture_element_ids: fixtureElementIds,
            require_downstream_vent: true
          },
          expected_created_min: 0,
          expected_created_max: 0
        });
      }
    }
    actions.push(...pendingVentBranches);
    for (const observation of input.observations) {
      if (observation.kind !== "plumbing_fixture" || observation.service_route_connections.length === 0) continue;
      if (fixtureConnectionMode(observation) === "plan_proximity") continue;
      const sourceAction = `place:${observation.observation_id}`;
      for (const connection of observation.service_route_connections) {
        const routeId = connection.route_observation_id;
        const route = byId.get(routeId);
        if (route?.kind === "pipe_route" && (route.geometry_mode === "native_connector_bridge"
          || route.geometry_mode === "created_route_connector_bridge"
          || route.geometry_mode === "downstream_vent_tee")) continue;
        const downstreamVent = input.observations.find((candidate): candidate is PlumbingDownstreamVentTeeObservation =>
          candidate.kind === "pipe_route"
          && candidate.geometry_mode === "downstream_vent_tee"
          && candidate.main_route_observation_id === routeId
          && (candidate.verification_fixture_observation_ids ?? []).includes(observation.observation_id));
        const routeAction = `route:${routeId}`;
        const targetAction = downstreamVent ? `route:${downstreamVent.observation_id}` : routeAction;
        actions.push({
          action_key: `connect:${observation.observation_id}:${routeId}`,
          observation_ids: [observation.observation_id, routeId],
          method: "POST",
          path: "/revit/connect-mep-elements",
          depends_on: unique([sourceAction, routeAction, targetAction]),
          deferred_body: {
            source_element: { created_by_action: sourceAction, output: "created" },
            target_elements: [{
              created_by_action: targetAction,
              output: downstreamVent
                ? (connection.route_endpoint === "start" ? "split_main_start" : "split_main_end")
                : (connection.route_endpoint === "start" ? "route_start" : "route_end")
            }],
            required_connection_count: 1
          },
          expected_created_min: 0,
          expected_created_max: 0
        });
      }
    }
    for (const observation of input.observations) {
      if ((observation.kind !== "mechanical_equipment" && observation.kind !== "air_terminal"
          && observation.kind !== "plumbing_fixture" && observation.kind !== "electrical_device"
          && observation.kind !== "light_fixture" && observation.kind !== "electrical_equipment")
        || (observation.placement.mode !== "unhosted_family" && observation.placement.mode !== "hosted_family_symbol")
        || !observation.placement.annotation_tags?.length) continue;
      const placementAction = `place:${observation.observation_id}`;
      const circuitDependencies = actions
        .filter((action) => action.path === "/revit/assign-electrical-circuit"
          && action.observation_ids.includes(observation.observation_id))
        .map((action) => action.action_key);
      observation.placement.annotation_tags.forEach((tag, index) => {
        const viewReference = nativeReferences.get(tag.view_reference_key)!;
        actions.push({
          action_key: `tag:${observation.observation_id}:${index + 1}`,
          observation_ids: [observation.observation_id],
          method: "POST",
          path: "/revit/tag-elements",
          depends_on: unique([placementAction, ...circuitDependencies]),
          apply_body: {
            viewId: viewReference.element_id,
            tagFamilyName: tag.family_name,
            tagTypeName: tag.type_name,
            onlyUntagged: false,
            addLeader: tag.add_leader === true,
            orientation: "horizontal",
            placementMode: "offset",
            offsetX: tag.offset_x_ft,
            offsetY: tag.offset_y_ft,
            max: 1
          },
          deferred_body: {
            tag_element: { created_by_action: placementAction, output: "created" }
          },
          expected_created_min: 1,
          expected_created_max: 1
        });
      });
    }
    actions.push(...pendingVentAudits);
  }

  for (const routeAction of actions.filter((entry) => entry.action_key.startsWith("route:"))) {
    const routeObservation = routeAction.observation_ids
      .map((observationId) => byId.get(observationId))
      .find((observation): observation is MepPipeRouteObservation | MechanicalDuctRouteObservation | ElectricalConduitRouteObservation =>
        observation?.kind === "pipe_route"
        || observation?.kind === "duct_route"
        || observation?.kind === "conduit_route");
    if (!routeObservation) continue;
    const metadata = provisionalRouteAttributes(routeObservation);
    if (metadata) routeAction.provisional_route_attributes = metadata;
  }

  let emittedActions = actions;
  let promotedObservationIds: string[] = [];
  let deferredObservationIds = ids.slice();
  if (blockers.length === 0 && ambiguities.length === 0) {
    promotedObservationIds = ids.slice();
    deferredObservationIds = [];
  } else if (blockers.length === 0 && partialPromotionPolicy === "defer_ambiguous_observations") {
    const directlyDeferred = new Set(ambiguities.flatMap((entry) => entry.related_plan_keys));
    emittedActions = actions.filter((entry) =>
      entry.observation_ids.every((observationId) => !directlyDeferred.has(observationId)));
    let changed = true;
    while (changed) {
      const availableActionKeys = new Set(emittedActions.map((entry) => entry.action_key));
      const next = emittedActions.filter((entry) =>
        entry.depends_on.every((dependency) => availableActionKeys.has(dependency)));
      changed = next.length !== emittedActions.length;
      emittedActions = next;
    }
    const promoted = new Set(emittedActions.flatMap((entry) => entry.observation_ids));
    promotedObservationIds = ids.filter((id) => promoted.has(id) && !directlyDeferred.has(id));
    deferredObservationIds = ids.filter((id) => !promotedObservationIds.includes(id));
    const dependencyDeferred = deferredObservationIds.filter((id) => !directlyDeferred.has(id));
    if (dependencyDeferred.length > 0) {
      warnings.push(`Clear observations deferred because their action graph depends on unresolved evidence: ${dependencyDeferred.join(", ")}.`);
    }
  } else {
    emittedActions = [];
  }

  const status: CompiledMepDraftPlan["status"] = blockers.length > 0
    ? "blocked"
    : ambiguities.length === 0 && provisionalObservationIds.length === 0
      ? "ready"
      : partialPromotionPolicy === "defer_ambiguous_observations" && emittedActions.length > 0
        ? "partially_ready"
        : "clarification_required";

  return {
    schema_version: 1,
    status,
    partial_promotion_policy: partialPromotionPolicy,
    promoted_observation_ids: promotedObservationIds,
    deferred_observation_ids: deferredObservationIds,
    provisional_observation_ids: provisionalObservationIds,
    fixture_id: fixtureId,
    scope_id: scopeId,
    input_fingerprint_sha256: inputFingerprint(input),
    registration,
    source_observations: sourceObservations,
    plan_elements: planElements,
    ambiguities,
    actions: emittedActions,
    blockers,
    warnings
  };
}

export function buildAtomicMepDraftWorkflowRequest(
  plan: CompiledMepDraftPlan,
  options: { dry_run?: boolean; maximum_created_elements?: number } = {}
): AtomicMepDraftWorkflowRequest {
  if (plan.status !== "ready" && plan.status !== "partially_ready") {
    throw new Error(`mep_draft_plan_not_ready:${plan.status}`);
  }
  const maximumCreatedElements = options.maximum_created_elements ?? Math.max(
    1,
    plan.actions.reduce((total, action) => total + Math.max(0, action.expected_created_max), 0)
  );
  if (!Number.isInteger(maximumCreatedElements) || maximumCreatedElements < 1 || maximumCreatedElements > 500) {
    throw new Error("maximum_created_elements_must_be_between_1_and_500");
  }
  return {
    inputFingerprintSha256: plan.input_fingerprint_sha256,
    provisionalObservationIds: plan.provisional_observation_ids,
    operations: plan.actions.map((entry) => ({
      action_key: entry.action_key,
      observation_ids: entry.observation_ids,
      path: entry.path,
      depends_on: entry.depends_on,
      expected_created_min: entry.expected_created_min,
      expected_created_max: entry.expected_created_max,
      ...(entry.apply_body ? { apply_body: entry.apply_body } : {}),
      ...(entry.deferred_body ? { deferred_body: entry.deferred_body } : {}),
      ...(entry.provisional_system_classification
        ? { provisional_system_classification: entry.provisional_system_classification }
        : {}),
      ...(entry.provisional_route_attributes
        ? { provisional_route_attributes: entry.provisional_route_attributes }
        : {}),
      ...(entry.provisional_plan_representation
        ? { provisional_plan_representation: entry.provisional_plan_representation }
        : {})
    })),
    dryRun: options.dry_run !== false,
    verify: true,
    maximumCreatedElements,
    ...(plan.status === "partially_ready" ? {
      benchmarkCredit: false as const,
      authorizationBasis: "explicit_unscored_user_direction" as const
    } : {})
  };
}
