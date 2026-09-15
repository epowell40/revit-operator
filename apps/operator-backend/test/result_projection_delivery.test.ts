import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { payloadDigestV2 } from "@revitoperator/payload-digest-v2";
import { storeEvidence } from "../src/evidence/evidence_store.js";
import { extractDeterministicEvidenceFacts } from "../src/evidence/evidence_projection.js";
import { buildAssignmentResultDeliveryV2 } from "../src/assignments/assignment_kernel_v2_result_delivery.js";
import { renderResultDeliveryV2, validateResultDeliveryV2 } from "../src/domain/assignment-kernel/result_delivery.js";
import { codexAssignmentEvidenceContextV2 } from "../src/brains/codex_assignment_evidence.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

function isolated(fn: () => void) {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "operator-projection-delivery-"));
  process.env.OPERATOR_WORKSPACE_ROOT = dir;
  try { fn(); } finally {
    __closeForTests();
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT; else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const binding = { session_id: "session", assignment_id: "assignment", run_id: "run", generation: 1, principal_id: "principal", document_fingerprint: "model" };
function inventory(count = 509) {
  return { count, itemsComplete: true, items: Array.from({ length: count }, (_, i) => ({
    elementId: i + 1, category: "Air Terminals", familyName: "Supply.Diffuser", typeName: i % 2 ? '12" x 12"' : '16" | 4"'
  })) };
}
function retain(raw: unknown): any {
  const stored = storeEvidence({ scope: { ...binding, attempt_id: "operation" }, source: "native:inventory", trust_level: "authoritative_native", raw });
  return { spec: { result_delivery_required: true, requested_effect: "read" }, current_binding: binding,
    observations: { observation: { observation_id: "observation", binding, operation_id: "operation", observed_at: "2026-01-01T00:00:00Z",
      authority: "native-host", evidence_class: "task_result", eligible_criterion_ids: ["read-result"],
      raw_payload_ref: `evidence:${stored.ref.evidence_id}`, raw_payload_hash: payloadDigestV2(raw).digest } },
    operations: { operation: { requested_effect: "read", settlement_state: "settled", capability_id: "revit_find_elements",
      result: { status: "succeeded", persistent_effect: "none" } } } };
}
const selection = { label: "Air devices", observation_id: "observation", source: "deterministic_projection" as const, path: ["key_counts", "inventory.total"] };

test("complete 509-device counts travel from retained native bytes to a concise answer without another Revit read", () => isolated(() => {
  const snapshot = retain(inventory());
  const index = JSON.parse(codexAssignmentEvidenceContextV2(snapshot));
  assert.equal(index.observations[0].result_item_eligibility, "result");
  const delivery = buildAssignmentResultDeliveryV2(snapshot, [selection, { ...selection, label: "Small diffusers", path: ["key_counts", 'inventory.family_type::Supply.Diffuser | 12" x 12"'] }]);
  assert.equal(delivery.items[0]!.value, 509); assert.equal(delivery.items[1]!.value, 254);
  assert.equal(delivery.items[0]!.value_source, "deterministic_projection");
  assert.equal(delivery.items[0]!.payload_hash, snapshot.observations.observation.raw_payload_hash);
  assert.equal(renderResultDeliveryV2(delivery), "- Air devices: 509\n- Small diffusers: 254");
  validateResultDeliveryV2(snapshot, JSON.parse(JSON.stringify(delivery)));
  snapshot.result_delivery = delivery;
  assert.deepEqual(buildAssignmentResultDeliveryV2(snapshot, [selection, { ...selection, label: "Small diffusers", path: ["key_counts", 'inventory.family_type::Supply.Diffuser | 12" x 12"'] }]), delivery);
  assert.throws(() => buildAssignmentResultDeliveryV2(snapshot, [{ ...selection, label: "Changed" }]), /conflict/);
}));

test("projection selectors reject guessed paths, forged sources, changed hashes and incomplete inventory claims", () => isolated(() => {
  const snapshot = retain(inventory());
  for (const invalid of [
    { ...selection, source: undefined, path: ["inventory", "total"] },
    { ...selection, path: ["projection", "key_counts", "inventory.total"] },
    { ...selection, path: ["key_counts", "inventory", "total"] },
    { ...selection, path: ["key_counts", "inventory.family_type::missing"] },
    { ...selection, source: "model_value" }
  ]) assert.throws(() => buildAssignmentResultDeliveryV2(snapshot, [invalid as any]), /path|source/);
  assert.equal(buildAssignmentResultDeliveryV2(snapshot, [{ ...selection, source: "raw_payload", path: ["count"] }]).items[0]!.value, 509);
  snapshot.observations.observation.raw_payload_hash = `sha256:${"0".repeat(64)}`;
  assert.throws(() => buildAssignmentResultDeliveryV2(snapshot, [selection]), /hash_mismatch/);
  for (const raw of [{ ...inventory(), itemsComplete: false }, { ...inventory(), count: 510 }, { ...inventory(), hasMore: true },
    { ...inventory(), items: inventory().items.map(row => ({ ...row, elementId: 1 })) },
    { ...inventory(), items: inventory().items.map((row, i) => ({ ...row, familyName: `Type ${i}` })) }]) {
    assert.throws(() => buildAssignmentResultDeliveryV2(retain(raw), [selection]), /inventory_incomplete/);
  }
}));

test("identity grouping never merges long prefixes or ambiguous family/type separators", () => {
  for (const [family1, type1, family2, type2] of [
    ["A".repeat(240) + "B", "Type", "A".repeat(240) + "C", "Type"],
    ["Family | Special", "Type", "Family", "Special | Type"]
  ]) {
    const facts = extractDeterministicEvidenceFacts({ count: 2, itemsComplete: true, items: [
      { elementId: 1, familyName: family1, typeName: type1 }, { elementId: 2, familyName: family2, typeName: type2 }
    ] });
    assert.equal(facts.counts["inventory.group_count"], 2);
    assert.equal(facts.facts["inventory.groups_truncated"], true);
    assert.deepEqual(Object.keys(facts.counts).filter(key => key.startsWith("inventory.family_type::")), []);
  }
});

test("model observation index shares eligibility with delivery and never promotes controls, writes or foreign evidence", () => isolated(() => {
  const base = retain(inventory(2));
  for (const [variant, expected] of [["read", "result"], ["control", "ineligible"], ["verification", "ineligible"], ["write", "ineligible"],
    ["unsettled", "ineligible"], ["transport", "ineligible"], ["failed-native", "ineligible"], ["failed-dynamic", "diagnostic"]]) {
    const snapshot = structuredClone(base), o = snapshot.observations.observation, op = snapshot.operations.operation;
    if (variant === "control" || variant === "verification") o.evidence_class = variant;
    if (variant === "write") op.requested_effect = "apply";
    if (variant === "unsettled") op.settlement_state = "retaining_observation";
    if (variant === "transport") o.authority = "operator-mcp-transport";
    if (variant.startsWith("failed")) op.result.status = "failed_after_dispatch";
    if (variant === "failed-dynamic") o.authority = "dynamic-runtime";
    const index = JSON.parse(codexAssignmentEvidenceContextV2(snapshot));
    assert.equal(index.observations[0].result_item_eligibility, expected, variant);
    if (expected === "result") buildAssignmentResultDeliveryV2(snapshot, [selection]);
    else assert.throws(() => buildAssignmentResultDeliveryV2(snapshot, [selection]), /ineligible|invalid/, variant);
  }
  for (const key of ["session_id", "run_id", "assignment_id", "principal_id", "document_fingerprint", "generation"]) {
    const snapshot = structuredClone(base); snapshot.observations.observation.binding = { ...binding, [key]: key === "generation" ? 2 : "other" };
    assert.equal(codexAssignmentEvidenceContextV2(snapshot), "", key);
  }
  const snapshot = structuredClone(base);
  snapshot.observations = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`o${i}`, { ...base.observations.observation, observation_id: `o${i}` }]));
  const index = JSON.parse(codexAssignmentEvidenceContextV2(snapshot));
  assert.equal(index.observations.length, 32); assert.equal(index.omitted, 8);
}));
