import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreExistingConditionsReconstruction,
  normalizeExistingConditionsSnapshot,
  mergeExistingConditionsVisibleElementPayloads,
  type ExistingConditionsCandidate,
  type ExistingConditionsElement,
  type ExistingConditionsGroundTruth
} from "../src/benchmark/existing_conditions_reconstruction.js";

import { MockBridgeTransport, runRevitDemoWorkflow } from "../src/benchmark/revit_workflows.js";
import fs from "node:fs";
import path from "node:path";
import { createExistingConditionsEvaluatorVisualReceipt } from "../src/existing_conditions/evaluator_visual.js";

const SOURCE_HASH = "a".repeat(64);
const RENDER_HASH = "b".repeat(64);
const COVERAGE_HASH = "c".repeat(64);
const REGION_HASH = "d".repeat(64);

test("multi-view visible element exports merge without duplicating host ids", () => {
  const merged = mergeExistingConditionsVisibleElementPayloads([
    { scanned: 2, items: [{ id: 10, category: "Pipes" }, { id: 20, category: "Plumbing Fixtures" }], warnings: ["first"] },
    { scanned: 2, items: [{ id: 20, category: "Plumbing Fixtures" }, { id: 30, category: "Pipes" }], warnings: ["second"] }
  ], [101, 102]);
  assert.deepEqual(merged.viewIds, [101, 102]);
  assert.equal(merged.count, 3);
  assert.equal(merged.scanned, 4);
  assert.deepEqual((merged.items as Array<{ id: number }>).map((entry) => entry.id), [10, 20, 30]);
  assert.deepEqual(merged.warnings, ["first", "second"]);
});

function duct(key: string, y = 10, size = 1): ExistingConditionsElement {
  return {
    key,
    kind: "mep_curve",
    category: "Ducts",
    type: "Rectangular Duct",
    system_classification: "Supply Air",
    system_type: "Supply Air 1",
    endpoints: [
      { x: 0, y, z: 9 },
      { x: 10, y, z: 9 }
    ],
    size: { shape: "rectangular", width_ft: size, height_ft: 10 / 12 }
  };
}

function truth(elements = [duct("truth-a"), duct("truth-b", 20)]): ExistingConditionsGroundTruth {
  return {
    schema_version: 1,
    fixture_id: "snowdon-m104-unit403-duct-v1",
    scope_id: "m104-unit403",
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    snapshot: {
      native_readback: true,
      elements,
      connections: elements.length > 1 ? [{ a: elements[0]!.key, b: elements[1]!.key }] : [],
      open_connector_count: 2
    }
  };
}

function candidate(elements = [duct("new-901"), duct("new-902", 20)]): ExistingConditionsCandidate {
  return {
    schema_version: 1,
    fixture_id: "snowdon-m104-unit403-duct-v1",
    scope_id: "m104-unit403",
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    snapshot: {
      native_readback: true,
      elements,
      connections: elements.length > 1 ? [{ a: elements[0]!.key, b: elements[1]!.key }] : [],
      open_connector_count: 2
    },
    visual_receipt: createExistingConditionsEvaluatorVisualReceipt({
      post_change_capture_sha256: "b".repeat(64),
      post_change_pdf_sha256: "c".repeat(64),
      review_status: "pass"
    })
  };
}

test("scores a semantically exact reconstruction with new Revit element ids", () => {
  const result = scoreExistingConditionsReconstruction(truth(), candidate());
  assert.equal(result.valid_run, true);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.counts.matched, 2);
  assert.deepEqual(result.failure_classifications, []);
});

test("matches MEP curve endpoints independent of draw direction", () => {
  const reversed = duct("new-reversed");
  reversed.endpoints = [reversed.endpoints![1], reversed.endpoints![0]];
  const result = scoreExistingConditionsReconstruction(truth([duct("truth")]), candidate([reversed]));
  assert.equal(result.passed, true);
  assert.equal(result.matched_pairs[0]?.distance_ft, 0);
});

test("penalizes extra modeled work as a false positive", () => {
  const result = scoreExistingConditionsReconstruction(truth(), candidate([
    duct("new-901"),
    duct("new-902", 20),
    duct("extra", 30)
  ]));
  assert.equal(result.valid_run, true);
  assert.equal(result.passed, false);
  assert.equal(result.counts.false_positive, 1);
  assert.equal(result.failure_classifications.includes("false_positive_elements"), true);
});

test("does not match a route outside geometric tolerance", () => {
  const result = scoreExistingConditionsReconstruction(truth([duct("truth")]), candidate([duct("wrong-bay", 15)]));
  assert.equal(result.counts.matched, 0);
  assert.equal(result.failure_classifications.includes("geometry_mismatch"), true);
  assert.equal(result.failure_classifications.includes("incomplete_reconstruction"), true);
});

test("unobserved elevation is reported but only modestly affects plan reconstruction", () => {
  const expected = truth([duct("truth")]);
  expected.evaluation_policy = { elevation_evidence: "not_visible" };
  const floorLevel = duct("candidate-on-floor");
  floorLevel.endpoints = floorLevel.endpoints?.map((point) => ({ ...point, z: 0 })) as [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number }
  ];
  const result = scoreExistingConditionsReconstruction(expected, candidate([floorLevel]));
  assert.equal(result.passed, true);
  assert.equal(result.counts.matched, 1);
  assert.equal(result.metrics.elevation, 0);
  assert.equal(result.metrics.geometry, 0.95);
  assert.equal(result.matched_pairs[0]?.plan_distance_ft, 0);
  assert.equal(result.matched_pairs[0]?.elevation_difference_ft, 9);
  assert.equal(result.elevation_evidence, "not_visible");
});

