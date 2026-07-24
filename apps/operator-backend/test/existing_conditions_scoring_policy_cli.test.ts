import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY } from "../src/benchmark/existing_conditions_reconstruction.js";
import { createExistingConditionsEvaluatorVisualReceipt } from "../src/existing_conditions/evaluator_visual.js";

const HASH = "a".repeat(64);

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
}

function element(key: string): Record<string, unknown> {
  return {
    key,
    kind: "mep_curve",
    category: "Ducts",
    type: "Rectangular Duct",
    system_classification: "Supply Air",
    system_type: "Supply Air",
    endpoints: [{ x: 0, y: 0, z: 9 }, { x: 10, y: 0, z: 9 }],
    size: { shape: "rectangular", width_ft: 1, height_ft: 1 }
  };
}

function truth(): Record<string, unknown> {
  return {
    schema_version: 1,
    fixture_id: "generic-cli-policy-fixture",
    scope_id: "generic-scope",
    ground_truth_model: { path: "withheld-model.rvt", sha256: HASH },
    visible_evidence: [{ role: "source_pdf", sha256: HASH }],
    deletion_manifest: {
      requested_element_ids: [1],
      deleted_element_ids: [1],
      dependent_element_ids: [],
      dry_run_receipt_sha256: HASH
    },
    snapshot: {
      native_readback: true,
      elements: [element("truth-duct")],
      connections: [],
      open_connector_count: 0
    }
  };
}

function candidate(): Record<string, unknown> {
  return {
    schema_version: 1,
    fixture_id: "generic-cli-policy-fixture",
    scope_id: "generic-scope",
    visible_evidence: [{ role: "source_pdf", sha256: HASH }],
    accessed_artifact_roles: ["agent_visible_package", "source_pdf", "redacted_model"],
    out_of_scope_changed_element_keys: [],
    snapshot: {
      native_readback: true,
      elements: [element("candidate-duct")],
      connections: [],
      open_connector_count: 0
    },
    visual_receipt: createExistingConditionsEvaluatorVisualReceipt({
      post_change_capture_sha256: HASH,
      post_change_pdf_sha256: HASH,
      review_status: "pass",
      notes: ["generic test receipt"]
    })
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function fingerprint(policy: Record<string, number>): string {
  return crypto.createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}

function runScore(temp: string, policy: string | undefined, label: string) {
  const truthPath = path.join(temp, `${label}-truth.json`);
  const candidatePath = path.join(temp, `${label}-candidate.json`);
  const outDir = path.join(temp, `${label}-score`);
  writeJson(truthPath, truth());
  writeJson(candidatePath, candidate());
  const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
  const args = [cli, "score", "--truth", truthPath, "--candidate", candidatePath];
  if (policy !== undefined) args.push("--policy", policy);
  args.push("--out-dir", outDir);
  return { result: spawnSync(process.execPath, args, { cwd: process.cwd(), encoding: "utf8" }), outDir };
}

test("score CLI accepts a partial policy and emits a resolved hash-bound policy receipt", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-policy-cli-"));
  try {
    const defaultRun = runScore(temp, undefined, "default");
    assert.equal(defaultRun.result.status, 0, defaultRun.result.stderr || defaultRun.result.stdout);
    const defaultScore = JSON.parse(fs.readFileSync(path.join(defaultRun.outDir, "existing_conditions_score.json"), "utf8"));
    assert.deepEqual(defaultScore.scoring_policy, DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY);
    assert.equal(defaultScore.scoring_policy_fingerprint_sha256, fingerprint(DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY));

    const first = runScore(temp, JSON.stringify({ passing_score: 70, minimum_precision: 0.9 }), "first");
    assert.equal(first.result.status, 0, first.result.stderr || first.result.stdout);
    const firstScore = JSON.parse(fs.readFileSync(path.join(first.outDir, "existing_conditions_score.json"), "utf8"));
    const expectedPolicy = { ...DEFAULT_EXISTING_CONDITIONS_SCORING_POLICY, passing_score: 70, minimum_precision: 0.9 };
    assert.equal(firstScore.passed, true, JSON.stringify(firstScore));
    assert.deepEqual(firstScore.scoring_policy, expectedPolicy);
    assert.equal(firstScore.scoring_policy_fingerprint_sha256, fingerprint(expectedPolicy));
    assert.match(fs.readFileSync(path.join(first.outDir, "existing_conditions_score.md"), "utf8"), /Scoring policy SHA-256:/);

    const second = runScore(temp, JSON.stringify({ minimum_precision: 0.9, passing_score: 70 }), "second");
    assert.equal(second.result.status, 0, second.result.stderr || second.result.stdout);
    const secondScore = JSON.parse(fs.readFileSync(path.join(second.outDir, "existing_conditions_score.json"), "utf8"));
    assert.equal(secondScore.scoring_policy_fingerprint_sha256, firstScore.scoring_policy_fingerprint_sha256);
    assert.equal(secondScore.schema_version, 1);
    assert.equal(secondScore.counts.matched, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("score CLI rejects unknown, non-finite, and out-of-domain policy values before writing a receipt", () => {
  const cases = [
    ["unknown", JSON.stringify({ unknown_key: 1 }), /unknown key/],
    ["nonfinite", '{"passing_score":1e400}', /finite number/],
    ["negative", JSON.stringify({ location_tolerance_ft: -1 }), /greater than or equal to 0/],
    ["rotation", JSON.stringify({ rotation_tolerance_degrees: 180.01 }), /between 0 and 180/],
    ["unit-interval", JSON.stringify({ minimum_precision: 1.01 }), /between 0 and 1/],
    ["percentage", JSON.stringify({ passing_score: 100.01 }), /between 0 and 100/]
  ] as const;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-policy-invalid-"));
  try {
    for (const [label, policy, message] of cases) {
      const run = runScore(temp, policy, label);
      assert.notEqual(run.result.status, 0, label);
      assert.match(`${run.result.stderr}\n${run.result.stdout}`, message, label);
      assert.equal(fs.existsSync(run.outDir), false, label);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
