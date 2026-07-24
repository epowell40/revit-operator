import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../src/contracts.js";
import { decide } from "../src/brain.js";
import {
  buildExistingConditionsSourceTargetManifestV1,
  latestExistingConditionsSourceTargetManifestV1,
  recordExistingConditionsSourceTargetManifestV1,
  validateExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetManifestV1,
  type ExistingConditionsSourceTargetV1
} from "../src/existing_conditions/source_target_manifest_ledger.js";
import { recordExistingConditionsSourceDispositionV1 } from "../src/existing_conditions/source_disposition_ledger.js";
import { withLatestExistingConditionsSourceDispositionContext } from "../src/existing_conditions/source_disposition_replay_context.js";
import { readExistingConditionsRepairLedger } from "../src/existing_conditions/repair_ledger_store.js";

test("one source mark with multiple primitives compiles into stable one-action targets", () => {
  const built = buildExistingConditionsSourceTargetManifestV1({
    interpretation: {
      schema_version: 1,
      package_id: "multi-primitive-source-mark",
      coordinate_space: "normalized_uv_top_left",
      view_keys: ["view-a"],
      source_marks: [{
        source_mark_id: "mark-a",
        source_view_key: "view-a",
        disposition: { status: "candidate", primitive_ids: ["route-a", "note-a"] }
      }, {
        source_mark_id: "mark-c",
        source_view_key: "view-a",
        disposition: { status: "candidate", primitive_ids: ["route-a"] }
      }, {
        source_mark_id: "mark-b",
        source_view_key: "view-a",
        disposition: { status: "unresolved", reason: "needs focused crop" }
      }, {
        source_mark_id: "mark-d",
        source_view_key: "view-a",
        disposition: { status: "candidate", primitive_ids: ["point-d"] }
      }],
      primitives: [{
        primitive_id: "route-a",
        source_view_key: "view-a",
        source_mark_ids: ["mark-a", "mark-c"],
        kind: "route_segment",
        points: [{ u: 0.1, v: 0.2 }, { u: 0.8, v: 0.2 }],
        confidence: { geometry: 0.99, classification: 0.9, topology: 0.9, visibility: 1 }
      }, {
        primitive_id: "note-a",
        source_view_key: "view-a",
        source_mark_ids: ["mark-a"],
        kind: "annotation",
        points: [{ u: 0.4, v: 0.3 }],
        confidence: { geometry: 0.99, classification: 0.9, topology: 0.9, visibility: 1 }
      }, {
        primitive_id: "point-d",
        source_view_key: "view-a",
        source_mark_ids: ["mark-d"],
        kind: "point_symbol",
        points: [{ u: 0.6, v: 0.4 }],
        confidence: { geometry: 0.99, classification: 0.9, topology: 0.9, visibility: 1 }
      }]
    } as any,
    context: {
      trusted_views: [{
        source_view: {
          view_key: "view-a",
          sheet_key: "M-100",
          source_sha256: "1".repeat(64),
          registration_sha256: "2".repeat(64),
          discipline: "mechanical",
          level_key: "L1",
          phase_key: "existing",
          role: "main_plan",
          resolution_rank: 1,
          registration: { verified: true, rms_residual_ft: 0, maximum_residual_ft: 0, confidence: 1 }
        },
        frame: {
          frame_id: "frame-a",
          view_id: 1,
          width_px: 100,
          height_px: 100,
          top_left_xyz: [0, 100, 0],
          top_right_xyz: [100, 100, 0],
          bottom_left_xyz: [0, 0, 0],
          target_level_elevation_ft: 0
        }
      }],
      calibration_profile: {} as any
    },
    compiled: {
      schema_version: 1,
      pixel_interpretation_sha256: "3".repeat(64),
      trusted_context_sha256: "4".repeat(64),
      compiled_topology: {
        input_fingerprint_sha256: "5".repeat(64),
        source_accounting_closure: 1,
        decisions: [{ primitive_id: "route-a", decision: "single_action", reasons: [] }, {
          primitive_id: "note-a",
          decision: "deferred",
          reasons: ["primitive_not_independently_reversible"]
        }, {
          primitive_id: "point-d",
          decision: "deferred",
          reasons: ["material_claims_unresolved:family,type"]
        }]
      } as any,
      candidate_identity_groups: [],
      source_route_junction_repairs: []
    },
    sourceReceipt: { schema_version: 1, fixture: "multi-primitive" }
  });
  assert.equal(built.source_mark_count, 4);
  assert.deepEqual(built.source_mark_counts, { candidate: 3, unresolved: 1, approved_exclusion: 0 });
  assert.equal(built.target_count, 4);
  assert.deepEqual(built.counts, { candidate: 3, unresolved: 1, approved_exclusion: 0 });
  const candidateTargets = built.targets.filter(value => value.source_status === "candidate");
  assert.equal(candidateTargets.length, 3);
  assert.equal(new Set(candidateTargets.map(value => value.target_key)).size, 3);
  assert.ok(candidateTargets.every(value => value.target_scope === "primitive" && value.primitive_keys.length === 1));
  const routeTarget = candidateTargets.find(value => value.primitive_kinds.includes("route_segment"));
  assert.equal(routeTarget?.source_mark_keys?.length, 2);
  assert.equal(routeTarget?.supersedes_target_keys, undefined);
  assert.equal(candidateTargets.find(value => value.primitive_kinds.includes("annotation"))?.supersedes_target_keys, undefined);
  assert.equal(candidateTargets.find(value => value.primitive_kinds.includes("point_symbol"))?.supersedes_target_keys?.length, 1);
  assert.match(
    candidateTargets.find(value => value.primitive_kinds.includes("annotation"))?.next_repair ?? "",
    /Bind this source annotation's legible claim to exactly one source-supported geometry or symbol target/
  );
  const unresolved = built.targets.find(value => value.source_status === "unresolved");
  assert.equal(unresolved?.target_scope, "source_mark");
  assert.equal(unresolved?.primitive_keys.length, 0);
});

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
    assert.match(response.assistant_message, /closure=1, 3 one-action target\(s\) from 3 source mark\(s\)/);
    assert.match(response.assistant_message, /candidate=1, unresolved=1, approved_exclusion=1/);
    assert.match(response.assistant_message, /Select exactly one non-excluded target/i);
    assert.match(response.assistant_message, /did not dispatch a native Revit action/i);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("source disposition progress augments but never replaces the complete target manifest", { concurrency: false }, async () => {
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
    assert.equal(replay?.targets[0]?.manifest_next_repair, original.targets[0]!.next_repair);
    assert.equal(replay?.targets[0]?.next_repair, "Verify one native primitive and dry-run only that action.");
    const inspection = await decide({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "manifest-progress-inspection",
      user_text: "Do not modify Revit. Report all existing-conditions sheet target manifest coverage and exact next repairs."
    });
    assert.match(
      inspection.assistant_message,
      new RegExp(`${original.targets[0]!.target_key}: candidate/single_action/accepted_source_observation\\. Exact next repair: Verify one native primitive and dry-run only that action\\.`)
    );
    assert.equal(readExistingConditionsRepairLedger(sessionId).length, 2);
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

test("one-primitive target migration preserves legacy progress but aggregate marks fail closed", { concurrency: false }, () => {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-source-target-migration-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const sessionId = "source-target-migration-session";
    const legacyTargetKey = key("target", "e");
    const migrated = target({
      target_key: key("target", "f"),
      source_mark_keys: [key("mark", "5")],
      supersedes_target_keys: [legacyTargetKey],
      target_scope: "primitive",
      source_mark_primitive_count: 1
    });
    const current = manifest({
      targets: [migrated],
      target_count: 1,
      counts: { candidate: 1, unresolved: 0, approved_exclusion: 0 },
      source_mark_count: 1,
      source_mark_counts: { candidate: 1, unresolved: 0, approved_exclusion: 0 }
    });
    recordExistingConditionsSourceDispositionV1({
      sessionId,
      disposition: {
        schema_version: 1,
        package_fingerprint_sha256: current.package_fingerprint_sha256,
        source_receipt_sha256: current.source_receipt_sha256,
        source_receipt_schema: current.source_receipt_schema,
        source_frame_id: key("frame", "3"),
        registration_context_id: key("registration", "4"),
        target_key: legacyTargetKey,
        disposition: "accepted_source_observation",
        reason_code: "source_supported",
        evidence_group_ids: [key("group", "d")],
        next_repair: "Verify one native primitive and dry-run only that action.",
        native_write_allowed: false
      }
    });
    recordExistingConditionsSourceTargetManifestV1({ sessionId, manifest: current });
    const replay = (withLatestExistingConditionsSourceDispositionContext({
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: sessionId,
      message_id: "manifest-migration",
      user_text: "Continue existing-conditions work from all saved targets."
    }).context as any)?.__server?.existing_conditions_source_target_manifest;
    assert.equal(replay?.registered_source_dispositions, 1);
    assert.equal(replay?.unregistered_source_targets, 0);
    assert.equal(replay?.targets[0]?.source_progress, "accepted_source_observation");
    assert.equal(replay?.targets[0]?.source_progress_migrated_from_target_key, legacyTargetKey);

    assert.throws(() => validateExistingConditionsSourceTargetManifestV1(manifest({
      targets: [target({
        source_mark_keys: [key("mark", "5"), key("mark", "6")],
        supersedes_target_keys: [legacyTargetKey],
        target_scope: "primitive",
        source_mark_primitive_count: 1
      })],
      target_count: 1,
      counts: { candidate: 1, unresolved: 0, approved_exclusion: 0 },
      source_mark_count: 2,
      source_mark_counts: { candidate: 2, unresolved: 0, approved_exclusion: 0 }
    })), /supersedes_target_keys_invalid/);
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