test("plan-visible elevation remains a strict reconstruction criterion", () => {
  const expected = truth([duct("truth")]);
  expected.evaluation_policy = { elevation_evidence: "plan_visible" };
  const wrongElevation = duct("candidate-wrong-elevation");
  wrongElevation.endpoints = wrongElevation.endpoints?.map((point) => ({ ...point, z: 0 })) as [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number }
  ];
  const result = scoreExistingConditionsReconstruction(expected, candidate([wrongElevation]));
  assert.equal(result.passed, false);
  assert.equal(result.counts.matched, 0);
  assert.equal(result.failure_classifications.includes("incomplete_reconstruction"), true);
});

test("unobserved elevation never excuses incorrect plan geometry", () => {
  const expected = truth([duct("truth")]);
  expected.evaluation_policy = { elevation_evidence: "not_visible" };
  const wrongBay = duct("candidate-wrong-bay", 15);
  wrongBay.endpoints = wrongBay.endpoints?.map((point) => ({ ...point, z: 0 })) as [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number }
  ];
  const result = scoreExistingConditionsReconstruction(expected, candidate([wrongBay]));
  assert.equal(result.counts.matched, 0);
  assert.equal(result.passed, false);
});

test("project-context elevation never rescues incorrect plan geometry", () => {
  const expected = truth([duct("truth")]);
  expected.evaluation_policy = { elevation_evidence: "project_context" };
  const wrongBay = duct("candidate-wrong-bay", 15);
  wrongBay.endpoints = wrongBay.endpoints?.map((point) => ({ ...point, z: 9 })) as [
    { x: number; y: number; z: number },
    { x: number; y: number; z: number }
  ];

  const result = scoreExistingConditionsReconstruction(expected, candidate([wrongBay]));

  assert.equal(result.passed, false);
  assert.equal(result.counts.matched, 0);
  assert.equal(result.failure_classifications.includes("geometry_mismatch"), true);
});

test("invalidates a run that accessed withheld truth", () => {
  const attempt = candidate();
  attempt.accessed_artifact_roles.push("deletion_manifest");
  const result = scoreExistingConditionsReconstruction(truth(), attempt);
  assert.equal(result.valid_run, false);
  assert.equal(result.score, 0);
  assert.equal(result.invalid_reasons.includes("ground_truth_leakage_detected"), true);
});

test("invalidates a run that accessed evaluator-native evidence or its signing key", () => {
  for (const role of ["evaluator_native_evidence", "evaluator_provenance", "evaluator_signing_key", "evaluator_native_adapter_config"]) {
    const attempt = candidate();
    attempt.accessed_artifact_roles.push(role);
    const result = scoreExistingConditionsReconstruction(truth(), attempt);
    assert.equal(result.valid_run, false, role);
    assert.equal(result.invalid_reasons.includes("ground_truth_leakage_detected"), true, role);
  }
});

test("invalidates changed evidence and out-of-scope writes", () => {
  const attempt = candidate();
  attempt.visible_evidence[0]!.sha256 = "changed";
  attempt.out_of_scope_changed_element_keys.push("wall-22");
  const result = scoreExistingConditionsReconstruction(truth(), attempt);
  assert.equal(result.valid_run, false);
  assert.equal(result.invalid_reasons.includes("visible_evidence_changed:source_pdf"), true);
  assert.equal(result.invalid_reasons.includes("out_of_scope_write"), true);
});

test("future fixtures can require an evaluator-owned native scope-diff receipt", () => {
  const expected = truth();
  expected.evaluation_policy = { require_evaluator_change_receipt: true };
  const missing = scoreExistingConditionsReconstruction(expected, candidate());
  assert.equal(missing.valid_run, false);
  assert.equal(missing.invalid_reasons.includes("missing_evaluator_change_receipt"), true);

  const evaluated = candidate();
  evaluated.evaluator_change_receipt = {
    native_diff_readback: true,
    changed_element_keys: ["new-901", "new-902"],
    out_of_scope_changed_element_keys: [],
    receipt_sha256: "d".repeat(64)
  };
  const accepted = scoreExistingConditionsReconstruction(expected, evaluated);
  assert.equal(accepted.valid_run, true);
  assert.equal(accepted.passed, true);
});

test("reports missing native connector topology", () => {
  const attempt = candidate();
  attempt.snapshot.connections = [];
  attempt.snapshot.open_connector_count = 4;
  const result = scoreExistingConditionsReconstruction(truth(), attempt);
  assert.equal(result.passed, false);
  assert.equal(result.failure_classifications.includes("connectivity_mismatch"), true);
  assert.ok(result.metrics.connectivity < 0.75);
});

