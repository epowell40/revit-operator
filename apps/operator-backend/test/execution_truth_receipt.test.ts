import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import {
  EXECUTION_TRUTH_CANONICALIZATION,
  EXECUTION_TRUTH_RECEIPT_SCHEMA,
  EXECUTION_TRUTH_RECEIPT_VERSION,
  createExecutionTruthReceipt,
  hashExecutionTruthReceipt,
  parseExecutionTruthReceipt,
  type ExecutionTruthReceipt,
  type ExecutionTruthReceiptPayload
} from "../src/execution_truth/receipt.js";

const CONTRACT_PATH = path.resolve("..", "..", "contracts", "execution-truth", "contract.v1.json");
const GOLDEN_PATH = path.resolve("..", "..", "contracts", "execution-truth", "golden-receipt.v1.json");

const hash = (character: string): string => `sha256:${character.repeat(64)}`;

function minimalPayload(): ExecutionTruthReceiptPayload {
  return {
    schema: EXECUTION_TRUTH_RECEIPT_SCHEMA,
    version: EXECUTION_TRUTH_RECEIPT_VERSION,
    canonicalization: EXECUTION_TRUTH_CANONICALIZATION,
    observed_at_utc: "2026-07-31T17:00:00.000Z",
    execution: {
      execution_id: "exec-001",
      attempt: 1,
      executor_id: "revit-operator.test.v1"
    },
    request: {
      request_hash: hash("a")
    },
    document: {
      project_fingerprint: hash("b")
    },
    fence: {
      kind: "none"
    },
    outcome: {
      status: "succeeded",
      effect: "read_only",
      retryable: false,
      reconciliation_required: false
    },
    transactions: [],
    changes: {
      coverage: "not_applicable"
    },
    evidence_refs: [],
    verifier_refs: [],
    result_sha256: hash("c")
  };
}

function expectReject(value: unknown, pattern: RegExp): void {
  assert.throws(() => createExecutionTruthReceipt(value as ExecutionTruthReceiptPayload), pattern);
}

test("cross-runtime JSON Schema accepts the golden receipt and the strict parser verifies its identity", () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")) as object;
  const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, "utf8")) as ExecutionTruthReceipt;
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const validate = ajv.compile(contract);

  assert.equal(validate(golden), true, JSON.stringify(validate.errors));
  const parsed = parseExecutionTruthReceipt(golden);
  assert.equal(parsed.receipt_sha256, "sha256:dbb02f0b8559428cac057b56551451abe90de64317206995f0af2c7be554002d");
  assert.equal(hashExecutionTruthReceipt(parsed), parsed.receipt_sha256);

  const { receipt_sha256: _declared, ...payload } = golden;
  assert.deepEqual(createExecutionTruthReceipt(payload), parsed);
});

test("create normalizes canonical text, hashes without receipt_sha256, and recursively freezes the observation", () => {
  const payload = minimalPayload();
  payload.document.title = "CAFE\u0301";
  const receipt = createExecutionTruthReceipt(payload);

  assert.equal(receipt.document.title, "CAFÉ");
  assert.equal(hashExecutionTruthReceipt(receipt), receipt.receipt_sha256);
  assert.equal(Object.isFrozen(receipt), true);
  assert.equal(Object.isFrozen(receipt.outcome), true);
  assert.equal(Object.isFrozen(receipt.transactions), true);
  assert.throws(() => { (receipt.outcome as { effect: string }).effect = "committed"; }, TypeError);

  const withDifferentDeclaredHash = { ...receipt, receipt_sha256: hash("f") } as ExecutionTruthReceipt;
  assert.equal(hashExecutionTruthReceipt(withDifferentDeclaredHash), receipt.receipt_sha256);
  assert.throws(() => parseExecutionTruthReceipt(withDifferentDeclaredHash), /does not match the canonical receipt payload/);
});

test("unknown outcome is non-retryable and reconciliation-required even when a verifier passes", () => {
  const payload = minimalPayload();
  payload.outcome = {
    status: "unknown",
    effect: "unknown",
    retryable: false,
    reconciliation_required: true
  };
  payload.changes = { coverage: "unavailable" };
  payload.verifier_refs = [{
    verifier_id: "native-readback",
    verifier_version: "1.0.0",
    status: "passed",
    receipt_ref: {
      kind: "verifier_receipt",
      workspace_relative_path: "artifacts/execution-truth/verifier.json",
      sha256: hash("d"),
      media_type: "application/json"
    }
  }];

  const receipt = createExecutionTruthReceipt(payload);
  assert.deepEqual(receipt.outcome, payload.outcome);
  assert.equal(receipt.verifier_refs[0]?.status, "passed");

  for (const invalid of [
    { status: "unknown", effect: "unknown", retryable: true, reconciliation_required: true },
    { status: "unknown", effect: "unknown", retryable: false, reconciliation_required: false },
    { status: "unknown", effect: "committed", retryable: false, reconciliation_required: true }
  ]) {
    expectReject({ ...minimalPayload(), outcome: invalid, changes: { coverage: "unavailable" } }, /unknown|incompatible/);
  }
});

