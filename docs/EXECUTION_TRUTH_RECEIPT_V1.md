# Execution Truth Receipt v1

The Execution Truth Receipt (ETR) is an immutable, bounded observation created after one execution attempt. It records what the executor can truthfully establish about dispatch, effect, transactions, changes, and verification. It is evidence, not a command and not permission to retry.

The normative artifacts are:

- `contracts/execution-truth/contract.v1.json` — closed JSON Schema.
- `contracts/execution-truth/golden-receipt.v1.json` — cross-runtime fixture with a verified content hash.
- `apps/operator-backend/src/execution_truth/receipt.ts` — strict TypeScript parser, creator, and hasher.

V1 does not change any current runtime, worker, task, courier, MCP, or native add-in behavior. Producers and consumers are integrated separately.

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

The parser and schema fail closed on contradictory claims:

- `status: "unknown"` requires `effect: "unknown"`, `reconciliation_required: true`, and `retryable: false`.
- A committed effect and a partial effect are never ordinarily retryable. Partial effects require reconciliation.
- A succeeded outcome is limited to `read_only`, `no_change`, or `committed` and is not retryable.
- A failed outcome is limited to `not_started`, `no_change`, `rolled_back`, or `partial`.
- `read_only` and `not_started` cannot claim transactions and require `changes.coverage: "not_applicable"`.
- `committed`, `partial`, and `unknown` cannot claim that change coverage is not applicable.
- Complete change coverage cannot be truncated or have omitted changes. An `omitted_count` requires partial coverage with `truncated: true`.
- A rolled-back outcome cannot contain a transaction claiming a committed impact.

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
- `document.path` and every `workspace_relative_path` must use forward slashes, remain relative, and contain no drive prefix, UNC/root prefix, colon, empty segment, `.` segment, or `..` traversal.
- Artifact content stays outside the receipt. Each reference contains only `kind`, `workspace_relative_path`, `sha256`, and a lowercase media type.

Callers remain responsible for not placing sensitive customer or project data in otherwise valid identifiers and labels.

## Canonicalization and hashing

`revit-operator.canonical-json.nfc.v1` is the repository's existing `canonicalJson` algorithm:

1. Accept only plain JSON data and finite numbers.
2. Normalize CRLF or CR line endings in keys and strings to LF.
3. Normalize keys and strings to Unicode NFC.
4. Reject keys that collide after normalization.
5. Sort object keys by ordinal ECMAScript string order (UTF-16 code units).
6. Preserve array order and serialize with ECMAScript `JSON.stringify` JSON-number/string rules.
7. Encode the canonical JSON as UTF-8.

To calculate receipt identity:

1. Strictly validate and canonicalize the complete payload.
2. Omit the top-level `receipt_sha256` field. Do not blank it or hash a placeholder.
3. SHA-256 hash the canonical UTF-8 bytes.
4. Encode as `sha256:` plus 64 lowercase hexadecimal characters.

Changing any observation, reference, ordering, or binding invalidates the declared hash. The canonical receipt may not exceed 131,072 UTF-8 bytes.

Hash arrays and artifact/verifier reference arrays use unique ordinal-sorted order. Transaction order is preserved because it represents execution order.

## Bounds

| Data | Maximum |
| --- | ---: |
| Canonical receipt | 131,072 UTF-8 bytes |
| Identifier | 128 characters |
| Title or Undo label | 256 characters |
| Relative path | 1,024 characters |
| Request path | 512 characters |
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