test("runs through the existing revit_workflow benchmark adapter and writes scorecards", async () => {
  const runDir = path.join(process.cwd(), "local-work", "existing-conditions-tests", "exact-replay");
  fs.mkdirSync(runDir, { recursive: true });
  const result = await runRevitDemoWorkflow(
    {
      workflow: "existing_conditions_reconstruction",
      request: { groundTruth: truth(), candidate: candidate() }
    },
    runDir,
    new MockBridgeTransport({})
  );
  assert.equal(result.success, true);
  assert.equal(result.workflow, "existing_conditions_reconstruction");
  assert.equal(result.verification_results.every((entry) => entry.ok), true);
  assert.equal(fs.existsSync(path.join(runDir, "existing_conditions_score.json")), true);
  assert.equal(fs.existsSync(path.join(runDir, "existing_conditions_score.md")), true);
});

test("normalizes visible-element and connector readback into a scoring snapshot", () => {
  const snapshot = normalizeExistingConditionsSnapshot(
    {
      items: [{
        id: 101,
        sourceScopedId: "host:101",
        category: "Ducts",
        typeName: "Rectangular Duct",
        systemClassification: "Supply Air",
        system: { systemType: "Supply Air 1" },
        geometry: {
          kind: "curve",
          start: { model: { x: 0, y: 0, z: 9 } },
          end: { model: { x: 10, y: 0, z: 9 } }
        },
        connectorsSummary: { items: [{ size: { kind: "rect", widthFt: 1, heightFt: 0.833333 } }] },
        parameters: { width: 1, height: 0.833333 }
      }]
    },
    {
      status: "Ok",
      results: [{
        id: 101,
        ok: true,
        connectors: [
          { connectedTo: [{ ownerId: 90 }] },
          { connectedTo: [] }
        ]
      }]
    },
    { selected_element_ids: [101] }
  );
  assert.equal(snapshot.native_readback, true);
  assert.equal(snapshot.elements[0]?.kind, "mep_curve");
  assert.equal(snapshot.elements[0]?.size?.width_ft, 1);
  assert.deepEqual(snapshot.connections, [{ a: "host:101", b: "host:90", kind: "physical" }]);
  assert.equal(snapshot.open_connector_count, 1);
});

test("scores preserved connections to stable surrounding-model anchors", () => {
  const expected = truth([duct("truth")]);
  expected.snapshot.connections = [{ a: "truth", b: "host:90" }];
  expected.snapshot.open_connector_count = 1;
  const actual = candidate([duct("new")]);
  actual.snapshot.connections = [{ a: "new", b: "host:90" }];
  actual.snapshot.open_connector_count = 1;
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.metrics.connectivity, 1);
  assert.equal(result.passed, true);
});

test("does not mistake MEPSystem AllRefs membership for a physical connector", () => {
  const snapshot = normalizeExistingConditionsSnapshot(
    {
      items: [{
        id: 101,
        sourceScopedId: "host:101",
        category: "Duct Fittings",
        familyName: "Round Elbow",
        point: { x: 0, y: 0, z: 9 }
      }]
    },
    {
      status: "Ok",
      results: [{
        id: 101,
        ok: true,
        connectors: [{
          connectedTo: [{ ownerId: 999, ownerCategory: "OST_DuctSystem", isMepSystem: true }],
          physicalConnectedTo: [],
          physicalConnectionCount: 0,
          isPhysicallyConnected: false
        }]
      }]
    },
    { selected_element_ids: [101] }
  );
  assert.equal(snapshot.native_readback, true);
  assert.deepEqual(snapshot.connections, []);
  assert.equal(snapshot.open_connector_count, 1);
});

test("normalizes hosted electrical devices and real power-system membership", () => {
  const snapshot = normalizeExistingConditionsSnapshot(
    {
      items: [{
        id: 501,
        sourceScopedId: "host:501",
        category: "Electrical Fixtures",
        familyName: "Duplex Receptacle",
        typeName: "Duplex",
        levelName: "L4",
        point: { x: 4, y: 5, z: 3 },
        room: { number: "403" },
        hostResolvedScopedId: "link:44:990",
        electricalCircuit: {
          panel: "LP4",
          circuitNumber: "17",
          systemIds: [701],
          powerSystemIds: [701],
          exactPowerSystemCount: 1
        }
      }]
    },
    { status: "Ok", results: [] },
    { selected_element_ids: [501], require_connector_readback: false }
  );
  assert.equal(snapshot.native_readback, true);
  assert.equal(snapshot.elements[0]?.discipline, "electrical");
  assert.equal(snapshot.elements[0]?.role, "electrical_device");
  assert.equal(snapshot.elements[0]?.room_number, "403");
  assert.equal(snapshot.elements[0]?.host_key, "link:44:990");
  assert.deepEqual(snapshot.elements[0]?.electrical?.power_system_ids, ["electrical-system:701"]);
  assert.deepEqual(snapshot.connections, [
    { a: "host:501", b: "link:44:990", kind: "host" },
    { a: "electrical-system:701", b: "host:501", kind: "electrical_circuit" }
  ]);
});

function electricalDevice(key: string, x: number, host = "link:44:990", system = "electrical-system:701"): ExistingConditionsElement {
  return {
    key,
    kind: "family_instance",
    discipline: "electrical",
    role: "electrical_device",
    category: "Electrical Fixtures",
    family: "Duplex Receptacle",
    type: "Duplex",
    location: { x, y: 5, z: 3 },
    rotation_degrees: 90,
    level_name: "L4",
    room_number: "403",
    host_key: host,
    electrical: {
      panel: "LP4",
      circuit_number: "17",
      primary_label: "LP4/17",
      system_ids: [system],
      power_system_ids: [system],
      exact_power_system_count: 1
    }
  };
}

