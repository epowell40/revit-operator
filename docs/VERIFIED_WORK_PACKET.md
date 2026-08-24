# Verified Work Packet

`revit-operator.verified-work-packet/v1` is the deterministic customer-facing
artifact for a settled Goal-backed Assignment. It is a projection, not a new
completion store or verifier.

## Truth inputs

The generator consumes only durable structured state:

- the Goal identity, normalized objective, scope, work package, terminal state,
  and trusted completion audit;
- the canonical Assignment reducer's run, generation, attempt, effect,
  verification, retry, reconciliation, rollback, and terminal state;
- scoped `EvidenceRefV1` metadata and typed Goal evidence;
- structured artifact, collateral, authorization, and performance fields when
  recorded.

Assistant prose is never parsed to decide packet status. Caller-reported
receipts remain caller-reported. Cross-Assignment, missing, or stale evidence
is retained as an issue and cannot support a verified claim.

For authoritative read completion, acceptance-criterion observations include
the canonical structured-result digest, assertion IDs, and supporting
EvidenceRef IDs. The action table retains the exact native read attempts,
receipts, and immutable evidence references. This makes the read result
auditable without copying the raw payload into the packet or trusting the
assistant's wording.

## Status rules

- `verified_complete` requires the existing canonical verification allowed for
  the requested effect plus a passing trusted acceptance audit.
- `verified_no_op` additionally requires the canonical two-observation,
  target-bound no-op proof.
- an applied native effect without complete task verification is
  `complete_with_issues`; failed verification never erases the apply receipt.
- `unknown` effects remain visible and produce `complete_with_issues` pending
  exact-target reconciliation without replay.
- rollback, block, clarification, collateral failure, and no-effect failure are
  projected from their structured canonical states.

## Identity and immutability

The packet hash is SHA-256 over a key-sorted canonical representation excluding
only `packet_id` and `packet_hash`. The packet ID is derived from that digest.
Creation time comes from durable settlement state, so repeated generation of an
unchanged settled Assignment is byte-stable.

Canonical JSON and Markdown are written create-only under the existing scoped
Workspace tree:

`artifacts/goals/<assignment-id>/verified-work-packets/`

If a later release legitimately projects new structured state, the new packet
names the prior immutable packet as `parent_packet_id`.

## Retrieval

Authenticated callers may retrieve the current packet through:

`GET /api/assignments/<goal-or-assignment-id>/verified-work-packet`

Use `?format=markdown` for the customer-readable rendering. The route reuses
the existing operator-token and principal/session authorization boundary.
Artifact locations are not anonymously published; EvidenceRef expansion keeps
its existing scope, path, secret-screening, and byte-limit enforcement.
