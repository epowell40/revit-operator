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

test("invalidates a run that accessed withheld truth", () => {
  const attempt = candidate();
  attempt.accessed_artifact_roles.push("deletion_manifest");
  const result = scoreExistingConditionsReconstruction(truth(), attempt);
  assert.equal(result.valid_run, false);
  assert.equal(result.score, 0);
  assert.equal(result.invalid_reasons.includes("ground_truth_leakage_detected"), true);
});

test("invalidates a run that accessed evaluator-native evidence or its signing key", () => {
  for (const role of ["evaluator_native_evidence", "evaluator_provenance", "evaluator_signing_key"]) {
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
  assert.deepEqual(result.applicability, { physical_connectivity: false, systems: false, spatial: true, hosting: true, electrical_circuits: true });
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