function requireCompleteElectricalCoverage(expected: ExistingConditionsGroundTruth, keys: string[]): void {
  expected.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  expected.evaluation_policy = {
    ...expected.evaluation_policy,
    bounded_mep_region_coverage: {
      required_coverage_status: "complete",
      source_evidence_sha256: SOURCE_HASH,
      registered_render_sha256: RENDER_HASH,
      coverage_contract_sha256: COVERAGE_HASH,
      region_sha256: REGION_HASH,
      clear_plan_visible_family_instance_keys: keys
    }
  };
}

function attachCompleteElectricalCoverage(actual: ExistingConditionsCandidate, observationIds: string[], status: "complete" | "partial" = "complete"): void {
  actual.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  actual.source_coverage_receipt = {
    schema_version: 1,
    scope_id: actual.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    region_sha256: REGION_HASH,
    coverage_contract_sha256: COVERAGE_HASH,
    coverage_status: status,
    disciplines: ["electrical"],
    candidate_count: observationIds.length + (status === "partial" ? 1 : 0),
    resolved_candidate_ids: observationIds.map((id) => `candidate:${id}`),
    unresolved_candidate_ids: status === "partial" ? ["candidate:unresolved"] : [],
    covered_observation_ids: observationIds
  };
}

function plumbingPipe(
  key: string,
  startX: number,
  endX: number,
  y = 5,
  systemClassification = "Sanitary"
): ExistingConditionsElement {
  return {
    key,
    kind: "mep_curve",
    discipline: "plumbing",
    role: "pipe",
    category: "Pipes",
    system_classification: systemClassification,
    system_type: `${systemClassification} 1`,
    endpoints: [
      { x: startX, y, z: 10 },
      { x: endX, y, z: 10 }
    ],
    size: { shape: "round", diameter_ft: 4 / 12 }
  };
}

function requireCompletePlumbingRouteCoverage(expected: ExistingConditionsGroundTruth, keys: string[]): void {
  expected.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  expected.evaluation_policy = {
    ...expected.evaluation_policy,
    elevation_evidence: "not_visible",
    bounded_mep_region_coverage: {
      required_coverage_status: "complete",
      source_evidence_sha256: SOURCE_HASH,
      registered_render_sha256: RENDER_HASH,
      coverage_contract_sha256: COVERAGE_HASH,
      region_sha256: REGION_HASH,
      clear_plan_visible_family_instance_keys: [],
      clear_plan_visible_mep_curve_keys: keys,
      route_trace_tolerance_ft: 0.25,
      minimum_route_trace_precision: 1,
      minimum_route_trace_recall: 1
    }
  };
}

function attachCompletePlumbingCoverage(actual: ExistingConditionsCandidate): void {
  actual.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  actual.source_coverage_receipt = {
    schema_version: 1,
    scope_id: actual.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    region_sha256: REGION_HASH,
    coverage_contract_sha256: COVERAGE_HASH,
    coverage_status: "complete",
    disciplines: ["plumbing"],
    candidate_count: 1,
    resolved_candidate_ids: ["candidate:route-observation"],
    unresolved_candidate_ids: [],
    covered_observation_ids: ["route-observation"]
  };
}

test("bounded MEP completeness requires exact clear-device recall and precision", () => {
  const expected = truth([
    electricalDevice("truth-device-a", 4),
    electricalDevice("truth-device-b", 14)
  ]);
  expected.discipline = "electrical";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompleteElectricalCoverage(expected, ["truth-device-a", "truth-device-b"]);

  const exact = candidate([
    electricalDevice("new-device-a", 4),
    electricalDevice("new-device-b", 14)
  ]);
  exact.discipline = "electrical";
  exact.snapshot.connections = [];
  exact.snapshot.open_connector_count = 0;
  attachCompleteElectricalCoverage(exact, ["observation-a", "observation-b"]);
  const accepted = scoreExistingConditionsReconstruction(expected, exact);
  assert.equal(accepted.passed, true);
  assert.equal(accepted.metrics.mep_region_precision, 1);
  assert.equal(accepted.metrics.mep_region_recall, 1);
  assert.equal(accepted.applicability.bounded_mep_region, true);

  const missing = candidate([electricalDevice("new-device-a", 4)]);
  missing.discipline = "electrical";
  missing.snapshot.connections = [];
  missing.snapshot.open_connector_count = 0;
  attachCompleteElectricalCoverage(missing, ["observation-a"]);
  const missed = scoreExistingConditionsReconstruction(expected, missing);
  assert.equal(missed.passed, false);
  assert.equal(missed.metrics.mep_region_recall, 0.5);
  assert.ok(missed.failure_classifications.includes("bounded_mep_region_incomplete"));

  const extra = candidate([
    electricalDevice("new-device-a", 4),
    electricalDevice("new-device-b", 14),
    electricalDevice("invented-device", 24)
  ]);
  extra.discipline = "electrical";
  extra.snapshot.connections = [];
  extra.snapshot.open_connector_count = 0;
  attachCompleteElectricalCoverage(extra, ["observation-a", "observation-b", "observation-extra"]);
  const falsePositive = scoreExistingConditionsReconstruction(expected, extra);
  assert.equal(falsePositive.passed, false);
  assert.equal(falsePositive.metrics.mep_region_precision, 0.666667);
  assert.ok(falsePositive.failure_classifications.includes("bounded_mep_region_false_positive"));
});

