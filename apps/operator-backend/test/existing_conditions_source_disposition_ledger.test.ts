import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  latestExistingConditionsSourceDispositionV1,
  recordExistingConditionsSourceDispositionV1,
  type ExistingConditionsSourceDispositionV1
} from "../src/existing_conditions/source_disposition_ledger.js";
import {
  latestExistingConditionsStagedWorkflow,
  readExistingConditionsRepairLedger
} from "../src/existing_conditions/staged_repair_ledger.js";
import { executeExistingConditionsProviderWorkbenchActions } from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";

function disposition(
  overrides: Partial<ExistingConditionsSourceDispositionV1> = {}
): ExistingConditionsSourceDispositionV1 {
  return {
    schema_version: 1,
    package_fingerprint_sha256: "a".repeat(64),
    source_receipt_sha256: "b".repeat(64),
    source_receipt_schema: "operator.sheet_vector_element_topology.v1",
    source_frame_id: "e210-registered-render",
    registration_context_id: "e210-to-e310-grid-controls",
    target_key: "electrical:l43:room-1900",
    disposition: "accepted_source_observation",
    reason_code: "source_supported",
    evidence_group_ids: ["group_0123456789abcdef0123"],
    next_repair: "Inspect the next registered source-supported element.",
    native_write_allowed: false,
    ...overrides
  };
}

test("source disposition shares the monotonic repair ledger without registering a native workflow", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "source-disposition-session";
    const first = recordExistingConditionsSourceDispositionV1({
      sessionId,
      disposition: disposition()
    });
    const duplicate = recordExistingConditionsSourceDispositionV1({
      sessionId,
      disposition: disposition()
    });
    assert.equal(duplicate.sequence, first.sequence);
    assert.equal(duplicate.entry_sha256, first.entry_sha256);
    assert.equal(latestExistingConditionsStagedWorkflow(sessionId), null);

    const abstained = recordExistingConditionsSourceDispositionV1({
      sessionId,
      disposition: disposition({
        source_receipt_sha256: "c".repeat(64),
        source_frame_id: "e310-registered-render",
        disposition: "abstained",
        reason_code: "registered_cross_page_no_target",
        evidence_group_ids: [],
        next_repair: "Continue on another safe source-supported target; do not write this target."
      })
    });
    assert.equal(abstained.sequence, 2);
    assert.equal(abstained.status, "follow_up");
    assert.equal(abstained.accepted_progress, true);
    assert.equal(abstained.stage_key, null);
    assert.deepEqual(abstained.action_keys, []);
    assert.equal(abstained.previous_entry_sha256, first.entry_sha256);

    const latest = latestExistingConditionsSourceDispositionV1(
      sessionId,
      "electrical:l43:room-1900"
    );
    assert.equal(latest?.status, "follow_up");
    assert.equal(latest?.disposition.reason_code, "registered_cross_page_no_target");
    assert.equal(latest?.disposition.native_write_allowed, false);
    assert.equal(readExistingConditionsRepairLedger(sessionId).length, 2);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* Windows may retain a log handle briefly. */ }
  }
});

test("source disposition rejects write authority, inconsistent decisions, and raw PDF structure ids", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-reject-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    assert.throws(() => recordExistingConditionsSourceDispositionV1({
      sessionId: "reject-write",
      disposition: disposition({ native_write_allowed: true } as any)
    }), /must_deny_native_write/);
    assert.throws(() => recordExistingConditionsSourceDispositionV1({
      sessionId: "reject-reason",
      disposition: disposition({ disposition: "abstained" })
    }), /reason_mismatch/);
    assert.throws(() => recordExistingConditionsSourceDispositionV1({
      sessionId: "reject-raw-id",
      disposition: disposition({
        source_frame_id: "Element123",
        evidence_group_ids: ["group_0123456789abcdef0123"]
      })
    }), /raw_source_id_forbidden/);
    assert.throws(() => recordExistingConditionsSourceDispositionV1({
      sessionId: "reject-transparent-id",
      disposition: disposition({ evidence_group_ids: ["Element123"] })
    }), /evidence_group_id_not_opaque/);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("provider workbench persists one source disposition and returns no Revit action", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-provider-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "provider-source-disposition-session";
    const response = await executeExistingConditionsProviderWorkbenchActions({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "source-disposition-message",
      user_text: "Persist the registered cross-sheet abstention."
    }, [{
      type: "register_existing_conditions_source_disposition",
      source_disposition_json: JSON.stringify(disposition({
        disposition: "abstained",
        reason_code: "registered_cross_page_no_target",
        evidence_group_ids: [],
        next_repair: "Continue with a different source-supported target."
      }))
    }]);
    assert.deepEqual(response.actions, []);
    assert.match(response.assistant_message, /succeeded and was persisted/i);
    const ledger = readExistingConditionsRepairLedger(sessionId);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.event, "source_disposition_recorded");
    assert.equal(ledger[0]?.status, "follow_up");
    assert.equal(ledger[0]?.action_keys.length, 0);
    assert.equal(latestExistingConditionsStagedWorkflow(sessionId), null);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
