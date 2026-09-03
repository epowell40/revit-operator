# Evidence projection and bounded model context

## Invariant

Native Revit, Dynamic Runtime, screenshot, state, receipt, and verification
evidence is retained as immutable, hash-verified evidence under the existing
principal-scoped Workspace. Model requests consume deterministic typed
projections by default. Assignment/effect truth and verifier authority do not
depend on the projection or on assistant prose.

## Durable layout

- `Workspace/evidence/objects/sha256/<prefix>/<digest>.bin` contains the raw
  content object.
- `Workspace/evidence/refs/<evidence-id>.json` contains the immutable
  `revit-operator.evidence-ref.v1` metadata and Assignment/run/attempt scope.
- `Workspace/evidence/telemetry.jsonl` contains non-authoritative byte and
  budget telemetry.

Objects are created atomically and never overwritten. Reusing the same content
in the same source/scope returns the existing reference. Every read verifies
the stored byte count and SHA-256 digest. The principal request context selects
the Workspace root, and retrieval additionally fences session, Assignment,
run, and attempt identities. Lexical containment, symlink checks, strong-secret
screening, bounded identifiers, and hard byte limits apply before storage or
retrieval.

## Model projection

`revit-operator.evidence-projection.v1` deterministically preserves evidence
identity, content hash/size/type/source, trust and effect state, canonical
Assignment identities, bounded target identities, counts, acceptance-relevant
scalar facts, before/after hashes, diagnostics, verification relevance, and an
explicit indication that additional evidence exists. It does not use an LLM.

Default budgets are 8 KiB per evidence item and 32 KiB per model request. They
can be lowered or raised within hard bounds with
`OPERATOR_EVIDENCE_ITEM_BUDGET_BYTES` and
`OPERATOR_EVIDENCE_REQUEST_BUDGET_BYTES`. A raw function-tool output over the
item budget must be stored before the outer model relay accepts it.

## Focused retrieval

An authorized caller names exactly one `evidence_id`, its scope, a concrete
purpose, and one selector:

- typed field paths;
- a bounded array item range;
- a bounded UTF-8 text range;
- a focused target subset; or
- one selected image/capture.

The versioned selector contract is shared by the MCP and backend processes.
Supplying no selector or composing two selectors is invalid; the backend never
silently gives one selector precedence over another. A target subset matches
only exact values in reviewed identity fields (or exact keys in an
identity-keyed map). It returns complete target-bound rows and matching members
of identity arrays. Arbitrary prose, partial identifiers, and nearby unrelated
rows cannot establish target identity. Every requested target must match or the
selection fails atomically.

The backend rejects unbounded retrieval, “all evidence” requests, cross-scope
lookups, unsafe field paths, and selections above the requested/hard byte cap.
Target selection scans the normalized semantic payload once; it does not scan
or duplicate a synthetic envelope alias. The MCP `operator_retrieve_evidence`
tool exposes the same authenticated interface and validates the shared
selector contract before transport. Deterministic and visual verifiers can
instead read the full authoritative bytes through the internal hash-verifying
API.

## Telemetry

Events record raw bytes produced, unique bytes stored, projected bytes sent,
duplicate bytes avoided, focused expansions, budget events, and estimated
token avoidance per session/Assignment/model call where those identities are
available. Aggregation reports the largest evidence producers. Telemetry is
observability only and cannot establish effect or verification truth.
