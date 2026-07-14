import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";

function writeJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(filePath: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

test("task-aware CLI scores compliance through engineering invariants and rejects profile drift", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "existing-conditions-engineering-cli-"));
  try {
    const standardsPath = path.join(temp, "standards.json");
    writeJson(standardsPath, {
      profile_id: "test-nec-profile",
      profile_revision: "1",
      jurisdiction: "Synthetic test jurisdiction",
      authority_having_jurisdiction: "Test AHJ",
      code_family: "NFPA 70",
      edition: "2023",
      effective_date: "2026-01-01",
      occupancy_or_use_classification: "dwelling unit",
      local_amendments: [],
      project_criteria: [{
        id: "test-bod",
        revision: "1",
        source_url: "https://example.invalid/test-bod",
        sha256: "b".repeat(64)
      }],
      conflict_precedence: ["local_amendments", "adopted_code", "project_criteria"],
      sources: [{
        authority: "NFPA",
        title: "NFPA 70 National Electrical Code",
        edition: "2023",
        section: "210.52(A)",
        url: "https://link.nfpa.org/",
        sha256: "a".repeat(64)
      }]
    });
    const standardsHash = sha256(standardsPath);
    const packagePath = path.join(temp, "agent_package.json");
    const packageValue = {
      schema_version: 1,
      fixture_id: "compliance-cli-v1",
      discipline: "electrical",
      task_class: "standards_compliance_repair",
      task: "Repair dwelling receptacle coverage using the adopted profile.",
      standards_profile: { role: "standards_profile", path: standardsPath, sha256: standardsHash },
      acceptance_contract: {
        acceptance_basis: ["engineering_invariants", "system_topology", "drawing_legibility", "scope_safety"],
        allows_multiple_valid_solutions: true,
        requires_exact_element_ids: false,
        requires_exact_coordinates: false
      },
      working_model: { role: "redacted_model", path: path.join(temp, "model.rvt"), sha256: "c".repeat(64) },
      evidence: [{ role: "source_pdf", path: path.join(temp, "source.pdf"), sha256: "d".repeat(64), page: 1 }],
      scope: {
        scope_id: "scope",
        view_id: 1,
        sheet_number: null,
        model_bounds_ft: { min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 10, z: 10 } },
        image_region_normalized: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 }
      },
      allowed_categories: ["OST_ElectricalFixtures"],
      write_policy: {
        dry_run_required: true,
        bounded_scope_required: true,
        out_of_scope_changes_allowed: false,
        maximum_created_elements: 4,
        max_repairs: 2,
        material_confidence_threshold: 0.75,
        forbidden_artifact_roles: ["ground_truth_model"],
        require_native_readback: true,
        require_source_observation_grounding: false,
        require_post_change_visual_receipt: true,
        require_evaluator_change_receipt: true,
        require_evaluator_access_provenance: true
      },
      output_contract: {
        candidate_snapshot_path: path.join(temp, "candidate.json"),
        post_change_capture_path: path.join(temp, "capture.png"),
        post_change_pdf_path: path.join(temp, "post.pdf"),
        run_receipt_path: path.join(temp, "run.json"),
        controller_state_path: path.join(temp, "state.json"),
        evaluator_access_provenance_path: path.join(temp, "access.json")
      }
    };
    writeJson(packagePath, packageValue);
    const checksPath = path.join(temp, "checks.json");
    writeJson(checksPath, [{ check_id: "wall-coverage", passed: true, failure_classification: null, details: {} }]);
    const changePath = path.join(temp, "change.json");
    writeJson(changePath, {
      native_diff_readback: true,
      changed_element_keys: ["host:101"],
      out_of_scope_changed_element_keys: [],
      receipt_sha256: "e".repeat(64)
    });
    const accessPath = path.join(temp, "access.json");
    writeJson(accessPath, {
      evaluator_owned: true,
      runner_isolation_verified: true,
      observed_artifact_roles: ["agent_visible_package", "source_pdf", "standards_profile"],
      forbidden_artifact_roles_accessed: [],
      standards_profile_sha256: standardsHash,
      receipt_sha256: "f".repeat(64)
    });

    const cli = path.resolve(process.cwd(), "dist/src/tools/existing_conditions_fixture.js");
    const scoreDir = path.join(temp, "score");
    const result = spawnSync(process.execPath, [
      cli, "score",
      "--package", packagePath,
      "--evaluator-checks", checksPath,
      "--evaluator-change-receipt", changePath,
      "--evaluator-access-provenance", accessPath,
      "--constructability", "pass",
      "--drawing-legibility", "pass",
      "--out-dir", scoreDir
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const score = JSON.parse(fs.readFileSync(path.join(scoreDir, "existing_conditions_engineering_score.json"), "utf8"));
    assert.equal(score.valid_run, true);
    assert.equal(score.passed, true);
    assert.equal(score.score, 100);

    writeJson(packagePath, {
      ...packageValue,
      standards_profile: { ...packageValue.standards_profile, sha256: "0".repeat(64) }
    });
    const driftResult = spawnSync(process.execPath, [
      cli, "score",
      "--package", packagePath,
      "--evaluator-checks", checksPath,
      "--evaluator-change-receipt", changePath,
      "--evaluator-access-provenance", accessPath,
      "--constructability", "pass",
      "--drawing-legibility", "pass",
      "--out-dir", path.join(temp, "drift-score")
    ], { cwd: process.cwd(), encoding: "utf8" });
    assert.notEqual(driftResult.status, 0);
    assert.match(driftResult.stderr, /standards_profile_hash_mismatch/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
