import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  normalizeExistingConditionsSnapshot,
  scoreExistingConditionsReconstruction as scoreExistingConditionsReconstructionWithoutAuthority,
  type ExistingConditionsCandidate,
  type ExistingConditionsElement,
  type ExistingConditionsGroundTruth,
  type ExistingConditionsScoringPolicy
} from "../src/benchmark/existing_conditions_reconstruction.js";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";
import {
  createExistingConditionsEvaluatorVisualReceipt,
  type ExistingConditionsEvaluatorExpectedRun
} from "../src/existing_conditions/evaluator_visual.js";
import {
  createExistingConditionsEvaluatorChangeReceipt,
  existingConditionsCandidateSnapshotSha256
} from "../src/existing_conditions/evaluator_diff.js";
import crypto from "node:crypto";

const SOURCE_HASH = "a".repeat(64);
const MODEL_HASH = "b".repeat(64);
const EVALUATOR_KEY_ID = "existing-conditions-architectural-test-key";
const EVALUATOR_KEY = "test-only-architectural-evaluator-signing-material-0001";
const EXPECTED_RUNS = new WeakMap<ExistingConditionsCandidate, ExistingConditionsEvaluatorExpectedRun>();

function scoreExistingConditionsReconstruction(
  truthValue: ExistingConditionsGroundTruth,
  candidateValue: ExistingConditionsCandidate,
  policy: Partial<ExistingConditionsScoringPolicy> = {}
) {
  if (EXPECTED_RUNS.get(candidateValue)?.candidate_snapshot_sha256 !==
      existingConditionsCandidateSnapshotSha256(candidateValue.snapshot)) {
    attachEvaluatorEvidence(candidateValue);
  }
  return scoreExistingConditionsReconstructionWithoutAuthority(truthValue, candidateValue, policy, {
    expected_run: EXPECTED_RUNS.get(candidateValue),
    visual_receipt_validation: {
      trusted_key_resolver: keyId => keyId === EVALUATOR_KEY_ID ? EVALUATOR_KEY : null
    },
    change_receipt_validation: {
      trusted_key_resolver: keyId => keyId === EVALUATOR_KEY_ID ? EVALUATOR_KEY : null
    }
  });
}

function attachEvaluatorEvidence(candidateValue: ExistingConditionsCandidate): ExistingConditionsCandidate {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-architectural-visual-"));
  const capture = path.join(root, "post.png");
  const pdf = path.join(root, "post.pdf");
  fs.writeFileSync(capture, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]));
  fs.writeFileSync(pdf, "%PDF-1.4\n%%EOF\n", "ascii");
  const workflowFingerprint = "c".repeat(64);
  const actionId = "architectural-test-action";
  const attemptId = crypto.randomUUID();
  const captureNonce = crypto.randomBytes(18).toString("base64url");
  const captureName = path.basename(capture);
  const changeReceipt = createExistingConditionsEvaluatorChangeReceipt(
    { viewId: 42, count: 0, truncated: false, items: [] },
    { viewId: 42, count: 0, truncated: false, items: [] },
    {
      scope: { model_bounds_ft: { min: { x: -1000, y: -1000, z: -1000 }, max: { x: 1000, y: 1000, z: 1000 } } },
      allowed_categories: ["OST_Walls"]
    },
    {
      run: {
        fixture_id: candidateValue.fixture_id,
        scope_id: candidateValue.scope_id,
        workflow_fingerprint_sha256: workflowFingerprint,
        action_id: actionId,
        attempt_id: attemptId,
        capture_nonce: captureNonce,
        capture_name: captureName,
        artifact_scope_root: root
      },
      candidate_snapshot: candidateValue.snapshot,
      authority: { key_id: EVALUATOR_KEY_ID, signing_key: EVALUATOR_KEY }
    }
  );
  const visualReceipt = createExistingConditionsEvaluatorVisualReceipt({
    post_change_capture_path: capture,
    post_change_pdf_path: pdf,
    artifact_scope_root: root,
    fixture_id: candidateValue.fixture_id,
    scope_id: candidateValue.scope_id,
    workflow_fingerprint_sha256: workflowFingerprint,
    action_id: actionId,
    attempt_id: attemptId,
    capture_nonce: captureNonce,
    capture_name: captureName,
    candidate_snapshot_sha256: changeReceipt.candidate_snapshot_sha256,
    change_digest_sha256: changeReceipt.change_digest_sha256,
    post_apply_completed_at: new Date(Date.now() - 1_000).toISOString(),
    authority: { key_id: EVALUATOR_KEY_ID, signing_key: EVALUATOR_KEY },
    review_status: "pass"
  });
  candidateValue.evaluator_change_receipt = changeReceipt;
  candidateValue.visual_receipt = visualReceipt;
  EXPECTED_RUNS.set(candidateValue, {
    fixture_id: candidateValue.fixture_id,
    scope_id: candidateValue.scope_id,
    workflow_fingerprint_sha256: workflowFingerprint,
    action_id: actionId,
    attempt_id: attemptId,
    capture_nonce: captureNonce,
    capture_name: captureName,
    artifact_scope_root: root,
    candidate_snapshot_sha256: changeReceipt.candidate_snapshot_sha256,
    change_digest_sha256: changeReceipt.change_digest_sha256
  });
  return candidateValue;
}

