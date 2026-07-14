import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExpectedCircuitLoadingModelSha256,
  assertExpectedDwellingWallCoverageModelSha256,
  assertExpectedGfciModelSha256,
  collectCircuitLoadingNativeEvidence,
  collectDwellingWallCoverageNativeEvidence,
  collectGfciNativeEvidence,
  type DwellingWallCoverageNativeAdapterConfig,
  type GfciNativeAdapterConfig,
  type CircuitLoadingNativeAdapterConfig
} from "../src/existing_conditions/engineering_native_adapters.js";

const PROFILE = "e28ae52a495eaeec357987854c75d5f1cfec1b455a71c6612f74b5a235ef373e";

function config(bounds = { min: { x: 0, y: 0 }, max: { x: 12, y: 8 } }): GfciNativeAdapterConfig {
  return {
    schema_version: 1,
    case_id: "live-gfci-room-403-v1",
    standards_profile_sha256: PROFILE,
    starting_model_sha256: "c".repeat(64),
    expected_model_sha256: "a".repeat(64),
    check_id: "sink-protection",
    room_number: "403",
    scope_bounds_ft: bounds,
    sink_match_tokens: ["sink", "vanity", "lavatory"],
    receptacle_match_tokens: ["receptacle"],
    integral_protection_tokens: ["gfci", "g.f.c.i."],
    location_classes: ["dwelling_sink"],
    receptacle_amps: 20,
    sink_search_radius_ft: 6,
    distance_measurement: "horizontal_clear_distance_to_sink_bbox"
  };
}

function nativePayload(typeName = "Standard", receptaclePoint = { x: 4, y: 3, z: 4 }) {
  return {
    roomNumber: "403",
    diagnostics: { matchedScopedCount: 3 },
    elements: [
      {
        id: 101,
        sourceScopedId: "host:101",
        builtInCategory: "OST_ElectricalFixtures",
        category: "Electrical Fixtures",
        familyName: "Duplex Receptacle",
        typeName,
        name: typeName,
        point: receptaclePoint,
        bbox: { min: { x: receptaclePoint.x - 0.1, y: receptaclePoint.y - 0.1 }, max: { x: receptaclePoint.x + 0.1, y: receptaclePoint.y + 0.1 } },
        electricalCircuit: { powerSystemIds: [9001], exactPowerSystemCount: 1 },
        source: { scope: "host", hostDocumentPath: "C:/fixtures/electrical.rvt" }
      },
      {
        id: 202,
        sourceScopedId: "link:12:202",
        builtInCategory: "OST_PlumbingFixtures",
        category: "Plumbing Fixtures",
        familyName: "SinkConnection",
        typeName: "Kitchen Sink",
        name: "Kitchen Sink",
        point: { x: 8, y: 3, z: 3 },
        bbox: { min: { x: 7.5, y: 2.5 }, max: { x: 8.5, y: 3.5 } },
        source: { scope: "linked", sourceDocumentPath: "C:/fixtures/plumbing.rvt" }
      },
      {
        id: 303,
        sourceScopedId: "link:12:303",
        builtInCategory: "OST_PlumbingFixtures",
        category: "Plumbing Fixtures",
        familyName: "Water Closet",
        typeName: "Tank",
        name: "Toilet-Domestic-3D",
        point: { x: 4.1, y: 3, z: 3 },
        bbox: { min: { x: 3.5, y: 2.5 }, max: { x: 4.5, y: 3.5 } }
      }
    ]
  };
}

const parameters = [{
  id: 101,
  name: "Standard",
  category: "Electrical Fixtures",
  parameters: { "Electrical Data": "120 V/1-180 VA" }
}];

test("collects geometric GFCI evidence from native room and parameter readbacks without target element IDs in config", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload(), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles.length, 1);
  assert.equal(check.receptacles[0]?.element_key, "host:101");
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
  assert.equal(check.receptacles[0]?.voltage_to_ground, 120);
  assert.equal(check.receptacles[0]?.protection, undefined);
  assert.equal((evidence.collection_receipt as Record<string, unknown>).subject_element_ids_withheld_from_config, true);
});

test("accepts a geometrically different integral GFCI solution and records native circuit association", () => {
  const evidence = collectGfciNativeEvidence(
    config({ min: { x: 10, y: -5 }, max: { x: 25, y: 10 } }),
    nativePayload("GFCI", { x: 12, y: 3, z: 4 }),
    [{ ...parameters[0]!, name: "GFCI" }]
  );
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
  assert.equal(check.receptacles[0]?.protection?.method, "integral_device");
  assert.deepEqual(check.receptacles[0]?.protection?.path_element_keys, ["host:101"]);
  assert.deepEqual((check.receptacles[0] as unknown as { native_collection: { power_system_ids: number[] } }).native_collection.power_system_ids, [9001]);
});

