import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, sha256, type JsonValue } from "../src/capabilities/tool_certification.js";
import {
  EXECUTION_TRUTH_CANONICALIZATION,
  EXECUTION_TRUTH_RECEIPT_MAX_BYTES,
  EXECUTION_TRUTH_RECEIPT_SCHEMA,
  EXECUTION_TRUTH_RECEIPT_VERSION,
  createExecutionTruthReceipt,
  hashExecutionTruthReceipt,
  parseExecutionTruthReceipt,
  resolveExecutionTruthDocumentPath,
  type ExecutionTruthReceipt,
  type ExecutionTruthReceiptPayload
} from "../src/execution_truth/receipt.js";

const CONTRACT_PATH = path.resolve("..", "..", "contracts", "execution-truth", "contract.v1.json");
const GOLDEN_PATH = path.resolve("..", "..", "contracts", "execution-truth", "golden-receipt.v1.json");
const CONFORMANCE_PATH = path.resolve("..", "..", "contracts", "execution-truth", "conformance-corpus.v1.json");

type CorpusMutation = {
  op: "replace" | "repeat_string";
  pointer: string;
  value: unknown;
  count?: number;
};

type ConformanceCorpus = {
  base_payload: ExecutionTruthReceiptPayload;
  canonicalization_vectors: Array<{
    id: string;
    input: JsonValue;
    expected_canonical_json?: string;
    expected_sha256?: string;
    expected_error_contains?: string;
  }>;
  composite_sort_vectors: Array<{
    id: string;
    delimiter: "U+0000";
    ordering: "ordinal_utf16_code_units";
    entries: Array<{ id: string; parts: string[] }>;
    expected_ids: string[];
  }>;
  receipt_cases: Array<{
    id: string;
    schema_valid: boolean;
    semantic_valid: boolean;
    mutations: CorpusMutation[];
    generator?: {
      kind: "max_bounded_transactions";
      transaction_count: number;
      transaction_id_scalar_length: number;
      undo_label_scalar_length: number;
      receipt_path_scalar_length: number;
    };
  }>;
};

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

function replaceAtPointer(target: Record<string, unknown>, pointer: string, value: unknown): void {
  const parts = pointer.split("/").slice(1).map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  assert.ok(parts.length > 0 && parts.every(Boolean), `invalid conformance pointer: ${pointer}`);
  let parent: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = parent[part];
    assert.ok(next && typeof next === "object" && !Array.isArray(next), `missing conformance pointer parent: ${pointer}`);
    parent = next as Record<string, unknown>;
  }
  parent[parts.at(-1)!] = value;
}

function applyCorpusMutations(payload: ExecutionTruthReceiptPayload, mutations: CorpusMutation[]): void {
  for (const mutation of mutations) {
    const value = mutation.op === "repeat_string"
      ? String(mutation.value).repeat(mutation.count ?? 0)
      : structuredClone(mutation.value);
    replaceAtPointer(payload as unknown as Record<string, unknown>, mutation.pointer, value);
  }
}