function wall(key: string, start: [number, number], end: [number, number]): ExistingConditionsElement {
  return {
    key,
    kind: "linear_element",
    discipline: "architectural",
    role: "wall",
    category: "Walls",
    type: "Generic - 8\"",
    endpoints: [
      { x: start[0], y: start[1], z: 32.1666666667 },
      { x: end[0], y: end[1], z: 32.1666666667 }
    ],
    level_name: "L4",
    size: { shape: "linear", width_ft: 8 / 12, height_ft: 10 }
  };
}

function opening(
  key: string,
  role: "door" | "window",
  location: [number, number, number],
  hostKey: string
): ExistingConditionsElement {
  return {
    key,
    kind: "family_instance",
    discipline: "architectural",
    role,
    category: role === "door" ? "Doors" : "Windows",
    family: role === "door" ? "Single-Flush" : "Fixed",
    type: role === "door" ? "36\" x 84\"" : "48\" x 48\"",
    location: { x: location[0], y: location[1], z: location[2] },
    level_name: "L4",
    host_key: hostKey,
    size: role === "door"
      ? { shape: "opening", width_ft: 3, height_ft: 7 }
      : { shape: "opening", width_ft: 4, height_ft: 4 },
    parameters: role === "window" ? { sill_height_ft: 3 } : {}
  };
}

function architecturalTruth(): ExistingConditionsGroundTruth {
  const elements = [
    wall("truth-wall-a", [0, 0], [12, 0]),
    wall("truth-wall-b", [0, 0], [0, 10]),
    opening("truth-door", "door", [4, 0, 32.1666666667], "truth-wall-a"),
    opening("truth-window", "window", [0, 5, 35.1666666667], "truth-wall-b")
  ];
  return {
    schema_version: 1,
    fixture_id: "architectural-shell-independent-v1",
    scope_id: "snowdon-l4-independent-shell",
    discipline: "architectural",
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    ground_truth_model: { path: "withheld/source.rvt", sha256: MODEL_HASH },
    deletion_manifest: {
      requested_element_ids: [1, 2, 3, 4],
      deleted_element_ids: [1, 2, 3, 4],
      dependent_element_ids: [],
      dry_run_receipt_sha256: "c".repeat(64)
    },
    snapshot: {
      native_readback: true,
      elements,
      connections: [
        { a: "truth-wall-a", b: "truth-wall-b", kind: "wall_junction" },
        { a: "truth-door", b: "truth-wall-a", kind: "host" },
        { a: "truth-window", b: "truth-wall-b", kind: "host" }
      ],
      open_connector_count: 0
    }
  };
}

