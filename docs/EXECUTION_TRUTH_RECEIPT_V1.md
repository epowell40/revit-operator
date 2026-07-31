# Execution Truth Receipt v1

The Execution Truth Receipt (ETR) is an immutable, bounded observation created after one execution attempt. It records what the executor can truthfully establish about dispatch, effect, transactions, changes, and verification. It is evidence, not a command and not permission to retry.

The normative artifacts are:

- `contracts/execution-truth/contract.v1.json` — closed JSON Schema.
- `contracts/execution-truth/golden-receipt.v1.json` — cross-runtime fixture with a verified content hash.
- `contracts/execution-truth/conformance-corpus.v1.json` — shared canonicalization, ordering, structural, and semantic vectors.
- `apps/operator-backend/src/execution_truth/receipt.ts` — strict TypeScript parser, creator, and hasher.

V1 does not change any current runtime, worker, task, courier, MCP, or native add-in behavior. Producers and consumers are integrated separately.

## Normative validation boundary

The JSON Schema is structural. It closes object shapes and covers JSON-expressible types, enums, bounds, and several cross-field rules. Schema acceptance alone does **not** establish a valid ETR. JSON Schema cannot recompute `receipt_sha256`, compare two sibling state hashes, validate the calendar date behind a timestamp-shaped string, perform filesystem realpath containment, or consistently enforce NFC, unpaired-surrogate rejection, ordinal ordering, total UTF-8 bytes, and secret screening across runtimes.

The normative acceptance gate is the strict semantic parser plus canonical hash verification. A consumer must:

1. Apply the structural schema.
2. Apply every semantic rule in this document and the shared conformance corpus.
3. Recompute and compare `receipt_sha256`.
4. Before opening `document.path`, perform the required realpath containment check described below.

`conformance-corpus.v1.json` records `schema_valid` and `semantic_valid` separately so a structurally valid but semantically unsafe receipt cannot be mistaken for accepted execution truth.

## Contract shape

Every receipt has these top-level fields and no others:

| Field | Meaning |
| --- | --- |
| `schema` | Exact value `revit-operator.execution-truth-receipt.v1`. |
| `version` | Integer `1`. |
| `canonicalization` | Exact value `revit-operator.canonical-json.nfc.v1`. |
| `observed_at_utc` | Canonical UTC timestamp with milliseconds. |
| `execution` | Execution identity, one-based attempt, executor identity, and optional task/job/session/action bindings. |
| `request` | Required canonical request hash plus optional exact HTTP route and reviewed effect, policy, and authorization hashes. |
| `document` | Required project fingerprint and optional document session/title/relative path and independently observed state hashes. |
| `fence` | The execution fence kind and, when present, only the SHA-256 of its token. |
| `outcome` | Status, observed effect, typed code/phase, retry classification, and reconciliation requirement. |
| `transactions` | Bounded producer-observed transaction records in execution order. |
| `changes` | Bounded change-manifest coverage and counts. |
| `evidence_refs` | Sorted, workspace-relative, content-addressed evidence artifacts. |
| `verifier_refs` | Sorted verifier results and their content-addressed receipts. |
| `result_sha256` | Hash of the exact result envelope retained by the producer. |
| `receipt_sha256` | Identity of this receipt: the canonical payload hash with `receipt_sha256` excluded. |

There is no separate random `receipt_id`. The receipt content hash is its stable identity.

## Truth invariants

Normative acceptance fails closed on these contradictory claims. The structural schema covers the JSON-expressible subset; the semantic parser covers the complete list:

- `status: "unknown"` requires `effect: "unknown"`, `reconciliation_required: true`, and `retryable: false`.
- A committed effect and a partial effect are never ordinarily retryable. Partial effects require reconciliation.
- A succeeded outcome is limited to `read_only`, `no_change`, or `committed` and is not retryable.
- A failed outcome is limited to `not_started`, `no_change`, `rolled_back`, or `partial`.
- `read_only` and `not_started` cannot claim transactions and require `changes.coverage: "not_applicable"`.
- `committed`, `partial`, and `unknown` cannot claim that change coverage is not applicable.
- Complete change coverage cannot be truncated or have omitted changes. An `omitted_count` requires partial coverage with `truncated: true`.
- A rolled-back outcome cannot contain a transaction claiming a committed impact.
- Change counts describe final durable effects of this execution only. They exclude transient elements or edits that were rolled back.
- `effect: "no_change"` requires complete change coverage with all three final counts present and zero, no transaction with `impact_state: "committed"`, and equal before/after state hashes when both hashes are present.

The executor's post-execution observation owns `outcome.effect`. A verifier can corroborate, fail, or remain inconclusive, but a passing verifier never upgrades `unknown`, `not_started`, `rolled_back`, or `partial` to `committed`. The v1 parser preserves the producer's effect verbatim and never derives it from `verifier_refs`.

The creator adds only `receipt_sha256`. It never fabricates:

- a Revit transaction ID;
- an Undo ID or Undo stack position;
- an Undo label;
- before/after document state hashes;
- change counts or a change manifest;
- evidence or verifier receipts.

If a host cannot provide a real transaction identity, it leaves `transactions` empty. `undo_label` is descriptive producer evidence, not an Undo ID. Optional state hashes are present only when independently measured.

## Secret and path safety

The receipt is safe to persist and move between the backend, Sidecar, MCP, and native host only when it contains references and hashes—not secret material.