function generateMaxBoundedTransactions(
  payload: ExecutionTruthReceiptPayload,
  generator: NonNullable<ConformanceCorpus["receipt_cases"][number]["generator"]>
): void {
  assert.equal(generator.kind, "max_bounded_transactions");
  payload.outcome = {
    status: "succeeded",
    effect: "committed",
    retryable: false,
    reconciliation_required: false
  };
  payload.changes = {
    coverage: "complete",
    created_count: 0,
    modified_count: generator.transaction_count,
    deleted_count: 0
  };
  payload.transactions = Array.from({ length: generator.transaction_count }, (_, index) => {
    const prefix = `tx-${String(index).padStart(2, "0")}-`;
    const transactionId = `${prefix}${"x".repeat(generator.transaction_id_scalar_length - prefix.length)}`;
    const pathPrefix = "artifacts/";
    const receiptPath = `${pathPrefix}${"x".repeat(generator.receipt_path_scalar_length - pathPrefix.length)}`;
    const hashCharacter = "0123456789abcdef"[index % 16]!;
    return {
      transaction_id: transactionId,
      undo_label: "😀".repeat(generator.undo_label_scalar_length),
      impact_state: "committed" as const,
      receipt_ref: {
        kind: "transaction_receipt" as const,
        workspace_relative_path: receiptPath,
        sha256: hash(hashCharacter),
        media_type: "application/json"
      }
    };
  });
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

test("shared canonicalization and composite-sort vectors are stable for future runtimes", () => {
  const corpus = JSON.parse(fs.readFileSync(CONFORMANCE_PATH, "utf8")) as ConformanceCorpus;
  for (const vector of corpus.canonicalization_vectors) {
    if (vector.expected_error_contains) {
      assert.throws(() => canonicalJson(vector.input), new RegExp(vector.expected_error_contains), vector.id);
      continue;
    }
    assert.equal(canonicalJson(vector.input), vector.expected_canonical_json, vector.id);
    assert.equal(sha256(vector.input), vector.expected_sha256, vector.id);
  }
  for (const vector of corpus.composite_sort_vectors) {
    assert.equal(vector.delimiter, "U+0000", vector.id);
    assert.equal(vector.ordering, "ordinal_utf16_code_units", vector.id);
    const actual = [...vector.entries]
      .sort((left, right) => {
        const leftKey = left.parts.join("\u0000");
        const rightKey = right.parts.join("\u0000");
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      })
      .map(entry => entry.id);
    assert.deepEqual(actual, vector.expected_ids, vector.id);
  }
});

test("shared corpus distinguishes structural JSON Schema acceptance from normative semantic acceptance", () => {
  const contract = JSON.parse(fs.readFileSync(CONTRACT_PATH, "utf8")) as object;
  const corpus = JSON.parse(fs.readFileSync(CONFORMANCE_PATH, "utf8")) as ConformanceCorpus;
  const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: false });
  const validate = ajv.compile(contract);

  for (const receiptCase of corpus.receipt_cases) {
    const payload = structuredClone(corpus.base_payload);
    applyCorpusMutations(payload, receiptCase.mutations);
    if (receiptCase.generator) generateMaxBoundedTransactions(payload, receiptCase.generator);
    const receipt = {
      ...payload,
      receipt_sha256: sha256(payload as unknown as JsonValue)
    };
    assert.equal(validate(receipt), receiptCase.schema_valid, `${receiptCase.id}: ${JSON.stringify(validate.errors)}`);
    let semanticValid = true;
    try {
      parseExecutionTruthReceipt(receipt);
    } catch {
      semanticValid = false;
    }
    assert.equal(semanticValid, receiptCase.semantic_valid, receiptCase.id);
    if (receiptCase.id === "invalid_total_canonical_bytes") {
      assert.ok(Buffer.byteLength(canonicalJson(receipt as unknown as JsonValue), "utf8") > EXECUTION_TRUTH_RECEIPT_MAX_BYTES);
    }
  }
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
    expectReject(
      { ...minimalPayload(), document: { project_fingerprint: hash("b"), path: unsafePath } },
      /workspace-relative path|segment ending in a dot or space/
    );
  }
  for (const devicePath of [
    "models/CON",
    "models/prn.txt",
    "models/AUX.rvt",
    "models/nul.log",
    "models/COM1.txt",
    "models/lpt9.rvt",
    "models/COM¹.cache"
  ]) {
    expectReject(
      { ...minimalPayload(), document: { project_fingerprint: hash("b"), path: devicePath } },
      /reserved Windows device segment/
    );
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

test("document IO resolution requires realpath containment across symlinks and reparse points", () => {
  const workspaceRoot = path.resolve("C:\\etr-conformance-workspace");
  const lexicalDocument = path.resolve(workspaceRoot, "models", "model.rvt");
  const resolvedRoot = path.resolve("C:\\etr-real-workspace");
  const resolvedInside = path.join(resolvedRoot, "models", "model.rvt");
  const resolvedOutside = path.resolve("C:\\outside", "model.rvt");

  const containedResolver = (candidate: string): string => candidate === workspaceRoot ? resolvedRoot : resolvedInside;
  assert.equal(
    resolveExecutionTruthDocumentPath(workspaceRoot, "models/model.rvt", containedResolver),
    resolvedInside
  );

  const escapingResolver = (candidate: string): string => candidate === workspaceRoot ? resolvedRoot : resolvedOutside;
  assert.throws(
    () => resolveExecutionTruthDocumentPath(workspaceRoot, "models/model.rvt", escapingResolver),
    /symlink or reparse point outside workspaceRoot/
  );
  assert.throws(() => resolveExecutionTruthDocumentPath("relative-root", "models/model.rvt", containedResolver), /must be an absolute path/);
  assert.equal(lexicalDocument.startsWith(workspaceRoot), true);
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
