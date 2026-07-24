import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { decide } from "../src/brain.js";
import {
  latestExistingConditionsSourceTargetManifestV1,
  recordExistingConditionsSourceTargetManifestV1,
  validateExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetV1
} from "../src/existing_conditions/source_target_manifest_ledger.js";
import { recordExistingConditionsSourceDispositionV1 } from "../src/existing_conditions/source_disposition_ledger.js";
import { withLatestExistingConditionsSourceDispositionContext } from "../src/existing_conditions/source_disposition_replay_context.js";
import { readExistingConditionsRepairLedger } from "../src/existing_conditions/repair_ledger_store.js";

function key(prefix: string, character: string): string {
  return `${prefix}_${character.repeat(24)}`;
}

function target(overrides: Partial<ExistingConditionsSourceTargetV1> = {}): ExistingConditionsSourceTargetV1 {
  return {
    target_key: key("target", "1"),
    source_view_key: key("view", "2"),
    source_frame_key: key("frame", "3"),
    registration_context_key: key("registration", "4"),
    source_mark_key: key("mark", "5"),
    discipline: "mechanical",
    source_status: "candidate",
    compilation_decision: "single_action",
    primitive_kinds: ["route_segment"],
    primitive_keys: [key("primitive", "6")],
    compiler_reason_codes: [],
    reason_code: "compiled_candidate",
    next_repair: "Verify native context, then dry-run exactly one source-supported primitive for this target.",
    native_write_allowed: false,
    ...overrides
  };
}

function manifest(
  overrides: Partial<ExistingConditionsSourceTargetManifestV1> = {}
): ExistingConditionsSourceTargetManifestV1 {
  const targets = overrides.targets ?? [
    target(),
    target({
      target_key: key("target", "7"),
      source_mark_key: key("mark", "8"),
      source_status: "unresolved",
      compilation_decision: "not_applicable",
      primitive_kinds: [],
      primitive_keys: [],
      compiler_reason_codes: [],
      reason_code: "unresolved_source_mark",
      next_repair: "Acquire a focused crop, then recompile before any native action."
    }),
    target({
      target_key: key("target", "9"),
      source_mark_key: key("mark", "a"),
      discipline: "electrical",
      source_status: "approved_exclusion",
      compilation_decision: "not_applicable",
      primitive_kinds: [],
      primitive_keys: [],
      compiler_reason_codes: [],
      reason_code: "approved_source_exclusion",
      next_repair: "No repair is due; preserve this approved source exclusion in sheet accounting."
    })
  ];
  return {
    schema_version: 1,
    package_fingerprint_sha256: "b".repeat(64),
    source_receipt_sha256: "c".repeat(64),
    source_receipt_schema: "operator.existing_conditions.sheet_interpretation_receipt.v1",
    package_key: key("package", "d"),
    source_accounting_closure: 1,
    target_count: targets.length,
    counts: {
      candidate: targets.filter(value => value.source_status === "candidate").length,
      unresolved: targets.filter(value => value.source_status === "unresolved").length,
      approved_exclusion: targets.filter(value => value.source_status === "approved_exclusion").length
    },
    targets,
    native_write_allowed: false,
    ...overrides
  };
}

