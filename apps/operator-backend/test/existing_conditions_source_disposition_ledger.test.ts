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
import { withLatestExistingConditionsSourceDispositionContext } from "../src/existing_conditions/source_disposition_replay_context.js";
import { decide, decideStreaming } from "../src/brain.js";

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

test("a later agent turn receives the latest source disposition and exact continuation contract after restart", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const previousBrain = process.env.OPERATOR_BRAIN;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-replay-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  process.env.OPERATOR_BRAIN = "gemini";
  try {
    const sessionId = "source-disposition-replay-session";
    const input = disposition({
      disposition: "abstained",
      reason_code: "registered_cross_page_no_target",
      evidence_group_ids: [],
      next_repair: "Inspect the next registered lighting control; preserve the provisional circuit."
    });
    const entry = recordExistingConditionsSourceDispositionV1({ sessionId, disposition: input });
    const restartedRequest = withLatestExistingConditionsSourceDispositionContext({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "restarted-message",
      user_text: "Continue the existing-conditions reconstruction.",
      context: { operator_brain_route: "direct", retained_context: "keep-me" }
    });
    const replay = (restartedRequest.context as any)?.__server?.existing_conditions_source_disposition;
    assert.equal((restartedRequest.context as any)?.retained_context, "keep-me");
    assert.equal(replay?.event_key, entry.event_key);
    assert.equal(replay?.target_key, input.target_key);
    assert.equal(replay?.reason_code, "registered_cross_page_no_target");
    assert.equal(replay?.next_repair, input.next_repair);
    assert.equal(replay?.native_write_allowed, false);
    assert.match(replay?.continuation_contract ?? "", /Do not repeat this accepted source search/);

    let providerRequest: any = null;
    const response = await decide({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "provider-restart-message",
      user_text: "Continue the existing-conditions reconstruction.",
      context: { operator_brain_route: "direct" }
    }, {
      existingConditionsSourcePreflight: async request => request,
      existingConditionsProviderDecision: async () => null,
      geminiBrain: async request => {
        providerRequest = request;
        return {
          version: OPERATOR_BACKEND_CONTRACT_VERSION,
          assistant_message: "Continuing from the persisted source disposition.",
          actions: []
        };
      }
    });
    assert.deepEqual(response.actions, []);
    assert.equal(
      providerRequest?.context?.__server?.existing_conditions_source_disposition?.event_key,
      entry.event_key
    );
    assert.equal(
      providerRequest?.context?.__server?.existing_conditions_source_disposition?.next_repair,
      input.next_repair
    );
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    if (previousBrain === undefined) delete process.env.OPERATOR_BRAIN;
    else process.env.OPERATOR_BRAIN = previousBrain;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("a read-only disposition inspection never fabricates missing source state or calls a provider", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-missing-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const request = {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: "missing-source-disposition-session",
      message_id: "missing-source-disposition-message",
      user_text: "Continue from the latest persisted source disposition. Do not modify Revit; report the exact next repair.",
      context: { retained_context: "keep-me" }
    } as const;
    const contextual = withLatestExistingConditionsSourceDispositionContext(request);
    assert.equal((contextual.context as any)?.retained_context, "keep-me");
    assert.equal(
      (contextual.context as any)?.__server?.existing_conditions_source_disposition?.status,
      "not_found"
    );
    assert.equal(
      (contextual.context as any)?.__server?.existing_conditions_source_disposition?.native_write_allowed,
      false
    );

    let providerCalled = false;
    const response = await decide(request, {
      existingConditionsSourcePreflight: async value => value,
      existingConditionsProviderDecision: async () => {
        providerCalled = true;
        return null;
      },
      geminiBrain: async () => {
        providerCalled = true;
        throw new Error("provider_must_not_run");
      }
    });
    assert.equal(providerCalled, false);
    assert.deepEqual(response.actions, []);
    assert.match(response.assistant_message, /No persisted existing-conditions source disposition/i);
    assert.match(response.assistant_message, /did not synthesize/i);
    assert.match(response.assistant_message, /did not .*dispatch a native Revit action/i);

    const deltas: string[] = [];
    const streamed = await decideStreaming(request, {
      onDelta: value => deltas.push(value)
    }, {
      geminiStreamingBrain: async () => {
        providerCalled = true;
        throw new Error("provider_must_not_run");
      }
    });
    assert.equal(providerCalled, false);
    assert.deepEqual(streamed.actions, []);
    assert.equal(deltas.join(""), streamed.assistant_message);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("a read-only disposition inspection reports the persisted reason and exact next repair without repeating work", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-disposition-inspection-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const input = disposition({
      disposition: "abstained",
      reason_code: "registered_cross_page_no_target",
      evidence_group_ids: [],
      next_repair: "Inspect the next registered lighting control; preserve the provisional circuit."
    });
    const entry = recordExistingConditionsSourceDispositionV1({
      sessionId: "source-disposition-inspection-session",
      disposition: input
    });
    const response = await decide({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: "source-disposition-inspection-session",
      message_id: "source-disposition-inspection-message",
      user_text: "Do not modify the model. Report and explain the latest persisted source disposition."
    });
    assert.deepEqual(response.actions, []);
    assert.match(response.assistant_message, /registered_cross_page_no_target/);
    assert.match(response.assistant_message, new RegExp(input.next_repair.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(response.assistant_message, new RegExp(entry.event_key));
    assert.match(response.assistant_message, /did not repeat the source search/i);
    assert.match(response.assistant_message, /did not .*dispatch a native Revit action/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});