function architecturalCandidate(): ExistingConditionsCandidate {
  const elements = [
    wall("new-wall-901", [12, 0], [0, 0]),
    wall("new-wall-902", [0, 10], [0, 0]),
    opening("new-door-903", "door", [4, 0, 32.1666666667], "new-wall-901"),
    opening("new-window-904", "window", [0, 5, 35.1666666667], "new-wall-902")
  ];
  return attachEvaluatorEvidence({
    schema_version: 2,
    fixture_id: "architectural-shell-independent-v1",
    scope_id: "snowdon-l4-independent-shell",
    discipline: "architectural",
    visible_evidence: [{ role: "source_pdf", sha256: SOURCE_HASH }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    snapshot: {
      native_readback: true,
      elements,
      connections: [
        { a: "new-wall-901", b: "new-wall-902", kind: "wall_junction" },
        { a: "new-door-903", b: "new-wall-901", kind: "host" },
        { a: "new-window-904", b: "new-wall-902", kind: "host" }
      ],
      open_connector_count: 0
    }
  });
}

test("architectural shell accepts identity-perturbed walls, hosted openings, and reversed wall endpoints", () => {
  const truth = architecturalTruth();
  const candidate = architecturalCandidate();
  assertExistingConditionsContract("ground_truth", truth);
  assertExistingConditionsContract("candidate", candidate);
  const result = scoreExistingConditionsReconstruction(truth, candidate);
  assert.equal(result.passed, true);
  assert.equal(result.score, 100);
  assert.equal(result.metrics.architectural_topology, 1);
  assert.equal(result.metrics.hosting, 1);
  assert.equal(result.applicability.architectural_topology, true);
});

test("architectural shell rejects missing wall junction topology", () => {
  const candidate = architecturalCandidate();
  candidate.snapshot.connections = candidate.snapshot.connections.filter((entry) => entry.kind !== "wall_junction");
  const result = scoreExistingConditionsReconstruction(architecturalTruth(), candidate);
  assert.equal(result.passed, false);
  assert.equal(result.metrics.architectural_topology, 0);
  assert.equal(result.failure_classifications.includes("architectural_topology_mismatch"), true);
});

test("architectural shell rejects a window hosted to the wrong reconstructed wall", () => {
  const candidate = architecturalCandidate();
  const window = candidate.snapshot.elements.find((entry) => entry.role === "window")!;
  window.host_key = "new-wall-901";
  candidate.snapshot.connections = candidate.snapshot.connections.map((entry) =>
    entry.a === window.key && entry.kind === "host" ? { ...entry, b: "new-wall-901" } : entry
  );
  const result = scoreExistingConditionsReconstruction(architecturalTruth(), candidate);
  assert.equal(result.passed, false);
  assert.equal(result.failure_classifications.includes("hosting_mismatch"), true);
});

test("architectural shell penalizes an extra invented opening", () => {
  const candidate = architecturalCandidate();
  candidate.snapshot.elements.push(opening("invented-window", "window", [9, 0, 35.1666666667], "new-wall-901"));
  candidate.snapshot.connections.push({ a: "invented-window", b: "new-wall-901", kind: "host" });
  const result = scoreExistingConditionsReconstruction(architecturalTruth(), candidate);
  assert.equal(result.passed, false);
  assert.equal(result.counts.false_positive, 1);
  assert.equal(result.failure_classifications.includes("false_positive_architectural_openings"), true);
});

test("native normalization classifies walls and derives junction plus opening host relations", () => {
  const snapshot = normalizeExistingConditionsSnapshot({
    items: [
      {
        id: 101,
        sourceScopedId: "host:101",
        category: "Walls",
        typeName: "Generic - 8\"",
        levelName: "L4",
        geometry: {
          start: { model: { x: 0, y: 0, z: 32.1666666667 } },
          end: { model: { x: 12, y: 0, z: 32.1666666667 } }
        }
      },
      {
        id: 102,
        sourceScopedId: "host:102",
        category: "Walls",
        typeName: "Generic - 8\"",
        levelName: "L4",
        geometry: {
          start: { model: { x: 0, y: 0, z: 32.1666666667 } },
          end: { model: { x: 0, y: 10, z: 32.1666666667 } }
        }
      },
      {
        id: 103,
        sourceScopedId: "host:103",
        category: "Doors",
        familyName: "Single-Flush",
        typeName: "36\" x 84\"",
        point: { x: 4, y: 0, z: 32.1666666667 },
        hostResolvedScopedId: "host:101"
      }
    ]
  }, { status: "Ok", results: [] }, {
    selected_element_ids: [101, 102, 103],
    require_connector_readback: false
  });
  assert.equal(snapshot.native_readback, true);
  assert.equal(snapshot.elements.find((entry) => entry.key === "host:101")?.kind, "linear_element");
  assert.equal(snapshot.elements.find((entry) => entry.key === "host:103")?.discipline, "architectural");
  assert.deepEqual(snapshot.connections, [
    { a: "host:101", b: "host:103", kind: "host" },
    { a: "host:101", b: "host:102", kind: "wall_junction" }
  ]);
});