test("a partial coverage receipt cannot satisfy a complete bounded-region fixture", () => {
  const expected = truth([electricalDevice("truth-device", 4)]);
  expected.discipline = "electrical";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompleteElectricalCoverage(expected, ["truth-device"]);
  const actual = candidate([electricalDevice("new-device", 4)]);
  actual.discipline = "electrical";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;
  attachCompleteElectricalCoverage(actual, ["observation-a"], "partial");
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.valid_run, false);
  assert.ok(result.invalid_reasons.includes("bounded_mep_region_coverage_partial"));
});

test("bounded MEP route trace is independent of harmless native segment splits", () => {
  const expected = truth([plumbingPipe("truth-sanitary", 0, 20)]);
  expected.discipline = "plumbing";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompletePlumbingRouteCoverage(expected, ["truth-sanitary"]);
  const actual = candidate([
    plumbingPipe("new-sanitary-a", 0, 10),
    plumbingPipe("new-sanitary-b", 10, 20),
    {
      key: "native-union",
      kind: "fitting",
      discipline: "plumbing",
      role: "pipe_fitting",
      category: "Pipe Fittings",
      family: "Union - Generic",
      type: "4 inch",
      system_classification: "Sanitary",
      system_type: "Sanitary 1",
      location: { x: 10, y: 5, z: 10 }
    }
  ]);
  actual.discipline = "plumbing";
  attachCompletePlumbingCoverage(actual);

  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.mep_route_trace_precision, 1);
  assert.equal(result.metrics.mep_route_trace_recall, 1);
  assert.equal(result.metrics.truth_route_length_ft, 20);
  assert.equal(result.metrics.candidate_route_length_ft, 20);
  assert.equal(result.applicability.bounded_mep_route_trace, true);
  assert.deepEqual(result.missed_truth_keys, []);
  assert.deepEqual(result.false_positive_candidate_keys, []);
});

test("bounded MEP route trace rejects omitted, extra, displaced, and wrong-system plan length", () => {
  const expected = truth([plumbingPipe("truth-sanitary", 0, 20)]);
  expected.discipline = "plumbing";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompletePlumbingRouteCoverage(expected, ["truth-sanitary"]);

  const score = (elements: ExistingConditionsElement[]) => {
    const actual = candidate(elements);
    actual.discipline = "plumbing";
    actual.snapshot.connections = [];
    actual.snapshot.open_connector_count = 0;
    attachCompletePlumbingCoverage(actual);
    return scoreExistingConditionsReconstruction(expected, actual);
  };

  const omitted = score([plumbingPipe("short-sanitary", 0, 15)]);
  assert.equal(omitted.metrics.mep_route_trace_recall, 0.75);
  assert.equal(omitted.metrics.mep_route_trace_precision, 1);
  assert.ok(omitted.failure_classifications.includes("bounded_mep_route_trace_incomplete"));

  const branch = plumbingPipe("invented-branch", 10, 15);
  branch.endpoints = [{ x: 10, y: 5, z: 10 }, { x: 10, y: 10, z: 10 }];
  const extra = score([plumbingPipe("full-sanitary", 0, 20), branch]);
  assert.ok((extra.metrics.mep_route_trace_precision ?? 1) < 1);
  assert.ok(extra.failure_classifications.includes("bounded_mep_route_trace_false_positive"));

  const displaced = score([plumbingPipe("displaced-sanitary", 0, 20, 6)]);
  assert.equal(displaced.metrics.mep_route_trace_precision, 0);
  assert.equal(displaced.metrics.mep_route_trace_recall, 0);

  const wrongSystem = score([plumbingPipe("domestic-water", 0, 20, 5, "Domestic Cold Water")]);
  assert.equal(wrongSystem.metrics.mep_route_trace_precision, 0);
  assert.equal(wrongSystem.metrics.mep_route_trace_recall, 0);

  const wrongType = plumbingPipe("wrong-sanitary-type", 0, 20);
  wrongType.system_type = "Sanitary 99";
  const wrongTypeResult = score([wrongType]);
  assert.equal(wrongTypeResult.metrics.mep_route_trace_precision, 0);
  assert.equal(wrongTypeResult.metrics.mep_route_trace_recall, 0);

  const duplicated = score([
    plumbingPipe("duplicate-a", 0, 20),
    plumbingPipe("duplicate-b", 0, 20)
  ]);
  assert.equal(duplicated.metrics.mep_route_trace_precision, 0.5);
  assert.equal(duplicated.metrics.mep_route_trace_recall, 1);
  assert.ok(duplicated.failure_classifications.includes("bounded_mep_route_trace_false_positive"));

  const unrelatedFitting: ExistingConditionsElement = {
    key: "unrelated-domestic-fitting",
    kind: "fitting",
    discipline: "plumbing",
    role: "pipe_fitting",
    category: "Pipe Fittings",
    system_classification: "Domestic Cold Water",
    system_type: "Domestic Cold Water 1",
    location: { x: 100, y: 100, z: 10 }
  };
  const unrelated = score([plumbingPipe("full-sanitary-with-unrelated-fitting", 0, 20), unrelatedFitting]);
  assert.ok(unrelated.false_positive_candidate_keys.includes("unrelated-domestic-fitting"));
  assert.ok(unrelated.failure_classifications.includes("false_positive_elements"));

  const looseInteriorFitting: ExistingConditionsElement = {
    ...unrelatedFitting,
    key: "loose-interior-sanitary-fitting",
    system_classification: "Sanitary",
    system_type: "Sanitary 1",
    location: { x: 10, y: 5.1, z: 10 }
  };
  const looseInterior = score([plumbingPipe("full-sanitary-with-loose-interior-fitting", 0, 20), looseInteriorFitting]);
  assert.ok(looseInterior.false_positive_candidate_keys.includes("loose-interior-sanitary-fitting"));
  assert.ok(looseInterior.failure_classifications.includes("false_positive_elements"));
});