test("status/effect, retry, transaction, and change coverage claims fail closed", () => {
  expectReject({
    ...minimalPayload(),
    outcome: { status: "succeeded", effect: "committed", retryable: true, reconciliation_required: false },
    changes: { coverage: "complete", created_count: 1 }
  }, /retryable/);

  expectReject({
    ...minimalPayload(),
    outcome: { status: "failed", effect: "partial", retryable: false, reconciliation_required: false },
    changes: { coverage: "partial", truncated: true, omitted_count: 1 }
  }, /partial effects require/);

  expectReject({
    ...minimalPayload(),
    transactions: [{ transaction_id: "tx-001", impact_state: "committed" }]
  }, /read_only effects cannot claim transactions/);

  expectReject({
    ...minimalPayload(),
    outcome: { status: "failed", effect: "rolled_back", retryable: true, reconciliation_required: false },
    transactions: [{ transaction_id: "tx-001", impact_state: "committed" }],
    changes: { coverage: "complete", created_count: 0, modified_count: 0, deleted_count: 0 }
  }, /must be rolledBack/);

  expectReject({
    ...minimalPayload(),
    outcome: { status: "succeeded", effect: "committed", retryable: false, reconciliation_required: false },
    changes: { coverage: "not_applicable" }
  }, /cannot use not_applicable/);

  expectReject({
    ...minimalPayload(),
    outcome: { status: "failed", effect: "partial", retryable: false, reconciliation_required: true },
    changes: { coverage: "complete", truncated: true }
  }, /complete coverage cannot be truncated/);
});

test("receipt creation never invents transactions, undo identifiers, or document state hashes", () => {
  const payload = minimalPayload();
  payload.outcome = {
    status: "succeeded",
    effect: "committed",
    retryable: false,
    reconciliation_required: false
  };
  payload.changes = { coverage: "unavailable" };
  const receipt = createExecutionTruthReceipt(payload);

  assert.deepEqual(receipt.transactions, []);
  assert.equal(Object.hasOwn(receipt.document, "state_before_sha256"), false);
  assert.equal(Object.hasOwn(receipt.document, "state_after_sha256"), false);

  expectReject({
    ...minimalPayload(),
    outcome: { status: "succeeded", effect: "committed", retryable: false, reconciliation_required: false },
    changes: { coverage: "unavailable" },
    transactions: [{ transaction_id: "tx-001", impact_state: "committed", undo_id: "invented-undo-id" }]
  }, /unknown field: undo_id/);
});

test("absolute paths, traversal, raw token fields, obvious credentials, and unbounded or unordered data are rejected", () => {
  for (const unsafePath of [
    "C:/Projects/model.rvt",
    "/srv/operator/model.rvt",
    "../model.rvt",
    "artifacts/../secret.json",
    "\\\\server\\share\\model.rvt"
  ]) {
    expectReject({ ...minimalPayload(), document: { project_fingerprint: hash("b"), path: unsafePath } }, /workspace-relative path/);
  }

  expectReject({ ...minimalPayload(), fence: { kind: "batch_claim", token: "raw-secret" } }, /unknown field: token/);
  expectReject({ ...minimalPayload(), fence: { kind: "none", token_sha256: hash("d") } }, /must not carry token_sha256/);
  expectReject({ ...minimalPayload(), document: { project_fingerprint: hash("b"), title: "Bearer abcdefghijklmnop" } }, /raw credential/);
  expectReject({ ...minimalPayload(), document: { project_fingerprint: hash("b"), title: "Basic dXNlcjpwYXNz" } }, /raw credential/);
  expectReject({
    ...minimalPayload(),
    request: { request_hash: hash("a"), effect_hashes: [hash("f"), hash("e")] }
  }, /ordinal-sorted hashes/);
  expectReject({ ...minimalPayload(), document: { project_fingerprint: hash("b"), title: "X".repeat(257) } }, /no longer than 256/);
  expectReject({ ...minimalPayload(), unexpected: true }, /unknown field: unexpected/);
});

test("artifact and verifier references are typed, relative, bounded, and deterministically ordered", () => {
  const baseRef = {
    workspace_relative_path: "artifacts/execution-truth/evidence.json",
    sha256: hash("d"),
    media_type: "application/json"
  };
  expectReject({
    ...minimalPayload(),
    evidence_refs: [{ kind: "verifier_receipt", ...baseRef }]
  }, /must be carried by verifier_refs/);
  expectReject({
    ...minimalPayload(),
    evidence_refs: [
      { kind: "result", ...baseRef, workspace_relative_path: "artifacts/z.json" },
      { kind: "evidence", ...baseRef, workspace_relative_path: "artifacts/a.json" }
    ]
  }, /ordinal-sorted artifact references/);
  expectReject({
    ...minimalPayload(),
    verifier_refs: [{
      verifier_id: "check",
      verifier_version: "1.0.0",
      status: "passed",
      receipt_ref: { kind: "evidence", ...baseRef }
    }]
  }, /must be verifier_receipt/);
});

test("tampering with any observation field invalidates receipt_sha256", () => {
  const receipt = createExecutionTruthReceipt(minimalPayload());
  const tampered = structuredClone(receipt) as ExecutionTruthReceipt;
  tampered.result_sha256 = hash("e");
  assert.throws(() => parseExecutionTruthReceipt(tampered), /does not match the canonical receipt payload/);
});
