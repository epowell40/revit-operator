import {
  engineeringCaseArtifactSha256,
  type EngineeringCaseNativeEvidence
} from "./engineering_case_runner.js";
import type { PlumbingFixtureEvidence } from "./engineering_invariants.js";

type JsonObject = Record<string, unknown>;

export type NativePoint = { x: number; y: number; z?: number };
export type NativeBounds = { min: NativePoint; max: NativePoint };

export type GfciNativeAdapterConfig = {
  schema_version: 1;
  case_id: string;
  standards_profile_sha256: string;
  starting_model_sha256: string;
  expected_model_sha256: string;
  check_id: string;
  room_number: string;
  scope_bounds_ft: NativeBounds;
  sink_match_tokens: string[];
  receptacle_match_tokens: string[];
  integral_protection_tokens: string[];
  location_classes: string[];
  receptacle_amps: number;
  sink_search_radius_ft: number;
  distance_measurement: "horizontal_clear_distance_to_sink_bbox";
};

export type DwellingWallCoverageNativeAdapterConfig = {
  schema_version: 1;
  case_id: string;
  standards_profile_sha256: string;
  starting_model_sha256: string;
  expected_model_sha256: string;
  check_id: string;
  room_number: string;
  room_classifications: string[];
  view_id: number;
  wall_segments: Array<{
    segment_id: string;
    expected_length_ft: number;
  }>;
  receptacle_match_tokens: string[];
  boundary_projection_tolerance_ft: number;
  segment_length_tolerance_ft: number;
};

export type CircuitLoadingNativeAdapterConfig = {
  schema_version: 1;
  case_id: string;
  standards_profile_sha256: string;
  starting_model_sha256: string;
  expected_model_sha256: string;
  check_id: string;
  room_number?: string;
  panel_name?: string;
  load_scope: "non_dwelling_general_use" | "dwelling_profile" | "project_specific";
  receptacle_match_tokens: string[];
  wire_ampacity_profiles: Array<{
    wire_size_token: string;
    ampacity_amps: number;
  }>;
  device_profiles: Array<{
    profile_id: string;
    family_match_tokens: string[];
    type_match_tokens: string[];
    yoke_or_strap_count: number;
    continuous: boolean;
  }>;
};

export type PlumbingFixtureServicesNativeAdapterConfig = {
  schema_version: 1;
  case_id: string;
  standards_profile_sha256: string;
  starting_model_sha256: string;
  expected_model_sha256: string;
  check_id: string;
  level_name: string;
  fixture_profiles: Array<{
    profile_id: string;
    fixture_class: string;
    fixture_subtype?: string | null;
    family_match_tokens: string[];
    type_match_tokens: string[];
  }>;
};

export type NativeParameterReadback = {
  id: number;
  name?: string;
  category?: string;
  parameters?: Record<string, unknown>;
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function finite(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function point(value: unknown): NativePoint | null {
  const raw = object(value);
  const x = finite(raw.x);
  const y = finite(raw.y);
  const z = finite(raw.z);
  return x == null || y == null ? null : { x, y, ...(z == null ? {} : { z }) };
}

function bounds(value: unknown): NativeBounds | null {
  const raw = object(value);
  const min = point(raw.min);
  const max = point(raw.max);
  if (!min || !max || min.x > max.x || min.y > max.y) return null;
  return { min, max };
}

function inBounds(candidate: NativePoint, scope: NativeBounds): boolean {
  return candidate.x >= scope.min.x && candidate.x <= scope.max.x
    && candidate.y >= scope.min.y && candidate.y <= scope.max.y;
}

function expandedBounds(scope: NativeBounds, distance: number): NativeBounds {
  return {
    min: { x: scope.min.x - distance, y: scope.min.y - distance },
    max: { x: scope.max.x + distance, y: scope.max.y + distance }
  };
}

function boundsIntersect(left: NativeBounds, right: NativeBounds): boolean {
  return left.min.x <= right.max.x && left.max.x >= right.min.x
    && left.min.y <= right.max.y && left.max.y >= right.min.y;
}

function tokenMatch(value: string, tokens: string[]): boolean {
  const normalized = value.toLowerCase();
  return tokens.some((token) => normalized.includes(token.toLowerCase()));
}

function searchableIdentity(element: JsonObject): string {
  return [element.familyName, element.typeName, element.name, element.category]
    .map(text)
    .filter(Boolean)
    .join(" | ");
}

function horizontalClearDistance(subject: NativePoint, targetPoint: NativePoint, targetBounds: NativeBounds | null): number {
  if (!targetBounds) return Math.hypot(subject.x - targetPoint.x, subject.y - targetPoint.y);
  const dx = subject.x < targetBounds.min.x
    ? targetBounds.min.x - subject.x
    : subject.x > targetBounds.max.x
      ? subject.x - targetBounds.max.x
      : 0;
  const dy = subject.y < targetBounds.min.y
    ? targetBounds.min.y - subject.y
    : subject.y > targetBounds.max.y
      ? subject.y - targetBounds.max.y
      : 0;
  return Math.hypot(dx, dy);
}

function projectToSegment(candidate: NativePoint, start: NativePoint, end: NativePoint): { offset_ft: number; distance_ft: number } {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 1e-12) return { offset_ft: 0, distance_ft: Math.hypot(candidate.x - start.x, candidate.y - start.y) };
  const raw = ((candidate.x - start.x) * dx + (candidate.y - start.y) * dy) / lengthSquared;
  const normalized = Math.max(0, Math.min(1, raw));
  const projectedX = start.x + normalized * dx;
  const projectedY = start.y + normalized * dy;
  return {
    offset_ft: normalized * Math.sqrt(lengthSquared),
    distance_ft: Math.hypot(candidate.x - projectedX, candidate.y - projectedY)
  };
}

function parseVoltageToGround(readback: NativeParameterReadback): number | null {
  const parameters = object(readback.parameters);
  for (const key of ["Voltage to Ground", "Voltage", "Electrical Data"]) {
    const value = text(parameters[key]);
    if (!value) continue;
    const match = value.match(/(?:^|\s)(\d+(?:\.\d+)?)\s*V(?:\b|\/)/i);
    if (match) return Number(match[1]);
    const direct = finite(value);
    if (direct != null && direct > 0) return direct;
  }
  return null;
}

function validateConfig(config: GfciNativeAdapterConfig): void {
  if (config.schema_version !== 1) throw new Error("gfci_adapter_schema_version_unsupported");
  if (!text(config.case_id) || !text(config.check_id) || !text(config.room_number)) throw new Error("gfci_adapter_identity_missing");
  if (!/^[a-f0-9]{64}$/i.test(text(config.standards_profile_sha256))) throw new Error("gfci_adapter_profile_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.starting_model_sha256))) throw new Error("gfci_adapter_starting_model_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.expected_model_sha256))) throw new Error("gfci_adapter_expected_model_hash_invalid");
  if (!bounds(config.scope_bounds_ft)) throw new Error("gfci_adapter_scope_bounds_invalid");
  for (const [name, values] of [
    ["sink_match_tokens", config.sink_match_tokens],
    ["receptacle_match_tokens", config.receptacle_match_tokens],
    ["integral_protection_tokens", config.integral_protection_tokens],
    ["location_classes", config.location_classes]
  ] as const) {
    if (!Array.isArray(values) || values.map(text).filter(Boolean).length === 0) throw new Error(`gfci_adapter_${name}_missing`);
  }
  if (!Number.isFinite(config.receptacle_amps) || config.receptacle_amps <= 0) throw new Error("gfci_adapter_receptacle_amps_invalid");
  if (!Number.isFinite(config.sink_search_radius_ft) || config.sink_search_radius_ft <= 0) throw new Error("gfci_adapter_sink_search_radius_invalid");
  if (config.distance_measurement !== "horizontal_clear_distance_to_sink_bbox") throw new Error("gfci_adapter_distance_measurement_invalid");
}