test("bounded MEP route policy rejects non-curve and degenerate truth keys", () => {
  const expected = truth([electricalDevice("not-a-route", 4)]);
  expected.discipline = "plumbing";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompletePlumbingRouteCoverage(expected, ["not-a-route"]);
  const actual = candidate([electricalDevice("candidate-device", 4)]);
  actual.discipline = "plumbing";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;
  attachCompletePlumbingCoverage(actual);
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.valid_run, false);
  assert.ok(result.invalid_reasons.includes("bounded_mep_route_truth_key_invalid:not-a-route"));
});

test("bounded MEP route policy rejects permissive tolerances and completeness thresholds", () => {
  const expected = truth([plumbingPipe("truth-sanitary", 0, 20)]);
  expected.discipline = "plumbing";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  requireCompletePlumbingRouteCoverage(expected, ["truth-sanitary"]);
  expected.evaluation_policy!.bounded_mep_region_coverage!.route_trace_tolerance_ft = 0.26;
  expected.evaluation_policy!.bounded_mep_region_coverage!.minimum_route_trace_precision = 0.94;
  expected.evaluation_policy!.bounded_mep_region_coverage!.minimum_route_trace_recall = 0.9;
  const actual = candidate([plumbingPipe("new-sanitary", 0, 20)]);
  actual.discipline = "plumbing";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;
  attachCompletePlumbingCoverage(actual);

  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.valid_run, false);
  assert.ok(result.invalid_reasons.includes("bounded_mep_route_trace_tolerance_invalid"));
  assert.ok(result.invalid_reasons.includes("bounded_mep_route_trace_precision_threshold_invalid"));
  assert.ok(result.invalid_reasons.includes("bounded_mep_route_trace_recall_threshold_invalid"));
});

test("scores electrical layout, host, room, orientation, and exact circuit relationship", () => {
  const expected = truth([electricalDevice("truth-device", 4)]);
  expected.discipline = "electrical";
  expected.snapshot.connections = [
    { a: "truth-device", b: "link:44:990", kind: "host" },
    { a: "truth-device", b: "electrical-system:701", kind: "electrical_circuit" }
  ];
  expected.snapshot.open_connector_count = 0;
  const actual = candidate([electricalDevice("new-device", 4)]);
  actual.discipline = "electrical";
  actual.snapshot.connections = [
    { a: "new-device", b: "link:44:990", kind: "host" },
    { a: "new-device", b: "electrical-system:701", kind: "electrical_circuit" }
  ];
  actual.snapshot.open_connector_count = 0;
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.metrics.hosting, 1);
  assert.equal(result.metrics.electrical_circuits, 1);
  assert.deepEqual(result.applicability, { physical_connectivity: false, architectural_topology: false, systems: false, spatial: true, hosting: true, electrical_circuits: true, discipline_coverage: false });
});

test("level-only evidence does not hard-fail an exact linked-hosted reconstruction", () => {
  const expectedDevice = electricalDevice("truth-device", 4);
  expectedDevice.room_number = null;
  const actualDevice = electricalDevice("new-device", 4);
  actualDevice.room_number = null;
  actualDevice.level_name = null;
  const result = scoreExistingConditionsReconstruction(truth([expectedDevice]), candidate([actualDevice]));
  assert.equal(result.applicability.spatial, false);
  assert.equal(result.failure_classifications.includes("spatial_mismatch"), false);
  assert.equal(result.passed, true);
});

test("panel and circuit labels do not substitute for real electrical-system membership", () => {
  const expected = truth([electricalDevice("truth-device", 4)]);
  expected.snapshot.connections = [{ a: "truth-device", b: "electrical-system:701", kind: "electrical_circuit" }];
  expected.snapshot.open_connector_count = 0;
  const labelOnly = electricalDevice("new-device", 4);
  labelOnly.electrical = { ...labelOnly.electrical, system_ids: [], power_system_ids: [], exact_power_system_count: 0 };
  const actual = candidate([labelOnly]);
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, false);
  assert.equal(result.metrics.electrical_circuits, 0);
  assert.equal(result.failure_classifications.includes("electrical_circuit_mismatch"), true);
});