test("requires the per-element parameter readback to prove the integral GFCI type", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload("GFCI"), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.protection, undefined);
});

test("uses sink bbox clear distance instead of memorized source coordinates or fixture origin distance", () => {
  const evidence = collectGfciNativeEvidence(config(), nativePayload("Standard", { x: 7, y: 3, z: 4 }), parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 0.5);
});

test("rejects missing native voltage readback instead of filling a convenient benchmark answer", () => {
  assert.throws(
    () => collectGfciNativeEvidence(config(), nativePayload(), [{ id: 101, category: "Electrical Fixtures", parameters: {} }]),
    /gfci_adapter_voltage_missing:101/
  );
});

test("does not let a nearby toilet satisfy the sink geometry requirement", () => {
  const payload = nativePayload();
  payload.elements = payload.elements.filter((element) => element.id !== 202);
  assert.throws(() => collectGfciNativeEvidence(config(), payload, parameters), /gfci_adapter_sink_geometry_missing/);
});

test("requires geometric scope to contain a native receptacle", () => {
  assert.throws(
    () => collectGfciNativeEvidence(config({ min: { x: 20, y: 20 }, max: { x: 30, y: 30 } }), nativePayload(), parameters),
    /gfci_adapter_scoped_receptacles_missing/
  );
});

test("rejects a live capture whose active model hash differs from evaluator configuration", () => {
  assert.throws(() => assertExpectedGfciModelSha256(config(), "b".repeat(64)), /gfci_adapter_expected_model_hash_mismatch/);
  assert.doesNotThrow(() => assertExpectedGfciModelSha256(config(), "a".repeat(64)));
});

test("ignores a token-matching sink outside the bounded search region", () => {
  const payload = nativePayload("Standard", { x: 4, y: 3, z: 4 });
  payload.elements.push({
    id: 404,
    sourceScopedId: "link:12:404",
    builtInCategory: "OST_PlumbingFixtures",
    category: "Plumbing Fixtures",
    familyName: "Sink",
    typeName: "Out of scope",
    name: "Sink",
    point: { x: 20, y: 3, z: 3 },
    bbox: { min: { x: 19.9, y: 2.9 }, max: { x: 20.1, y: 3.1 } }
  });
  const evidence = collectGfciNativeEvidence(config(), payload, parameters);
  const check = evidence.checks[0];
  assert.equal(check?.type, "gfci_protection");
  if (check?.type !== "gfci_protection") return;
  assert.equal(check.receptacles[0]?.distance_to_sink_ft, 3.5);
});

function dwellingConfig(): DwellingWallCoverageNativeAdapterConfig {
  return {
    schema_version: 1,
    case_id: "live-dwelling-wall-coverage-v1",
    standards_profile_sha256: PROFILE,
    starting_model_sha256: "c".repeat(64),
    expected_model_sha256: "d".repeat(64),
    check_id: "shared-wall-coverage",
    room_number: "403",
    room_classifications: ["live_work_unit"],
    view_id: 1363337,
    wall_segments: [{ segment_id: "shared-wall-a", expected_length_ft: 13 }],
    receptacle_match_tokens: ["receptacle", "outlet"],
    boundary_projection_tolerance_ft: 0.25,
    segment_length_tolerance_ft: 0.001
  };
}

function dwellingPlanner(existingIds = [101], excludedIds = [202]) {
  return {
    schema: "revit-operator.dwelling-receptacle-discovery-plan.v1",
    status: "ready",
    room: { id: 500, number: "403", kind: "Space" },
    view: { id: 1363337, name: "L4 - Power" },
    discovery: {
      outsideSpatialNearBoundaryExcludedCount: excludedIds.length,
      outsideSpatialNearBoundaryExcludedIds: excludedIds,
      wallSpaces: [{
        id: "shared-wall-a",
        start: { x: 0, y: 0, z: 4 },
        end: { x: 13, y: 0, z: 4 },
        lengthFt: 13,
        exclusions: []
      }],
      existingReceptacles: existingIds.map((id, index) => ({
        ElementId: id,
        WallSpaceId: "shared-wall-a",
        ChainageFt: index === 0 ? 6.8 : 12,
        CountsTowardGeneralSpacing: true
      }))
    },
    plan: {
      ProposedPlacements: [{ Point: { X: 3, Y: 0, Z: 4 } }]
    }
  };
}