test("source target manifest is idempotent, hash chained, and restart safe", { concurrency: false }, async () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-target-manifest-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "source-target-manifest-session";
    const first = recordExistingConditionsSourceTargetManifestV1({ sessionId, manifest: manifest() });
    const duplicate = recordExistingConditionsSourceTargetManifestV1({ sessionId, manifest: manifest() });
    assert.equal(duplicate.sequence, first.sequence);
    assert.equal(duplicate.entry_sha256, first.entry_sha256);
    assert.equal(first.event, "source_target_manifest_registered");
    assert.equal(first.accepted_progress, true);
    assert.equal(first.status, "follow_up");
    assert.deepEqual(first.action_keys, []);

    const latest = latestExistingConditionsSourceTargetManifestV1(sessionId);
    assert.equal(latest?.manifest.source_accounting_closure, 1);
    assert.equal(latest?.manifest.target_count, 3);
    assert.equal(latest?.manifest.native_write_allowed, false);

    const contextual = withLatestExistingConditionsSourceDispositionContext({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "manifest-restart",
      user_text: "Continue the existing-conditions reconstruction from the saved sheet target manifest."
    });
    const replay = (contextual.context as any)?.__server?.existing_conditions_source_target_manifest;
    assert.equal(replay?.event_key, first.event_key);
    assert.equal(replay?.source_accounting_closure, 1);
    assert.equal(replay?.total_targets, 3);
    assert.equal(replay?.counts.approved_exclusion, 1);
    assert.equal(replay?.unregistered_source_targets, 2);
    assert.equal(replay?.native_write_allowed, false);
    assert.match(replay?.continuation_contract ?? "", /exactly one non-excluded target/i);

    const response = await decide({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "manifest-report",
      user_text: "Do not modify Revit. Report all existing-conditions sheet target manifest coverage and exact next repairs."
    });
    assert.deepEqual(response.actions, []);
    assert.match(response.assistant_message, /closure=1, 3 target\(s\)/);
    assert.match(response.assistant_message, /candidate=1, unresolved=1, approved_exclusion=1/);
    assert.match(response.assistant_message, /Select exactly one non-excluded target/i);
    assert.match(response.assistant_message, /did not dispatch a native Revit action/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("source disposition progress augments but never replaces the complete target manifest", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-target-progress-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "source-target-progress-session";
    const original = manifest();
    recordExistingConditionsSourceTargetManifestV1({ sessionId, manifest: original });
    recordExistingConditionsSourceDispositionV1({
      sessionId,
      disposition: {
        schema_version: 1,
        package_fingerprint_sha256: original.package_fingerprint_sha256,
        source_receipt_sha256: original.source_receipt_sha256,
        source_receipt_schema: original.source_receipt_schema,
        source_frame_id: key("frame", "3"),
        registration_context_id: key("registration", "4"),
        target_key: original.targets[0]!.target_key,
        disposition: "accepted_source_observation",
        reason_code: "source_supported",
        evidence_group_ids: [key("group", "e")],
        next_repair: "Verify one native primitive and dry-run only that action.",
        native_write_allowed: false
      }
    });
    const contextual = withLatestExistingConditionsSourceDispositionContext({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "manifest-progress",
      user_text: "Continue existing-conditions work from all saved targets."
    });
    const replay = (contextual.context as any)?.__server?.existing_conditions_source_target_manifest;
    assert.equal(replay?.total_targets, 3);
    assert.equal(replay?.registered_source_dispositions, 1);
    assert.equal(replay?.unregistered_source_targets, 1);
    assert.equal(replay?.targets[0]?.source_progress, "accepted_source_observation");
    assert.equal(readExistingConditionsRepairLedger(sessionId).length, 2);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("source target manifest fails closed on write authority, raw ids, duplicates, and count drift", () => {
  assert.throws(() => validateExistingConditionsSourceTargetManifestV1(
    manifest({ native_write_allowed: true } as any)
  ), /must_deny_native_write/);
  assert.throws(() => validateExistingConditionsSourceTargetManifestV1(manifest({
    targets: [target({ next_repair: "Inspect Element123 before drafting." })],
    target_count: 1,
    counts: { candidate: 1, unresolved: 0, approved_exclusion: 0 }
  })), /raw_source_id_forbidden/);
  assert.throws(() => validateExistingConditionsSourceTargetManifestV1(manifest({
    targets: [target(), target()],
    target_count: 2,
    counts: { candidate: 2, unresolved: 0, approved_exclusion: 0 }
  })), /duplicate_target_key/);
  assert.throws(() => validateExistingConditionsSourceTargetManifestV1(manifest({
    counts: { candidate: 3, unresolved: 0, approved_exclusion: 0 }
  })), /counts_invalid/);
});
