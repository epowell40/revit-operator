import test from "node:test";
import assert from "node:assert/strict";
import { assertExistingConditionsContract } from "../src/existing_conditions/contract_validation.js";

test("runtime contract validation rejects an incomplete candidate", () => {
  assert.throws(
    () => assertExistingConditionsContract("candidate", { schema_version: 1 }),
    /invalid_existing_conditions_candidate_contract/
  );
});

test("runtime contract validation rejects an agent package with unsupported write policy", () => {
  assert.throws(
    () => assertExistingConditionsContract("agent_package", {
      schema_version: 1,
      fixture_id: "fixture",
      discipline: "electrical",
      task: "test",
      working_model: { role: "redacted_model", path: "model.rvt", sha256: "a".repeat(64) },
      evidence: [{ role: "source_pdf", path: "source.pdf", sha256: "b".repeat(64), page: 1 }],
      scope: {
        scope_id: "scope",
        view_id: 1,
        sheet_number: null,
        model_bounds_ft: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
        image_region_normalized: { min_x: 0, min_y: 0, max_x: 1, max_y: 1 }
      },
      allowed_categories: ["OST_ElectricalFixtures"],
      write_policy: { dry_run_required: false },
      output_contract: {
        candidate_snapshot_path: "candidate.json",
        post_change_capture_path: "capture.png",
        post_change_pdf_path: "post.pdf",
        run_receipt_path: "receipt.json",
        controller_state_path: "state.json"
      }
    }),
    /invalid_existing_conditions_agent_package_contract/
  );
});