function dwellingRoomContents(points: Array<{ id: number; x: number }> = [{ id: 101, x: 6.8 }]) {
  return {
    roomNumber: "403",
    diagnostics: { matchedScopedCount: points.length },
    elements: points.map(({ id, x }) => ({
      id,
      sourceScopedId: `host:${id}`,
      builtInCategory: "OST_ElectricalFixtures",
      category: "Electrical Fixtures",
      familyName: "Duplex Receptacle",
      typeName: "Standard",
      name: "Standard",
      point: { x, y: 0.05, z: 4 }
    }))
  };
}

test("derives dwelling coverage offsets from target-room native points and ignores planner proposals", () => {
  const evidence = collectDwellingWallCoverageNativeEvidence(
    dwellingConfig(),
    dwellingPlanner(),
    dwellingRoomContents()
  );
  const check = evidence.checks[0];
  assert.equal(check?.type, "dwelling_wall_coverage");
  if (check?.type !== "dwelling_wall_coverage") return;
  assert.deepEqual(check.receptacles.map((entry) => entry.offset_along_segment_ft), [6.8]);
  const receipt = evidence.collection_receipt as Record<string, unknown>;
  assert.equal(receipt.direct_target_room_inventory_cross_check, true);
  assert.equal(receipt.planner_proposals_ignored, true);
  assert.equal(receipt.subject_element_ids_withheld_from_config, true);
  assert.equal(JSON.stringify(dwellingConfig()).includes("101"), false);
});

test("accepts geometrically different native layouts without memorizing one accepted coordinate set", () => {
  const evidence = collectDwellingWallCoverageNativeEvidence(
    dwellingConfig(),
    dwellingPlanner([301, 302]),
    dwellingRoomContents([{ id: 301, x: 1 }, { id: 302, x: 12 }])
  );
  const check = evidence.checks[0];
  assert.equal(check?.type, "dwelling_wall_coverage");
  if (check?.type !== "dwelling_wall_coverage") return;
  assert.deepEqual(check.receptacles.map((entry) => entry.offset_along_segment_ft), [1, 12]);
});

test("rejects planner receptacles that are absent from the independent target-room inventory", () => {
  assert.throws(
    () => collectDwellingWallCoverageNativeEvidence(
      dwellingConfig(),
      dwellingPlanner([101, 202]),
      dwellingRoomContents()
    ),
    /dwelling_adapter_planner_room_inventory_mismatch/
  );
});

test("rejects an excluded adjacent-space ID if independent room evidence says it belongs to the target", () => {
  assert.throws(
    () => collectDwellingWallCoverageNativeEvidence(
      dwellingConfig(),
      dwellingPlanner([101], [101]),
      dwellingRoomContents()
    ),
    /dwelling_adapter_excluded_target_room_receptacle/
  );
});

test("rejects duplicate planner wall IDs that conceal a missing configured segment", () => {
  const config = dwellingConfig();
  config.wall_segments = [
    { segment_id: "shared-wall-a", expected_length_ft: 13 },
    { segment_id: "shared-wall-b", expected_length_ft: 13 }
  ];
  const planner = dwellingPlanner();
  planner.discovery.wallSpaces = [planner.discovery.wallSpaces[0]!, { ...planner.discovery.wallSpaces[0]! }];
  assert.throws(
    () => collectDwellingWallCoverageNativeEvidence(config, planner, dwellingRoomContents()),
    /dwelling_adapter_target_wall_segment_identity_mismatch/
  );
});

test("binds dwelling native capture to the configured model hash", () => {
  assert.throws(
    () => assertExpectedDwellingWallCoverageModelSha256(dwellingConfig(), "e".repeat(64)),
    /dwelling_adapter_expected_model_hash_mismatch/
  );
  assert.doesNotThrow(() => assertExpectedDwellingWallCoverageModelSha256(dwellingConfig(), "d".repeat(64)));
});

function circuitConfig(): CircuitLoadingNativeAdapterConfig {
  return {
    schema_version: 1,
    case_id: "live-circuit-office-v1",
    standards_profile_sha256: PROFILE,
    starting_model_sha256: "b".repeat(64),
    expected_model_sha256: "f".repeat(64),
    check_id: "receptacle-circuit-load",
    room_number: "Office 201",
    load_scope: "non_dwelling_general_use",
    receptacle_match_tokens: ["receptacle"],
    wire_ampacity_profiles: [{ wire_size_token: "#12", ampacity_amps: 20 }],
    device_profiles: [
      { profile_id: "duplex-one-yoke", family_match_tokens: ["receptacle"], type_match_tokens: ["duplex"], yoke_or_strap_count: 1, continuous: false },
      { profile_id: "quad-two-yokes", family_match_tokens: ["receptacle"], type_match_tokens: ["quad"], yoke_or_strap_count: 2, continuous: false }
    ]
  };
}