test("wrong device host fails independently of otherwise matching geometry", () => {
  const expected = truth([electricalDevice("truth-device", 4)]);
  expected.snapshot.connections = [{ a: "truth-device", b: "link:44:990", kind: "host" }];
  expected.snapshot.open_connector_count = 0;
  const actual = candidate([electricalDevice("new-device", 4, "link:44:991")]);
  actual.snapshot.connections = [{ a: "new-device", b: "link:44:991", kind: "host" }];
  actual.snapshot.open_connector_count = 0;
  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, false);
  assert.equal(result.metrics.hosting, 0);
  assert.equal(result.failure_classifications.includes("hosting_mismatch"), true);
});

test("a wrong MEP system cannot pass on geometry and attributes alone", () => {
  const wrongSystem = duct("new");
  wrongSystem.system_classification = "Return Air";
  wrongSystem.system_type = "Return Air 1";
  const result = scoreExistingConditionsReconstruction(truth([duct("truth")]), candidate([wrongSystem]));
  assert.equal(result.passed, false);
  assert.equal(result.metrics.systems, 0);
  assert.equal(result.failure_classifications.includes("system_mismatch"), true);
});

function architecturalWall(key: string, x: number): ExistingConditionsElement {
  return {
    key,
    kind: "linear_element",
    discipline: "architectural",
    role: "wall",
    category: "Walls",
    type: "Interior Partition",
    endpoints: [{ x, y: 0, z: 0 }, { x, y: 10, z: 0 }]
  };
}

function plumbingFixture(key: string, x: number): ExistingConditionsElement {
  return {
    key,
    kind: "family_instance",
    discipline: "plumbing",
    role: "plumbing_fixture",
    category: "Plumbing Fixtures",
    family: "Sink",
    type: "Single Bowl",
    location: { x, y: 5, z: 0 }
  };
}

test("mixed-discipline coverage rejects an omitted small discipline that global recall would hide", () => {
  const expectedElements = [
    architecturalWall("truth-wall-1", 0),
    architecturalWall("truth-wall-2", 2),
    architecturalWall("truth-wall-3", 4),
    architecturalWall("truth-wall-4", 6),
    architecturalWall("truth-wall-5", 8),
    plumbingFixture("truth-sink", 20)
  ];
  const actualElements = expectedElements.slice(0, 5).map((element, index) => ({ ...element, key: `new-wall-${index + 1}` }));
  const expected = truth(expectedElements);
  expected.discipline = "mixed";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  expected.evaluation_policy = {
    required_discipline_coverage: [
      { discipline: "architectural", minimum_precision: 1, minimum_recall: 1 },
      { discipline: "plumbing", minimum_precision: 1, minimum_recall: 1 }
    ]
  };
  const actual = candidate(actualElements);
  actual.discipline = "mixed";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;

  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.metrics.recall, 0.833333);
  assert.equal(result.passed, false);
  assert.equal(result.applicability.discipline_coverage, true);
  assert.deepEqual(result.discipline_coverage, [
    {
      discipline: "architectural",
      truth_count: 5,
      candidate_count: 5,
      matched_count: 5,
      precision: 1,
      recall: 1,
      minimum_precision: 1,
      minimum_recall: 1,
      passed: true
    },
    {
      discipline: "plumbing",
      truth_count: 1,
      candidate_count: 0,
      matched_count: 0,
      precision: 0,
      recall: 0,
      minimum_precision: 1,
      minimum_recall: 1,
      passed: false
    }
  ]);
  assert.ok(result.failure_classifications.includes("discipline_plumbing_recall_below_threshold"));
});

test("mixed-discipline coverage passes only when every required discipline independently passes", () => {
  const expectedElements = [architecturalWall("truth-wall", 0), plumbingFixture("truth-sink", 20)];
  const actualElements = [architecturalWall("new-wall", 0), plumbingFixture("new-sink", 20)];
  const expected = truth(expectedElements);
  expected.discipline = "mixed";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  expected.evaluation_policy = {
    required_discipline_coverage: [
      { discipline: "architectural", minimum_precision: 1, minimum_recall: 1 },
      { discipline: "plumbing", minimum_precision: 1, minimum_recall: 1 }
    ]
  };
  const actual = candidate(actualElements);
  actual.discipline = "mixed";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;

  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.discipline_coverage.every((entry) => entry.passed), true);
});

test("mixed-discipline coverage must enumerate every truth discipline and rejects invented unconfigured disciplines", () => {
  const expected = truth([architecturalWall("truth-wall", 0), plumbingFixture("truth-sink", 20)]);
  expected.discipline = "mixed";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  expected.evaluation_policy = {
    required_discipline_coverage: [
      { discipline: "architectural", minimum_precision: 1, minimum_recall: 1 },
      { discipline: "electrical", minimum_precision: 1, minimum_recall: 1 }
    ]
  };
  const missingConfiguration = candidate([architecturalWall("new-wall", 0)]);
  missingConfiguration.discipline = "mixed";
  missingConfiguration.snapshot.connections = [];
  missingConfiguration.snapshot.open_connector_count = 0;
  const missingResult = scoreExistingConditionsReconstruction(expected, missingConfiguration);
  assert.equal(missingResult.valid_run, false);
  assert.ok(missingResult.invalid_reasons.includes("truth_discipline_missing_coverage_requirement:plumbing"));
  assert.ok(missingResult.invalid_reasons.includes("coverage_requirement_has_no_truth_discipline:electrical"));

  expected.evaluation_policy.required_discipline_coverage = [
    { discipline: "architectural", minimum_precision: 1, minimum_recall: 1 },
    { discipline: "plumbing", minimum_precision: 1, minimum_recall: 1 }
  ];
  const inventedElectrical = electricalDevice("invented-device", 40);
  inventedElectrical.room_number = null;
  inventedElectrical.host_key = null;
  inventedElectrical.electrical = null;
  const extraDiscipline = candidate([
    architecturalWall("new-wall", 0),
    plumbingFixture("new-sink", 20),
    inventedElectrical
  ]);
  extraDiscipline.discipline = "mixed";
  extraDiscipline.snapshot.connections = [];
  extraDiscipline.snapshot.open_connector_count = 0;
  const extraResult = scoreExistingConditionsReconstruction(expected, extraDiscipline);
  assert.equal(extraResult.valid_run, false);
  assert.ok(extraResult.invalid_reasons.includes("candidate_discipline_outside_coverage_requirements:electrical"));
});