export function assertExpectedGfciModelSha256(config: GfciNativeAdapterConfig, actualSha256: string): void {
  validateConfig(config);
  if (text(config.expected_model_sha256).toLowerCase() !== text(actualSha256).toLowerCase()) {
    throw new Error("gfci_adapter_expected_model_hash_mismatch");
  }
}

export function selectGfciScopedElementIds(config: GfciNativeAdapterConfig, roomContents: unknown): number[] {
  validateConfig(config);
  const payload = object(roomContents);
  if (text(payload.roomNumber) !== text(config.room_number)) throw new Error("gfci_adapter_room_mismatch");
  const scope = bounds(config.scope_bounds_ft)!;
  const elements = Array.isArray(payload.elements) ? payload.elements.map(object) : [];
  return [...new Set(elements.filter((element) => {
    const candidate = point(element.point ?? element.center);
    return text(element.builtInCategory) === "OST_ElectricalFixtures"
      && tokenMatch(searchableIdentity(element), config.receptacle_match_tokens)
      && candidate != null
      && inBounds(candidate, scope);
  }).map((element) => Number(element.id)).filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

export function collectGfciNativeEvidence(
  config: GfciNativeAdapterConfig,
  roomContents: unknown,
  parameterReadbacks: NativeParameterReadback[]
): EngineeringCaseNativeEvidence {
  validateConfig(config);
  const payload = object(roomContents);
  if (text(payload.roomNumber) !== text(config.room_number)) throw new Error("gfci_adapter_room_mismatch");
  if (object(payload.diagnostics).matchedScopedCount == null) throw new Error("gfci_adapter_native_diagnostics_missing");
  const elements = Array.isArray(payload.elements) ? payload.elements.map(object) : [];
  if (elements.length === 0) throw new Error("gfci_adapter_elements_missing");
  const scope = bounds(config.scope_bounds_ft)!;
  const sinkScope = expandedBounds(scope, config.sink_search_radius_ft);
  const scopedIds = new Set(selectGfciScopedElementIds(config, roomContents));
  if (scopedIds.size === 0) throw new Error("gfci_adapter_scoped_receptacles_missing");

  const sinks = elements.map((element) => ({
    element,
    identity: searchableIdentity(element),
    point: point(element.point ?? element.center),
    bounds: bounds(element.bbox)
  })).filter((entry) =>
    text(entry.element.builtInCategory) === "OST_PlumbingFixtures"
    && tokenMatch(entry.identity, config.sink_match_tokens)
    && entry.point != null
    && (entry.bounds ? boundsIntersect(entry.bounds, sinkScope) : inBounds(entry.point, sinkScope)));
  if (sinks.length === 0) throw new Error("gfci_adapter_sink_geometry_missing");

  const readbacksById = new Map(parameterReadbacks.map((entry) => [Number(entry.id), entry]));
  const scopedReceptacles = elements.map((element) => ({
    element,
    identity: searchableIdentity(element),
    point: point(element.point ?? element.center)
  })).filter((entry) =>
    text(entry.element.builtInCategory) === "OST_ElectricalFixtures"
    && tokenMatch(entry.identity, config.receptacle_match_tokens)
    && entry.point != null
    && scopedIds.has(Number(entry.element.id)));
  if (scopedReceptacles.length === 0) throw new Error("gfci_adapter_scoped_receptacles_missing");

  const receptacles = scopedReceptacles.map((entry) => {
    const elementId = finite(entry.element.id);
    const elementKey = text(entry.element.sourceScopedId);
    if (elementId == null || !Number.isInteger(elementId) || !elementKey) throw new Error("gfci_adapter_receptacle_identity_invalid");
    const readback = readbacksById.get(elementId);
    if (!readback || text(readback.category) !== "Electrical Fixtures") {
      throw new Error(`gfci_adapter_parameter_readback_missing:${elementId}`);
    }
    const voltageToGround = parseVoltageToGround(readback);
    if (voltageToGround == null) throw new Error(`gfci_adapter_voltage_missing:${elementId}`);
    const nearest = sinks.map((sink) => ({
      sink,
      distance: horizontalClearDistance(entry.point!, sink.point!, sink.bounds)
    })).sort((a, b) => a.distance - b.distance || text(a.sink.element.sourceScopedId).localeCompare(text(b.sink.element.sourceScopedId)))[0]!;
    const integral = tokenMatch(text(readback.name), config.integral_protection_tokens);
    const circuit = object(entry.element.electricalCircuit);
    const systemIds = Array.isArray(circuit.powerSystemIds) ? circuit.powerSystemIds.map(Number).filter((id) => Number.isInteger(id) && id > 0) : [];
    return {
      element_key: elementKey,
      location_classes: config.location_classes.map(text),
      distance_to_sink_ft: Number(nearest.distance.toFixed(6)),
      voltage_to_ground: voltageToGround,
      receptacle_amps: config.receptacle_amps,
      ...(integral ? {
        protection: {
          method: "integral_device" as const,
          protection_device_key: elementKey,
          path_element_keys: [elementKey],
          native_path_verified: true,
          protected_circuit_id: systemIds.length === 1 ? `electrical-system:${systemIds[0]}` : null,
          receptacle_circuit_id: systemIds.length === 1 ? `electrical-system:${systemIds[0]}` : null
        }
      } : {}),
      native_collection: {
        room_number: text(config.room_number),
        receptacle_element_id: elementId,
        receptacle_family: text(entry.element.familyName),
        receptacle_type: text(entry.element.typeName || entry.element.name),
        nearest_sink_key: text(nearest.sink.element.sourceScopedId),
        nearest_sink_family: text(nearest.sink.element.familyName),
        nearest_sink_type: text(nearest.sink.element.typeName || nearest.sink.element.name),
        distance_measurement: config.distance_measurement,
        voltage_source: "get-parameters:Electrical Data",
        receptacle_amp_basis: "evaluator_case_scope",
        power_system_ids: systemIds
      }
    };
  });

  return {
    schema_version: 1,
    case_id: text(config.case_id),
    standards_profile_sha256: text(config.standards_profile_sha256).toLowerCase(),
    native_evidence_owner: "evaluator",
    native_readback: true,
    checks: [{ check_id: text(config.check_id), type: "gfci_protection", receptacles }],
    collection_receipt: {
      adapter: "room_contents_gfci_v1",
      room_number: text(config.room_number),
      geometric_scope: scope,
      sink_search_scope: sinkScope,
      starting_model_sha256: text(config.starting_model_sha256).toLowerCase(),
      expected_model_sha256: text(config.expected_model_sha256).toLowerCase(),
      room_contents_sha256: engineeringCaseArtifactSha256(roomContents),
      parameter_readbacks_sha256: engineeringCaseArtifactSha256(parameterReadbacks),
      adapter_config_sha256: engineeringCaseArtifactSha256(config),
      subject_element_ids_withheld_from_config: true,
      native_call_readback: true
    }
  } as EngineeringCaseNativeEvidence;
}

function validateDwellingWallCoverageConfig(config: DwellingWallCoverageNativeAdapterConfig): void {
  if (config.schema_version !== 1) throw new Error("dwelling_adapter_schema_version_unsupported");
  if (!text(config.case_id) || !text(config.check_id) || !text(config.room_number)) throw new Error("dwelling_adapter_identity_missing");
  if (!/^[a-f0-9]{64}$/i.test(text(config.standards_profile_sha256))) throw new Error("dwelling_adapter_profile_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.starting_model_sha256))) throw new Error("dwelling_adapter_starting_model_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.expected_model_sha256))) throw new Error("dwelling_adapter_expected_model_hash_invalid");
  if (!Number.isInteger(config.view_id) || config.view_id <= 0) throw new Error("dwelling_adapter_view_id_invalid");
  if (!Array.isArray(config.room_classifications) || config.room_classifications.map(text).filter(Boolean).length === 0) {
    throw new Error("dwelling_adapter_room_classifications_missing");
  }
  if (!Array.isArray(config.wall_segments) || config.wall_segments.length === 0) throw new Error("dwelling_adapter_wall_segments_missing");
  const segmentIds = config.wall_segments.map((segment) => text(segment.segment_id));
  if (segmentIds.some((segmentId) => !segmentId) || new Set(segmentIds).size !== segmentIds.length) {
    throw new Error("dwelling_adapter_wall_segment_identity_invalid");
  }
  if (config.wall_segments.some((segment) => !Number.isFinite(segment.expected_length_ft) || segment.expected_length_ft <= 0)) {
    throw new Error("dwelling_adapter_wall_segment_length_invalid");
  }
  if (!Array.isArray(config.receptacle_match_tokens) || config.receptacle_match_tokens.map(text).filter(Boolean).length === 0) {
    throw new Error("dwelling_adapter_receptacle_match_tokens_missing");
  }
  if (!Number.isFinite(config.boundary_projection_tolerance_ft) || config.boundary_projection_tolerance_ft < 0) {
    throw new Error("dwelling_adapter_boundary_projection_tolerance_invalid");
  }
  if (!Number.isFinite(config.segment_length_tolerance_ft) || config.segment_length_tolerance_ft < 0) {
    throw new Error("dwelling_adapter_segment_length_tolerance_invalid");
  }
}

export function assertExpectedDwellingWallCoverageModelSha256(
  config: DwellingWallCoverageNativeAdapterConfig,
  actualSha256: string
): void {
  validateDwellingWallCoverageConfig(config);
  if (text(config.expected_model_sha256).toLowerCase() !== text(actualSha256).toLowerCase()) {
    throw new Error("dwelling_adapter_expected_model_hash_mismatch");
  }
}

export function collectDwellingWallCoverageNativeEvidence(
  config: DwellingWallCoverageNativeAdapterConfig,
  plannerResponse: unknown,
  roomContents: unknown
): EngineeringCaseNativeEvidence {
  validateDwellingWallCoverageConfig(config);
  const planner = object(plannerResponse);
  if (text(planner.schema) !== "revit-operator.dwelling-receptacle-discovery-plan.v1") {
    throw new Error("dwelling_adapter_planner_schema_invalid");
  }
  const plannerRoom = object(planner.room);
  const plannerView = object(planner.view);
  if (text(plannerRoom.number) !== text(config.room_number)) throw new Error("dwelling_adapter_planner_room_mismatch");
  if (finite(plannerView.id) !== config.view_id) throw new Error("dwelling_adapter_planner_view_mismatch");

  const room = object(roomContents);
  if (text(room.roomNumber) !== text(config.room_number)) throw new Error("dwelling_adapter_room_contents_mismatch");
  if (object(room.diagnostics).matchedScopedCount == null) throw new Error("dwelling_adapter_native_diagnostics_missing");

  const discovery = object(planner.discovery);
  const discoveredWallSpaces = Array.isArray(discovery.wallSpaces) ? discovery.wallSpaces.map(object) : [];
  const expectedById = new Map(config.wall_segments.map((segment) => [text(segment.segment_id), segment]));
  const selectedWallSpaces = discoveredWallSpaces.filter((wallSpace) => expectedById.has(text(wallSpace.id)));
  const selectedSegmentIdList = selectedWallSpaces.map((wallSpace) => text(wallSpace.id));
  const selectedNativeSegmentIds = [...new Set(selectedSegmentIdList)].sort();
  const expectedSegmentIds = [...expectedById.keys()].sort();
  if (selectedSegmentIdList.length !== selectedNativeSegmentIds.length
    || engineeringCaseArtifactSha256(selectedNativeSegmentIds) !== engineeringCaseArtifactSha256(expectedSegmentIds)) {
    throw new Error("dwelling_adapter_target_wall_segment_identity_mismatch");
  }
  const nativeSegments = selectedWallSpaces.map((wallSpace) => {
    const segmentId = text(wallSpace.id);
    const expected = expectedById.get(segmentId)!;
    const start = point(wallSpace.start);
    const end = point(wallSpace.end);
    const length = finite(wallSpace.lengthFt);
    if (!start || !end || length == null || length <= 0) throw new Error(`dwelling_adapter_wall_geometry_invalid:${segmentId}`);
    if (Math.abs(length - expected.expected_length_ft) > config.segment_length_tolerance_ft) {
      throw new Error(`dwelling_adapter_wall_length_mismatch:${segmentId}`);
    }
    return { segment_id: segmentId, start, end, length_ft: length };
  });

  const roomElements = Array.isArray(room.elements) ? room.elements.map(object) : [];
  const projected = roomElements.map((element) => {
    const identity = searchableIdentity(element);
    const candidate = point(element.point ?? element.center);
    if (text(element.builtInCategory) !== "OST_ElectricalFixtures"
      || !tokenMatch(identity, config.receptacle_match_tokens)
      || !candidate) return null;
    const nearest = nativeSegments.map((segment) => ({
      segment,
      projection: projectToSegment(candidate, segment.start, segment.end)
    })).sort((left, right) => left.projection.distance_ft - right.projection.distance_ft
      || left.segment.segment_id.localeCompare(right.segment.segment_id))[0];
    if (!nearest || nearest.projection.distance_ft > config.boundary_projection_tolerance_ft) return null;
    const elementId = finite(element.id);
    const elementKey = text(element.sourceScopedId);
    if (elementId == null || !Number.isInteger(elementId) || elementId <= 0 || !elementKey) {
      throw new Error("dwelling_adapter_receptacle_identity_invalid");
    }
    return {
      element_id: elementId,
      element_key: elementKey,
      segment_id: nearest.segment.segment_id,
      offset_along_segment_ft: Number(nearest.projection.offset_ft.toFixed(6)),
      boundary_distance_ft: Number(nearest.projection.distance_ft.toFixed(6))
    };
  }).filter((entry): entry is NonNullable<typeof entry> => entry != null);

  const plannerExisting = Array.isArray(discovery.existingReceptacles) ? discovery.existingReceptacles.map(object) : [];
  const selectedSegmentIds = new Set(nativeSegments.map((segment) => segment.segment_id));
  const plannerExistingIds = [...new Set(plannerExisting
    .filter((entry) => selectedSegmentIds.has(text(entry.WallSpaceId ?? entry.wallSpaceId)))
    .map((entry) => finite(entry.ElementId ?? entry.elementId))
    .filter((id): id is number => id != null && Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
  const roomProjectedIds = [...new Set(projected.map((entry) => entry.element_id))].sort((a, b) => a - b);
  if (engineeringCaseArtifactSha256(plannerExistingIds) !== engineeringCaseArtifactSha256(roomProjectedIds)) {
    throw new Error("dwelling_adapter_planner_room_inventory_mismatch");
  }

  const excludedIds = Array.isArray(discovery.outsideSpatialNearBoundaryExcludedIds)
    ? [...new Set(discovery.outsideSpatialNearBoundaryExcludedIds.map(Number)
      .filter((id) => Number.isInteger(id) && id > 0))].sort((a, b) => a - b)
    : [];
  const excludedCount = finite(discovery.outsideSpatialNearBoundaryExcludedCount);
  if (excludedCount == null || excludedCount !== excludedIds.length) throw new Error("dwelling_adapter_exclusion_receipt_invalid");
  if (excludedIds.some((id) => roomProjectedIds.includes(id))) throw new Error("dwelling_adapter_excluded_target_room_receptacle");

  return {
    schema_version: 1,
    case_id: text(config.case_id),
    standards_profile_sha256: text(config.standards_profile_sha256).toLowerCase(),
    native_evidence_owner: "evaluator",
    native_readback: true,
    checks: [{
      check_id: text(config.check_id),
      type: "dwelling_wall_coverage",
      receptacles: projected.map((entry) => ({
        element_key: entry.element_key,
        segment_id: entry.segment_id,
        offset_along_segment_ft: entry.offset_along_segment_ft,
        counts_for_coverage: true,
        native_collection: {
          room_number: text(config.room_number),
          element_id: entry.element_id,
          boundary_distance_ft: entry.boundary_distance_ft
        }
      }))
    }],
    collection_receipt: {
      adapter: "plan_dwelling_receptacles_room_contents_v1",
      room_number: text(config.room_number),
      view_id: config.view_id,
      target_wall_segments: nativeSegments,
      starting_model_sha256: text(config.starting_model_sha256).toLowerCase(),
      expected_model_sha256: text(config.expected_model_sha256).toLowerCase(),
      planner_response_sha256: engineeringCaseArtifactSha256(plannerResponse),
      room_contents_sha256: engineeringCaseArtifactSha256(roomContents),
      adapter_config_sha256: engineeringCaseArtifactSha256(config),
      planner_existing_ids: plannerExistingIds,
      target_room_projected_ids: roomProjectedIds,
      outside_spatial_near_boundary_excluded_ids: excludedIds,
      direct_target_room_inventory_cross_check: true,
      planner_proposals_ignored: true,
      subject_element_ids_withheld_from_config: true,
      native_call_readback: true
    }
  } as EngineeringCaseNativeEvidence;
}

function validateCircuitLoadingConfig(config: CircuitLoadingNativeAdapterConfig): void {
  if (config.schema_version !== 1) throw new Error("circuit_adapter_schema_version_unsupported");
  if (!text(config.case_id) || !text(config.check_id)) throw new Error("circuit_adapter_identity_missing");
  const roomScope = Boolean(text(config.room_number));
  const panelScope = Boolean(text(config.panel_name));
  if (roomScope === panelScope) throw new Error("circuit_adapter_scope_identity_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.standards_profile_sha256))) throw new Error("circuit_adapter_profile_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.starting_model_sha256))) throw new Error("circuit_adapter_starting_model_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.expected_model_sha256))) throw new Error("circuit_adapter_expected_model_hash_invalid");
  if (!["non_dwelling_general_use", "dwelling_profile", "project_specific"].includes(config.load_scope)) {
    throw new Error("circuit_adapter_load_scope_invalid");
  }
  if (!Array.isArray(config.receptacle_match_tokens) || config.receptacle_match_tokens.map(text).filter(Boolean).length === 0) {
    throw new Error("circuit_adapter_receptacle_match_tokens_missing");
  }
  if (!Array.isArray(config.wire_ampacity_profiles) || config.wire_ampacity_profiles.length === 0
    || config.wire_ampacity_profiles.some((profile) => !text(profile.wire_size_token)
      || !Number.isFinite(profile.ampacity_amps) || profile.ampacity_amps <= 0)) {
    throw new Error("circuit_adapter_wire_ampacity_profiles_invalid");
  }
  if (!Array.isArray(config.device_profiles) || config.device_profiles.length === 0) throw new Error("circuit_adapter_device_profiles_missing");
  const profileIds = config.device_profiles.map((profile) => text(profile.profile_id));
  if (profileIds.some((id) => !id) || new Set(profileIds).size !== profileIds.length) throw new Error("circuit_adapter_device_profile_identity_invalid");
  if (config.device_profiles.some((profile) => !Array.isArray(profile.family_match_tokens)
    || profile.family_match_tokens.map(text).filter(Boolean).length === 0
    || !Array.isArray(profile.type_match_tokens)
    || profile.type_match_tokens.map(text).filter(Boolean).length === 0
    || !Number.isInteger(profile.yoke_or_strap_count)
    || profile.yoke_or_strap_count <= 0)) {
    throw new Error("circuit_adapter_device_profile_invalid");
  }
}

export function assertExpectedCircuitLoadingModelSha256(config: CircuitLoadingNativeAdapterConfig, actualSha256: string): void {
  validateCircuitLoadingConfig(config);
  if (text(config.expected_model_sha256).toLowerCase() !== text(actualSha256).toLowerCase()) {
    throw new Error("circuit_adapter_expected_model_hash_mismatch");
  }
}

export function selectCircuitLoadingScopedElementIds(config: CircuitLoadingNativeAdapterConfig, roomContents: unknown): number[] {
  validateCircuitLoadingConfig(config);
  if (text(config.panel_name)) throw new Error("circuit_adapter_panel_scope_is_native_discovery");
  const room = object(roomContents);
  if (text(room.roomNumber) !== text(config.room_number)) throw new Error("circuit_adapter_room_mismatch");
  return [...new Set((Array.isArray(room.elements) ? room.elements.map(object) : [])
    .filter((element) => text(element.builtInCategory) === "OST_ElectricalFixtures"
      && tokenMatch(searchableIdentity(element), config.receptacle_match_tokens))
    .map((element) => finite(element.id))
    .filter((id): id is number => id != null && Number.isInteger(id) && id > 0))].sort((a, b) => a - b);
}

function collectCircuitLoadingPanelNativeEvidence(
  config: CircuitLoadingNativeAdapterConfig,
  circuitAudit: unknown
): EngineeringCaseNativeEvidence {
  const audit = object(circuitAudit);
  const panelName = text(config.panel_name);
  if (text(audit.schema) !== "revit-operator.electrical-circuit-loading-audit.v1") throw new Error("circuit_adapter_audit_schema_invalid");
  if (text(audit.modelSha256).toLowerCase() !== text(config.expected_model_sha256).toLowerCase()) {
    throw new Error("circuit_adapter_expected_model_hash_mismatch");
  }
  if (text(audit.scopeMode) !== "panel_inventory" || text(audit.selectedPanelName).toLowerCase() !== panelName.toLowerCase()) {
    throw new Error("circuit_adapter_panel_scope_mismatch");
  }
  const panelElementId = finite(audit.selectedPanelElementId);
  if (panelElementId == null || !Number.isInteger(panelElementId) || panelElementId <= 0) {
    throw new Error("circuit_adapter_panel_identity_missing");
  }
  const diagnostics = object(audit.diagnostics);
  if (diagnostics.complete !== true || diagnostics.truncated === true || diagnostics.inventoryComplete !== true) {
    throw new Error("circuit_adapter_audit_incomplete");
  }

  const auditScopeIds = (Array.isArray(audit.scopeElementIds) ? audit.scopeElementIds : [])
    .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  const scopedDevices = Array.isArray(audit.scopedDevices) ? audit.scopedDevices.map(object) : [];
  const scopedDeviceIds = scopedDevices.map((device) => finite(device.elementId))
    .filter((id): id is number => id != null && Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  if (auditScopeIds.length === 0 || new Set(auditScopeIds).size !== auditScopeIds.length
    || new Set(scopedDeviceIds).size !== scopedDeviceIds.length
    || engineeringCaseArtifactSha256(auditScopeIds) !== engineeringCaseArtifactSha256(scopedDeviceIds)
    || finite(diagnostics.selectedElectricalFixtureCount) !== auditScopeIds.length) {
    throw new Error("circuit_adapter_scope_inventory_mismatch");
  }

  const deviceById = new Map<number, JsonObject>();
  const profileById = new Map<number, CircuitLoadingNativeAdapterConfig["device_profiles"][number]>();
  for (const device of scopedDevices) {
    const id = finite(device.elementId);
    const elementKey = text(device.sourceScopedId);
    if (id == null || !Number.isInteger(id) || id <= 0 || !elementKey || text(device.builtInCategory) !== "OST_ElectricalFixtures") {
      throw new Error("circuit_adapter_receptacle_identity_invalid");
    }
    deviceById.set(id, device);
    if (!tokenMatch(searchableIdentity(device), config.receptacle_match_tokens)) continue;
    const matches = config.device_profiles.filter((profile) => tokenMatch(text(device.familyName), profile.family_match_tokens)
      && tokenMatch(text(device.typeName || device.elementName), profile.type_match_tokens));
    if (matches.length !== 1) throw new Error(`circuit_adapter_device_profile_${matches.length === 0 ? "missing" : "ambiguous"}:${id}`);
    profileById.set(id, matches[0]!);
  }

  const circuitRows = Array.isArray(audit.circuits) ? audit.circuits.map(object) : [];
  if (circuitRows.length === 0) throw new Error("circuit_adapter_circuits_missing");
  const selectedRows: JsonObject[] = [];
  let excludedNonReceptacleCircuitCount = 0;
  for (const row of circuitRows) {
    const circuitId = text(row.circuitId);
    const memberIds = (Array.isArray(row.memberElementIds) ? row.memberElementIds : [])
      .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    const allNativeMemberIds = (Array.isArray(row.allNativeMemberElementIds) ? row.allNativeMemberElementIds : [])
      .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    if (!circuitId || memberIds.length === 0 || new Set(memberIds).size !== memberIds.length
      || new Set(allNativeMemberIds).size !== allNativeMemberIds.length
      || engineeringCaseArtifactSha256([...memberIds].sort((a, b) => a - b)) !== engineeringCaseArtifactSha256([...allNativeMemberIds].sort((a, b) => a - b))) {
      throw new Error("circuit_adapter_circuit_membership_invalid");
    }
    if (text(row.panelName).toLowerCase() !== panelName.toLowerCase() || finite(row.panelElementId) !== panelElementId) {
      throw new Error(`circuit_adapter_circuit_panel_mismatch:${circuitId}`);
    }
    const matchingCount = memberIds.filter((id) => profileById.has(id)).length;
    if (matchingCount === 0) {
      excludedNonReceptacleCircuitCount += 1;
      continue;
    }
    if (matchingCount !== memberIds.length) throw new Error(`circuit_adapter_mixed_load_circuit_unsupported:${circuitId}`);
    if (object(row.evidence).allCircuitMembersInsideScope !== true || row.otherLoadsNativeVerified !== true) {
      throw new Error(`circuit_adapter_circuit_scope_not_closed:${circuitId}`);
    }
    selectedRows.push(row);
  }
  if (selectedRows.length === 0) throw new Error("circuit_adapter_scoped_receptacles_missing");

  const selectedElementIds = selectedRows.flatMap((row) => (Array.isArray(row.memberElementIds) ? row.memberElementIds : []))
    .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
  if (new Set(selectedElementIds).size !== selectedElementIds.length) throw new Error("circuit_adapter_duplicate_circuit_assignment");
  const circuits = selectedRows.map((row) => {
    const circuitId = text(row.circuitId);
    const memberIds = (row.memberElementIds as unknown[]).map((value) => finite(value))
      .filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    const receptacles = memberIds.map((id) => {
      const device = deviceById.get(id);
      const profile = profileById.get(id);
      if (!device || !profile) throw new Error(`circuit_adapter_member_outside_scope:${id}`);
      return {
        element_key: text(device.sourceScopedId),
        yoke_or_strap_count: profile.yoke_or_strap_count,
        yoke_or_strap_count_profile_verified: true,
        continuous: profile.continuous,
        continuous_classification_profile_verified: true
      };
    });
    const voltage = finite(row.voltage);
    const phaseCount = finite(row.phaseCount);
    const breakerAmps = finite(row.breakerAmps);
    const conductorAmpacityAmps = finite(row.conductorAmpacityAmps);
    const otherContinuousVa = finite(row.otherContinuousVa);
    const otherNoncontinuousVa = finite(row.otherNoncontinuousVa);
    if (voltage == null || (phaseCount !== 1 && phaseCount !== 3) || breakerAmps == null || conductorAmpacityAmps == null
      || otherContinuousVa == null || otherNoncontinuousVa == null) throw new Error(`circuit_adapter_circuit_numeric_basis_invalid:${circuitId}`);
    return {
      circuit_id: circuitId,
      load_scope: config.load_scope,
      voltage,
      phase_count: phaseCount as 1 | 3,
      breaker_amps: breakerAmps,
      native_membership_verified: row.nativeMembershipVerified === true,
      native_ocpd_verified: row.nativeOcpdVerified === true,
      native_conductor_verified: row.nativeConductorVerified === true,
      conductor_ampacity_amps: conductorAmpacityAmps,
      conductor_ocpd_compatibility_verified: row.conductorOcpdCompatibilityVerified === true,
      receptacles,
      other_continuous_va: otherContinuousVa,
      other_noncontinuous_va: otherNoncontinuousVa,
      other_loads_native_verified: row.otherLoadsNativeVerified === true,
      listed_for_100_percent_continuous_operation: row.listedFor100PercentContinuousOperation === true,
      continuous_rating_native_verified: row.continuousRatingNativeVerified === true,
      continuous_rating_evidence_sha256: text(row.continuousRatingEvidenceSha256) || null
    };
  });
  const selectedKeys = selectedElementIds.map((id) => text(deviceById.get(id)?.sourceScopedId)).sort();
  return {
    schema_version: 1,
    case_id: text(config.case_id),
    standards_profile_sha256: text(config.standards_profile_sha256).toLowerCase(),
    native_evidence_owner: "evaluator",
    native_readback: true,
    checks: [{
      check_id: text(config.check_id),
      type: "receptacle_circuit_loading",
      scope_receptacle_element_keys: selectedKeys,
      native_scope_inventory_verified: true,
      circuits
    }],
    collection_receipt: {
      adapter: "panel_inventory_electrical_circuit_loading_v1",
      selected_panel_name: panelName,
      selected_panel_element_id: panelElementId,
      starting_model_sha256: text(config.starting_model_sha256).toLowerCase(),
      expected_model_sha256: text(config.expected_model_sha256).toLowerCase(),
      circuit_audit_sha256: engineeringCaseArtifactSha256(circuitAudit),
      adapter_config_sha256: engineeringCaseArtifactSha256(config),
      discovered_electrical_fixture_count: finite(diagnostics.discoveredElectricalFixtureCount),
      selected_panel_fixture_count: auditScopeIds.length,
      selected_receptacle_count: selectedElementIds.length,
      selected_receptacle_circuit_count: selectedRows.length,
      excluded_non_receptacle_circuit_count: excludedNonReceptacleCircuitCount,
      subject_element_ids_withheld_from_config: true,
      exact_coordinates_withheld_from_config: true,
      native_call_readback: true
    }
  } as EngineeringCaseNativeEvidence;
}

export function collectCircuitLoadingNativeEvidence(
  config: CircuitLoadingNativeAdapterConfig,
  roomContents: unknown,
  circuitAudit: unknown
): EngineeringCaseNativeEvidence {
  validateCircuitLoadingConfig(config);
  if (text(config.panel_name)) return collectCircuitLoadingPanelNativeEvidence(config, circuitAudit);
  const room = object(roomContents);
  if (text(room.roomNumber) !== text(config.room_number)) throw new Error("circuit_adapter_room_mismatch");
  if (object(room.diagnostics).matchedScopedCount == null) throw new Error("circuit_adapter_room_diagnostics_missing");
  const audit = object(circuitAudit);
  if (text(audit.schema) !== "revit-operator.electrical-circuit-loading-audit.v1") throw new Error("circuit_adapter_audit_schema_invalid");
  if (text(audit.modelSha256).toLowerCase() !== text(config.expected_model_sha256).toLowerCase()) {
    throw new Error("circuit_adapter_expected_model_hash_mismatch");
  }
  const diagnostics = object(audit.diagnostics);
  if (diagnostics.complete !== true || diagnostics.truncated === true) throw new Error("circuit_adapter_audit_incomplete");

  const roomElements = (Array.isArray(room.elements) ? room.elements.map(object) : []).filter((element) =>
    text(element.builtInCategory) === "OST_ElectricalFixtures"
    && tokenMatch(searchableIdentity(element), config.receptacle_match_tokens));
  if (roomElements.length === 0) throw new Error("circuit_adapter_scoped_receptacles_missing");
  const roomById = new Map<number, JsonObject>();
  const profileById = new Map<number, CircuitLoadingNativeAdapterConfig["device_profiles"][number]>();
  for (const element of roomElements) {
    const id = finite(element.id);
    const elementKey = text(element.sourceScopedId);
    if (id == null || !Number.isInteger(id) || id <= 0 || !elementKey) throw new Error("circuit_adapter_receptacle_identity_invalid");
    const family = text(element.familyName);
    const typeName = text(element.typeName || element.name);
    const matches = config.device_profiles.filter((profile) => tokenMatch(family, profile.family_match_tokens)
      && tokenMatch(typeName, profile.type_match_tokens));
    if (matches.length !== 1) throw new Error(`circuit_adapter_device_profile_${matches.length === 0 ? "missing" : "ambiguous"}:${id}`);
    roomById.set(id, element);
    profileById.set(id, matches[0]);
  }

  const auditScopeIds = (Array.isArray(audit.scopeElementIds) ? audit.scopeElementIds : [])
    .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  const roomIds = [...roomById.keys()].sort((a, b) => a - b);
  if (new Set(auditScopeIds).size !== auditScopeIds.length
    || engineeringCaseArtifactSha256(auditScopeIds) !== engineeringCaseArtifactSha256(roomIds)) {
    throw new Error("circuit_adapter_scope_inventory_mismatch");
  }

  const circuitRows = Array.isArray(audit.circuits) ? audit.circuits.map(object) : [];
  if (circuitRows.length === 0) throw new Error("circuit_adapter_circuits_missing");
  const circuits = circuitRows.map((row) => {
    const circuitId = text(row.circuitId);
    const memberIds = (Array.isArray(row.memberElementIds) ? row.memberElementIds : [])
      .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    if (!circuitId || memberIds.length === 0 || new Set(memberIds).size !== memberIds.length) {
      throw new Error("circuit_adapter_circuit_membership_invalid");
    }
    const receptacles = memberIds.map((id) => {
      const element = roomById.get(id);
      const profile = profileById.get(id);
      if (!element || !profile) throw new Error(`circuit_adapter_member_outside_scope:${id}`);
      return {
        element_key: text(element.sourceScopedId),
        yoke_or_strap_count: profile.yoke_or_strap_count,
        yoke_or_strap_count_profile_verified: true,
        continuous: profile.continuous,
        continuous_classification_profile_verified: true
      };
    });
    const voltage = finite(row.voltage);
    const phaseCount = finite(row.phaseCount);
    const breakerAmps = finite(row.breakerAmps);
    const conductorAmpacityAmps = finite(row.conductorAmpacityAmps);
    const otherContinuousVa = finite(row.otherContinuousVa);
    const otherNoncontinuousVa = finite(row.otherNoncontinuousVa);
    if (voltage == null || (phaseCount !== 1 && phaseCount !== 3) || breakerAmps == null || conductorAmpacityAmps == null
      || otherContinuousVa == null || otherNoncontinuousVa == null) throw new Error(`circuit_adapter_circuit_numeric_basis_invalid:${circuitId}`);
    return {
      circuit_id: circuitId,
      load_scope: config.load_scope,
      voltage,
      phase_count: phaseCount as 1 | 3,
      breaker_amps: breakerAmps,
      native_membership_verified: row.nativeMembershipVerified === true,
      native_ocpd_verified: row.nativeOcpdVerified === true,
      native_conductor_verified: row.nativeConductorVerified === true,
      conductor_ampacity_amps: conductorAmpacityAmps,
      conductor_ocpd_compatibility_verified: row.conductorOcpdCompatibilityVerified === true,
      receptacles,
      other_continuous_va: otherContinuousVa,
      other_noncontinuous_va: otherNoncontinuousVa,
      other_loads_native_verified: row.otherLoadsNativeVerified === true,
      listed_for_100_percent_continuous_operation: row.listedFor100PercentContinuousOperation === true,
      continuous_rating_native_verified: row.continuousRatingNativeVerified === true,
      continuous_rating_evidence_sha256: text(row.continuousRatingEvidenceSha256) || null
    };
  });

  return {
    schema_version: 1,
    case_id: text(config.case_id),
    standards_profile_sha256: text(config.standards_profile_sha256).toLowerCase(),
    native_evidence_owner: "evaluator",
    native_readback: true,
    checks: [{
      check_id: text(config.check_id),
      type: "receptacle_circuit_loading",
      scope_receptacle_element_keys: roomElements.map((element) => text(element.sourceScopedId)).sort(),
      native_scope_inventory_verified: true,
      circuits
    }],
    collection_receipt: {
      adapter: "room_contents_electrical_circuit_loading_v1",
      room_number: text(config.room_number),
      starting_model_sha256: text(config.starting_model_sha256).toLowerCase(),
      expected_model_sha256: text(config.expected_model_sha256).toLowerCase(),
      room_contents_sha256: engineeringCaseArtifactSha256(roomContents),
      circuit_audit_sha256: engineeringCaseArtifactSha256(circuitAudit),
      adapter_config_sha256: engineeringCaseArtifactSha256(config),
      subject_element_ids_withheld_from_config: true,
      exact_coordinates_withheld_from_config: true,
      native_call_readback: true
    }
  } as EngineeringCaseNativeEvidence;
}

const PLUMBING_SERVICE_BY_NATIVE_CLASSIFICATION: Record<string, "domestic_cold_water" | "domestic_hot_water" | "sanitary"> = {
  domesticcoldwater: "domestic_cold_water",
  domestichotwater: "domestic_hot_water",
  sanitary: "sanitary"
};

const PLUMBING_CANONICAL_CLASSIFICATION: Record<string, string> = {
  domesticcoldwater: "Domestic Cold Water",
  domestichotwater: "Domestic Hot Water",
  sanitary: "Sanitary",
  vent: "Vent"
};

function validatePlumbingFixtureServicesConfig(config: PlumbingFixtureServicesNativeAdapterConfig): void {
  if (config.schema_version !== 1) throw new Error("plumbing_adapter_schema_version_unsupported");
  if (!text(config.case_id) || !text(config.check_id) || !text(config.level_name)) throw new Error("plumbing_adapter_identity_missing");
  if (!/^[a-f0-9]{64}$/i.test(text(config.standards_profile_sha256))) throw new Error("plumbing_adapter_profile_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.starting_model_sha256))) throw new Error("plumbing_adapter_starting_model_hash_invalid");
  if (!/^[a-f0-9]{64}$/i.test(text(config.expected_model_sha256))) throw new Error("plumbing_adapter_expected_model_hash_invalid");
  if (!Array.isArray(config.fixture_profiles) || config.fixture_profiles.length === 0) throw new Error("plumbing_adapter_fixture_profiles_missing");
  const profileIds = config.fixture_profiles.map((profile) => text(profile.profile_id));
  if (profileIds.some((id) => !id) || new Set(profileIds).size !== profileIds.length) {
    throw new Error("plumbing_adapter_fixture_profile_identity_invalid");
  }
  if (config.fixture_profiles.some((profile) => !text(profile.fixture_class)
    || !Array.isArray(profile.family_match_tokens) || profile.family_match_tokens.map(text).filter(Boolean).length === 0
    || !Array.isArray(profile.type_match_tokens) || profile.type_match_tokens.map(text).filter(Boolean).length === 0)) {
    throw new Error("plumbing_adapter_fixture_profile_invalid");
  }
}

export function plumbingFixtureAuditDiscoveryTokens(config: PlumbingFixtureServicesNativeAdapterConfig): {
  familyMatchTokens: string[];
  typeMatchTokens: string[];
} {
  validatePlumbingFixtureServicesConfig(config);
  return {
    familyMatchTokens: [...new Set(config.fixture_profiles.flatMap((profile) => profile.family_match_tokens.map(text).filter(Boolean)))].sort(),
    typeMatchTokens: [...new Set(config.fixture_profiles.flatMap((profile) => profile.type_match_tokens.map(text).filter(Boolean)))].sort()
  };
}

export function assertExpectedPlumbingFixtureServicesModelSha256(
  config: PlumbingFixtureServicesNativeAdapterConfig,
  actualSha256: string
): void {
  validatePlumbingFixtureServicesConfig(config);
  if (text(config.expected_model_sha256).toLowerCase() !== text(actualSha256).toLowerCase()) {
    throw new Error("plumbing_adapter_expected_model_hash_mismatch");
  }
}

export function collectPlumbingFixtureServicesNativeEvidence(
  config: PlumbingFixtureServicesNativeAdapterConfig,
  plumbingAudit: unknown
): EngineeringCaseNativeEvidence {
  validatePlumbingFixtureServicesConfig(config);
  const audit = object(plumbingAudit);
  if (text(audit.schema) !== "revit-operator.plumbing-fixture-services-audit.v1") throw new Error("plumbing_adapter_audit_schema_invalid");
  if (text(audit.modelSha256).toLowerCase() !== text(config.expected_model_sha256).toLowerCase()) {
    throw new Error("plumbing_adapter_expected_model_hash_mismatch");
  }
  if (text(audit.scopeMode) !== "level_inventory" || text(audit.selectedLevelName).toLowerCase() !== text(config.level_name).toLowerCase()) {
    throw new Error("plumbing_adapter_level_scope_mismatch");
  }
  const diagnostics = object(audit.diagnostics);
  if (diagnostics.complete !== true || diagnostics.truncated === true || diagnostics.inventoryComplete !== true) {
    throw new Error("plumbing_adapter_audit_incomplete");
  }
  const rows = Array.isArray(audit.fixtures) ? audit.fixtures.map(object) : [];
  if (rows.length === 0 || finite(diagnostics.selectedPlumbingFixtureCount) !== rows.length) {
    throw new Error("plumbing_adapter_scope_inventory_mismatch");
  }
  const fixtureIds = rows.map((row) => finite(row.elementId));
  if (fixtureIds.some((id) => id == null || !Number.isInteger(id) || id <= 0)
    || new Set(fixtureIds as number[]).size !== fixtureIds.length) {
    throw new Error("plumbing_adapter_fixture_identity_invalid");
  }

  const fixtures = rows.map((row) => {
    const fixtureId = finite(row.elementId)!;
    const elementKey = text(row.sourceScopedId);
    if (elementKey !== `host:${fixtureId}` || text(row.builtInCategory) !== "OST_PlumbingFixtures"
      || text(row.levelName).toLowerCase() !== text(config.level_name).toLowerCase()
      || row.connectorInventoryComplete !== true) {
      throw new Error(`plumbing_adapter_fixture_native_identity_invalid:${fixtureId}`);
    }
    const matches = config.fixture_profiles.filter((profile) => tokenMatch(text(row.familyName), profile.family_match_tokens)
      && tokenMatch(text(row.typeName || row.elementName), profile.type_match_tokens));
    if (matches.length !== 1) throw new Error(`plumbing_adapter_fixture_profile_${matches.length === 0 ? "missing" : "ambiguous"}:${fixtureId}`);
    const profile = matches[0]!;
    const connectors = Array.isArray(row.connectors) ? row.connectors.map(object) : [];
    if (finite(row.connectorCount) !== connectors.length) throw new Error(`plumbing_adapter_connector_inventory_mismatch:${fixtureId}`);
    const connectorIndexes = connectors.map((connector) => finite(connector.connectorIndex));
    if (connectorIndexes.some((index) => index == null || !Number.isInteger(index) || index < 0)
      || new Set(connectorIndexes as number[]).size !== connectorIndexes.length) {
      throw new Error(`plumbing_adapter_connector_identity_invalid:${fixtureId}`);
    }
    const byService = new Map<string, JsonObject[]>();
    for (const connector of connectors) {
      const classification = text(connector.pipeSystemType).toLowerCase();
      const service = PLUMBING_SERVICE_BY_NATIVE_CLASSIFICATION[classification];
      if (!service) continue;
      const current = byService.get(service) ?? [];
      current.push(connector);
      byService.set(service, current);
    }
    for (const [service, candidates] of byService) {
      if (candidates.length > 1) throw new Error(`plumbing_adapter_service_connector_ambiguous:${fixtureId}:${service}`);
    }
    const services: PlumbingFixtureEvidence["services"] = [];
    for (const service of ["domestic_cold_water", "domestic_hot_water", "sanitary"] as const) {
      const connector = byService.get(service)?.[0];
      if (!connector) {
        services.push({
          service,
          native_reachable: false,
          native_absence_verified: true,
          native_path_verified: false,
          direct_connection: false,
          path_element_keys: [],
          system_ids: [],
          system_classification: ""
        });
        continue;
      }
      const directIds = (Array.isArray(connector.physicalConnectedElementIds) ? connector.physicalConnectedElementIds : [])
        .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
      const systemId = finite(connector.systemElementId);
      const nativeClassification = text(connector.pipeSystemType).toLowerCase();
      const diameter = finite(connector.diameterInches);
      if (directIds.length !== 1 || new Set(directIds).size !== 1 || connector.isPhysicallyConnected !== true
        || finite(connector.physicalConnectionCount) !== 1 || systemId == null || !Number.isInteger(systemId) || systemId <= 0
        || !PLUMBING_CANONICAL_CLASSIFICATION[nativeClassification]) {
        throw new Error(`plumbing_adapter_direct_path_unverified:${fixtureId}:${service}`);
      }
      services.push({
        service,
        native_reachable: true,
        native_absence_verified: false,
        native_path_verified: true,
        direct_connection: true,
        path_element_keys: [elementKey, `host:${directIds[0]}`],
        path_edges_native_verified: true,
        system_ids: [`piping-system:${systemId}`],
        system_classification: PLUMBING_CANONICAL_CLASSIFICATION[nativeClassification],
        connection_size_inches: diameter,
        connection_size_native_verified: diameter != null && diameter > 0
      });
    }

    const sanitary = byService.get("sanitary")?.[0];
    const vent = object(sanitary?.ventContinuation);
    const ventPathIds = (Array.isArray(vent.pathElementIds) ? vent.pathElementIds : [])
      .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    const ventSystemIds = (Array.isArray(vent.ventSystemElementIds) ? vent.ventSystemElementIds : [])
      .map(finite).filter((id): id is number => id != null && Number.isInteger(id) && id > 0);
    const pathEdges = Array.isArray(vent.pathEdges) ? vent.pathEdges.map(object) : [];
    const pathCategories = Array.isArray(vent.pathElementCategories) ? vent.pathElementCategories.map(text).filter(Boolean) : [];
    const ventProven = Boolean(sanitary)
      && vent.found === true && vent.complete === true && vent.truncated !== true
      && ventPathIds.length >= 3 && ventPathIds[0] === fixtureId
      && new Set(ventPathIds).size === ventPathIds.length
      && ventSystemIds.length > 0 && new Set(ventSystemIds).size === ventSystemIds.length
      && pathEdges.length === ventPathIds.length - 1
      && pathEdges.every((edge, index) => finite(edge.fromElementId) === ventPathIds[index]
        && finite(edge.toElementId) === ventPathIds[index + 1])
      && pathCategories.length > 0
      && pathCategories.every((category) => ["OST_PipeCurves", "OST_PipeFitting", "OST_PipeAccessory"].includes(category));
    services.push(ventProven ? {
      service: "vented_drainage",
      native_reachable: true,
      native_absence_verified: false,
      native_path_verified: true,
      direct_connection: false,
      path_element_keys: ventPathIds.map((id) => `host:${id}`),
      path_edges_native_verified: true,
      path_element_categories: pathCategories,
      continuation_kind: "native_vent_system_continuation",
      system_ids: ventSystemIds.map((id) => `piping-system:${id}`),
      system_classification: "Vent"
    } : {
      service: "vented_drainage",
      native_reachable: false,
      native_absence_verified: vent.complete === true && vent.truncated !== true,
      native_path_verified: false,
      direct_connection: false,
      path_element_keys: [],
      system_ids: [],
      system_classification: ""
    });
    return {
      element_key: elementKey,
      fixture_class: text(profile.fixture_class),
      fixture_subtype: text(profile.fixture_subtype) || null,
      services
    };
  });

  return {
    schema_version: 1,
    case_id: text(config.case_id),
    standards_profile_sha256: text(config.standards_profile_sha256).toLowerCase(),
    native_evidence_owner: "evaluator",
    native_readback: true,
    checks: [{
      check_id: text(config.check_id),
      type: "plumbing_fixture_services",
      fixtures
    }],
    collection_receipt: {
      adapter: "level_inventory_plumbing_fixture_services_v1",
      selected_level_name: text(config.level_name),
      starting_model_sha256: text(config.starting_model_sha256).toLowerCase(),
      expected_model_sha256: text(config.expected_model_sha256).toLowerCase(),
      plumbing_audit_sha256: engineeringCaseArtifactSha256(plumbingAudit),
      adapter_config_sha256: engineeringCaseArtifactSha256(config),
      discovered_plumbing_fixture_count: finite(diagnostics.discoveredPlumbingFixtureCount),
      selected_plumbing_fixture_count: fixtures.length,
      subject_element_ids_withheld_from_config: true,
      exact_coordinates_withheld_from_config: true,
      native_call_readback: true
    }
  } as EngineeringCaseNativeEvidence;
}