function circuitRoomContents() {
  return {
    roomNumber: "Office 201",
    diagnostics: { matchedScopedCount: 3 },
    elements: [
      { id: 11, sourceScopedId: "host:11", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Duplex" },
      { id: 12, sourceScopedId: "host:12", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Quad" },
      { id: 13, sourceScopedId: "host:13", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Duplex" }
    ]
  };
}

function circuitAudit(memberGroups: number[][] = [[11, 12], [13]]) {
  return {
    schema: "revit-operator.electrical-circuit-loading-audit.v1",
    modelSha256: "f".repeat(64),
    scopeElementIds: [11, 12, 13],
    diagnostics: { complete: true, truncated: false },
    circuits: memberGroups.map((memberElementIds, index) => ({
      circuitId: `P1-${index * 2 + 1}`,
      memberElementIds,
      voltage: 120,
      phaseCount: 1,
      breakerAmps: 20,
      nativeMembershipVerified: true,
      nativeOcpdVerified: true,
      nativeConductorVerified: true,
      conductorAmpacityAmps: 20,
      conductorOcpdCompatibilityVerified: true,
      otherContinuousVa: 0,
      otherNoncontinuousVa: 0,
      otherLoadsNativeVerified: true
    }))
  };
}

test("circuit adapter derives yokes from native family types and accepts alternate circuit groupings", () => {
  const first = collectCircuitLoadingNativeEvidence(circuitConfig(), circuitRoomContents(), circuitAudit());
  const alternate = collectCircuitLoadingNativeEvidence(circuitConfig(), circuitRoomContents(), circuitAudit([[11, 13], [12]]));
  for (const evidence of [first, alternate]) {
    const check = evidence.checks[0];
    assert.equal(check?.type, "receptacle_circuit_loading");
    if (check?.type !== "receptacle_circuit_loading") continue;
    assert.deepEqual(check.scope_receptacle_element_keys, ["host:11", "host:12", "host:13"]);
    assert.equal(check.circuits.flatMap((circuit) => circuit.receptacles).reduce((sum, receptacle) => sum + receptacle.yoke_or_strap_count, 0), 4);
  }
});

test("circuit adapter fails closed on incomplete scope, ambiguous device profiles, and out-of-scope members", () => {
  const incomplete = circuitAudit();
  incomplete.diagnostics.truncated = true;
  assert.throws(() => collectCircuitLoadingNativeEvidence(circuitConfig(), circuitRoomContents(), incomplete), /circuit_adapter_audit_incomplete/);
  const ambiguousConfig = circuitConfig();
  ambiguousConfig.device_profiles.push({ ...ambiguousConfig.device_profiles[0]!, profile_id: "duplicate-duplex" });
  assert.throws(() => collectCircuitLoadingNativeEvidence(ambiguousConfig, circuitRoomContents(), circuitAudit()), /circuit_adapter_device_profile_ambiguous:11/);
  const outOfScope = circuitAudit([[11, 99], [12, 13]]);
  assert.throws(() => collectCircuitLoadingNativeEvidence(circuitConfig(), circuitRoomContents(), outOfScope), /circuit_adapter_member_outside_scope:99/);
});

test("binds circuit native capture to the configured model hash", () => {
  assert.throws(() => assertExpectedCircuitLoadingModelSha256(circuitConfig(), "e".repeat(64)), /circuit_adapter_expected_model_hash_mismatch/);
  assert.doesNotThrow(() => assertExpectedCircuitLoadingModelSha256(circuitConfig(), "f".repeat(64)));
});

function panelCircuitConfig(): CircuitLoadingNativeAdapterConfig {
  const config = circuitConfig();
  delete config.room_number;
  config.panel_name = "P205";
  return config;
}

function panelCircuitAudit() {
  return {
    schema: "revit-operator.electrical-circuit-loading-audit.v1",
    modelSha256: "f".repeat(64),
    scopeMode: "panel_inventory",
    selectedPanelName: "P205",
    selectedPanelElementId: 500,
    scopeElementIds: [11, 12, 13, 20],
    scopedDevices: [
      { elementId: 11, sourceScopedId: "host:11", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Duplex" },
      { elementId: 12, sourceScopedId: "host:12", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Quad" },
      { elementId: 13, sourceScopedId: "host:13", builtInCategory: "OST_ElectricalFixtures", familyName: "General Receptacle", typeName: "Duplex" },
      { elementId: 20, sourceScopedId: "host:20", builtInCategory: "OST_ElectricalFixtures", familyName: "Mechanical Equipment Connection", typeName: "208V" }
    ],
    diagnostics: {
      complete: true,
      truncated: false,
      inventoryComplete: true,
      discoveredElectricalFixtureCount: 40,
      selectedElectricalFixtureCount: 4
    },
    circuits: [
      {
        circuitId: "P205-1",
        panelName: "P205",
        panelElementId: 500,
        memberElementIds: [11, 12],
        allNativeMemberElementIds: [11, 12],
        voltage: 120,
        phaseCount: 1,
        breakerAmps: 20,
        nativeMembershipVerified: true,
        nativeOcpdVerified: true,
        nativeConductorVerified: true,
        conductorAmpacityAmps: 20,
        conductorOcpdCompatibilityVerified: true,
        otherContinuousVa: 0,
        otherNoncontinuousVa: 0,
        otherLoadsNativeVerified: true,
        evidence: { allCircuitMembersInsideScope: true }
      },
      {
        circuitId: "P205-3",
        panelName: "P205",
        panelElementId: 500,
        memberElementIds: [13],
        allNativeMemberElementIds: [13],
        voltage: 120,
        phaseCount: 1,
        breakerAmps: 20,
        nativeMembershipVerified: true,
        nativeOcpdVerified: true,
        nativeConductorVerified: true,
        conductorAmpacityAmps: 20,
        conductorOcpdCompatibilityVerified: true,
        otherContinuousVa: 0,
        otherNoncontinuousVa: 0,
        otherLoadsNativeVerified: true,
        evidence: { allCircuitMembersInsideScope: true }
      },
      {
        circuitId: "P205-16",
        panelName: "P205",
        panelElementId: 500,
        memberElementIds: [20],
        allNativeMemberElementIds: [20],
        voltage: 208,
        phaseCount: 1,
        breakerAmps: 40,
        nativeMembershipVerified: true,
        nativeOcpdVerified: true,
        nativeConductorVerified: true,
        conductorAmpacityAmps: 40,
        conductorOcpdCompatibilityVerified: true,
        otherContinuousVa: 0,
        otherNoncontinuousVa: 0,
        otherLoadsNativeVerified: true,
        evidence: { allCircuitMembersInsideScope: true }
      }
    ]
  };
}

test("panel circuit adapter derives a complete native receptacle scope without configured element or circuit ids", () => {
  const evidence = collectCircuitLoadingNativeEvidence(panelCircuitConfig(), null, panelCircuitAudit());
  const check = evidence.checks[0];
  assert.equal(check?.type, "receptacle_circuit_loading");
  if (check?.type !== "receptacle_circuit_loading") return;
  assert.deepEqual(check.scope_receptacle_element_keys, ["host:11", "host:12", "host:13"]);
  assert.deepEqual(check.circuits.map((circuit) => circuit.circuit_id), ["P205-1", "P205-3"]);
  assert.equal(evidence.collection_receipt?.selected_panel_element_id, 500);
  assert.equal(evidence.collection_receipt?.excluded_non_receptacle_circuit_count, 1);
});

test("panel circuit adapter rejects inventory, panel, mixed-load, and duplicate-assignment leakage", () => {
  const incomplete = panelCircuitAudit();
  incomplete.diagnostics.inventoryComplete = false;
  assert.throws(() => collectCircuitLoadingNativeEvidence(panelCircuitConfig(), null, incomplete), /circuit_adapter_audit_incomplete/);

  const wrongPanel = panelCircuitAudit();
  wrongPanel.circuits[0]!.panelElementId = 999;
  assert.throws(() => collectCircuitLoadingNativeEvidence(panelCircuitConfig(), null, wrongPanel), /circuit_adapter_circuit_panel_mismatch:P205-1/);

  const mixed = panelCircuitAudit();
  mixed.circuits[0]!.memberElementIds.push(20);
  mixed.circuits[0]!.allNativeMemberElementIds.push(20);
  assert.throws(() => collectCircuitLoadingNativeEvidence(panelCircuitConfig(), null, mixed), /circuit_adapter_mixed_load_circuit_unsupported:P205-1/);

  const duplicate = panelCircuitAudit();
  duplicate.circuits[1]!.memberElementIds = [11];
  duplicate.circuits[1]!.allNativeMemberElementIds = [11];
  assert.throws(() => collectCircuitLoadingNativeEvidence(panelCircuitConfig(), null, duplicate), /circuit_adapter_duplicate_circuit_assignment/);
});