test("mixed fixtures cannot disable discipline coverage with an empty or malformed runtime value", () => {
  const expected = truth([architecturalWall("truth-wall", 0), plumbingFixture("truth-sink", 20)]);
  expected.discipline = "mixed";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  const actual = candidate([architecturalWall("new-wall", 0), plumbingFixture("new-sink", 20)]);
  actual.discipline = "mixed";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;

  expected.evaluation_policy = { required_discipline_coverage: [] };
  const empty = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(empty.valid_run, false);
  assert.ok(empty.invalid_reasons.includes("discipline_coverage_requires_multiple_disciplines"));

  expected.evaluation_policy = { required_discipline_coverage: null } as unknown as ExistingConditionsGroundTruth["evaluation_policy"];
  const malformed = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(malformed.valid_run, false);
  assert.ok(malformed.invalid_reasons.includes("mixed_fixture_requires_discipline_coverage"));
});

test("mixed-discipline coverage gives route-only HVAC credit through exact plan trace coverage", () => {
  const truthDuct = duct("truth-duct");
  truthDuct.discipline = "mechanical";
  truthDuct.role = "duct";
  const expected = truth([architecturalWall("truth-wall", 0), truthDuct]);
  expected.discipline = "mixed";
  expected.snapshot.connections = [];
  expected.snapshot.open_connector_count = 0;
  expected.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  expected.evaluation_policy = {
    elevation_evidence: "not_visible",
    required_discipline_coverage: [
      { discipline: "architectural", minimum_precision: 1, minimum_recall: 1 },
      { discipline: "mechanical", minimum_precision: 1, minimum_recall: 1 }
    ],
    bounded_mep_region_coverage: {
      required_coverage_status: "complete",
      source_evidence_sha256: SOURCE_HASH,
      registered_render_sha256: RENDER_HASH,
      coverage_contract_sha256: COVERAGE_HASH,
      region_sha256: REGION_HASH,
      clear_plan_visible_family_instance_keys: [],
      clear_plan_visible_mep_curve_keys: ["truth-duct"],
      route_trace_tolerance_ft: 0.25,
      minimum_route_trace_precision: 1,
      minimum_route_trace_recall: 1
    }
  };
  const firstHalf = duct("new-duct-a");
  firstHalf.discipline = "mechanical";
  firstHalf.role = "duct";
  firstHalf.endpoints = [{ x: 0, y: 10, z: 9 }, { x: 5, y: 10, z: 9 }];
  const secondHalf = duct("new-duct-b");
  secondHalf.discipline = "mechanical";
  secondHalf.role = "duct";
  secondHalf.endpoints = [{ x: 5, y: 10, z: 9 }, { x: 10, y: 10, z: 9 }];
  const actual = candidate([architecturalWall("new-wall", 0), firstHalf, secondHalf]);
  actual.discipline = "mixed";
  actual.snapshot.connections = [];
  actual.snapshot.open_connector_count = 0;
  actual.visible_evidence.push({ role: "registered_source_render", sha256: RENDER_HASH });
  actual.source_coverage_receipt = {
    schema_version: 1,
    scope_id: actual.scope_id,
    source_evidence_sha256: SOURCE_HASH,
    registered_render_sha256: RENDER_HASH,
    coordinate_space: "registered_render_pixels_top_left",
    region: { min: { x: 100, y: 100 }, max: { x: 900, y: 700 } },
    region_sha256: REGION_HASH,
    coverage_contract_sha256: COVERAGE_HASH,
    coverage_status: "complete",
    disciplines: ["mechanical"],
    candidate_count: 1,
    resolved_candidate_ids: ["candidate:duct-trace"],
    unresolved_candidate_ids: [],
    covered_observation_ids: ["duct-observation"]
  };

  const result = scoreExistingConditionsReconstruction(expected, actual);
  assert.equal(result.passed, true);
  assert.equal(result.metrics.mep_route_trace_precision, 1);
  assert.equal(result.metrics.mep_route_trace_recall, 1);
  const mechanical = result.discipline_coverage.find((entry) => entry.discipline === "mechanical");
  assert.equal(mechanical?.truth_count, 0);
  assert.equal(mechanical?.route_trace_precision, 1);
  assert.equal(mechanical?.route_trace_recall, 1);
  assert.equal(mechanical?.passed, true);
});
