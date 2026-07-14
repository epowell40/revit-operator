import {
  engineeringCaseArtifactSha256,
  type EngineeringCaseNativeEvidence
} from "./engineering_case_runner.js";

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