- Fence tokens are represented only as `token_sha256`.
- Authorization evidence is represented only as `authorization_hashes`.
- Unknown fields such as `token`, `authorization`, or `undo_id` are rejected.
- Obvious bearer, JWT, OpenAI, AWS, and Slack credential patterns are rejected from free-text fields by the strict parser.
- `document.path` and every `workspace_relative_path` must use forward slashes, remain relative, and contain no drive prefix, UNC/root prefix, colon/alternate-data-stream syntax, empty segment, `.` segment, or `..` traversal.
- Portable path segments reject trailing dots/spaces and Windows device names case-insensitively, including device names with extensions (`CON`, `PRN`, `AUX`, `NUL`, `COM1`-`COM9`, and `LPT1`-`LPT9`, including the Windows superscript digit variants).
- Artifact content stays outside the receipt. Each reference contains only `kind`, `workspace_relative_path`, `sha256`, and a lowercase media type.

Callers remain responsible for not placing sensitive customer or project data in otherwise valid identifiers and labels.

A relative path is not proof of filesystem containment. Before any IO using `document.path`, a consumer must resolve both the workspace root and candidate through the platform's realpath facility and require the resolved candidate to remain beneath the resolved workspace root. A missing path, failed resolution, symlink, junction, mount, or Windows reparse point that escapes the root fails closed. TypeScript consumers use `resolveExecutionTruthDocumentPath(...)`; other runtimes must implement an equivalent check. Parsing a receipt does not perform IO and therefore does not by itself authorize opening the path.

## Canonicalization and hashing

`revit-operator.canonical-json.nfc.v1` combines an ETR string precondition with the repository's existing `canonicalJson` algorithm:

1. Before `canonicalJson`, reject unpaired UTF-16 surrogates. Field bounds are measured in Unicode scalar values rather than UTF-16 code units.
2. `canonicalJson` accepts only plain JSON data and finite numbers.
3. It normalizes CRLF or CR line endings in keys and strings to LF.
4. It normalizes keys and strings to Unicode NFC.
5. Reject keys that collide after normalization.
6. Sort object keys by ordinal ECMAScript string order (UTF-16 code units).
7. Preserve array order and serialize with ECMAScript `JSON.stringify` JSON-number/string rules.
8. Encode the canonical JSON as UTF-8.

To calculate receipt identity:

1. Strictly validate and canonicalize the complete payload.
2. Omit the top-level `receipt_sha256` field. Do not blank it or hash a placeholder.
3. SHA-256 hash the canonical UTF-8 bytes.
4. Encode as `sha256:` plus 64 lowercase hexadecimal characters.

Changing any observation, reference, ordering, or binding invalidates the declared hash. The canonical receipt may not exceed 131,072 UTF-8 bytes.

Hash arrays and artifact/verifier reference arrays use unique ordinal-sorted order. Artifact composite keys are `kind + U+0000 + workspace_relative_path + U+0000 + sha256`; verifier composite keys are `verifier_id + U+0000 + verifier_version + U+0000 + receipt workspace_relative_path`. Each composite is compared by ordinal UTF-16 code units. Transaction order is preserved because it represents execution order.

## Bounds

| Data | Maximum |
| --- | ---: |
| Canonical receipt | 131,072 UTF-8 bytes |
| Identifier | 128 Unicode scalar values |
| Title or Undo label | 256 Unicode scalar values |
| Relative path | 1,024 Unicode scalar values |
| Request path | 512 Unicode scalar values |
| Each effect/policy/authorization hash set | 32 entries |
| Transactions | 64 entries |
| Evidence references | 64 entries |
| Verifier references | 32 entries |
| Any change count | 1,000,000,000 |

All numeric fields must be safe integers within their declared range.

## TypeScript use

```ts
import {
  createExecutionTruthReceipt,
  parseExecutionTruthReceipt
} from "./execution_truth/receipt.js";

const receipt = createExecutionTruthReceipt(postExecutionObservation);
// receipt and every nested object/array are frozen.

const verified = parseExecutionTruthReceipt(JSON.parse(receivedJson));
// Throws on unknown fields, invalid bounds, contradictory truth, or hash mismatch.
```

Cross-runtime implementations should load the JSON Schema, reproduce the canonicalization and semantic invariants above, and verify `golden-receipt.v1.json`. The golden receipt identity is:

```text
sha256:dbb02f0b8559428cac057b56551451abe90de64317206995f0af2c7be554002d
```

They must also run `conformance-corpus.v1.json`. Ordinary receipt cases start from `base_payload`; `replace` sets the JSON Pointer to `value`, and `repeat_string` sets it to `value` repeated `count` times. The `max_bounded_transactions` generator changes the outcome to committed, sets complete counts to `0, transaction_count, 0`, and creates the declared number of committed transactions. For zero-based index `i`, the ID is `tx-NN-` padded with `x` to `transaction_id_scalar_length`, the Undo label is `😀` repeated `undo_label_scalar_length`, the receipt path is `artifacts/` padded with `x` to `receipt_path_scalar_length`, and the digest body repeats `"0123456789abcdef"[i mod 16]` 64 times. It exists to prove that individually bounded fields can still exceed the total canonical-byte limit. Canonicalization vectors cover NFC/NFD normalization, non-ASCII values, astral characters, UTF-16 key order, normalized-key collisions, and composite sorting.
