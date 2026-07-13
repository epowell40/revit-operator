import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreExistingConditionsReconstruction,
  normalizeExistingConditionsSnapshot,
  type ExistingConditionsCandidate,
  type ExistingConditionsElement,
  type ExistingConditionsGroundTruth
} from "../src/benchmark/existing_conditions_reconstruction.js";
import { MockBridgeTransport, runRevitDemoWorkflow } from "../src/benchmark/revit_workflows.js";
import fs from "node:fs";
import path from "node:path";

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
    visible_evidence: [{ role: "source_pdf", sha256: "abc123" }],
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
    visible_evidence: [{ role: "source_pdf", sha256: "abc123" }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    snapshot: {
      native_readback: true,
      elements,
      connections: elements.length > 1 ? [{ a: elements[0]!.key, b: elements[1]!.key }] : [],
      open_connector_count: 2
    },
    visual_receipt: {
      post_change_capture_sha256: "capture",
      post_change_pdf_sha256: "pdf",
      review_status: "pass"
    }
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

test("invalidates changed evidence and out-of-scope writes", () => {
  const attempt = candidate();
  attempt.visible_evidence[0]!.sha256 = "changed";
  attempt.out_of_scope_changed_element_keys.push("wall-22");
  const result = scoreExistingConditionsReconstruction(truth(), attempt);
  assert.equal(result.valid_run, false);
  assert.equal(result.invalid_reasons.includes("visible_evidence_changed:source_pdf"), true);
  assert.equal(result.invalid_reasons.includes("out_of_scope_write"), true);
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
  assert.deepEqual(snapshot.connections, [{ a: "host:101", b: "host:90" }]);
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
