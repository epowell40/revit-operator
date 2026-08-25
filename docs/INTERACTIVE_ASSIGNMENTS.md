# Interactive Assignments and progressive delivery

Status: canonical production contract, version 1

Interactive work extends the existing Goal-backed Assignment event stream. It
does not add a lifecycle store, completion ledger, or transaction system.

## Outcome states

The canonical projection distinguishes `active`, `awaiting_user_input`,
`awaiting_user_review`, `complete`, `complete_with_issues`, `verified_noop`,
`blocked`, and `failed`. Awaiting states are nonterminal: the current Assignment
and its accepted evidence remain durable and resumable. A generation changes
only when the existing stale-callback fencing contract requires it.

Acceptance criteria project independently as `pass`, `partial`, `needs_input`,
`needs_review`, `failed`, `not_applicable`, or `uncertain`. Full completion
requires every required criterion to pass or be legitimately inapplicable.

## Clarification handshake

`revit-operator.assignment-clarification/v1` records the exact Assignment, run,
generation, session/principal boundary, missing fields, one focused question,
reason, completed work, affected work units, bounded options, primary artifact
references, and criterion states. The request is an append-only canonical event.
It immediately fences provider calls, new actions, and terminal settlement.

An authenticated `revit-operator.assignment-clarification-response/v1` must bind
the same clarification and current Assignment identity. It resolves only the
declared fields, is idempotent for an identical response, rejects stale or
foreign responses, and resumes the same Assignment. Completed work and evidence
are not reset. Secrets and credential-like keys are rejected recursively before
persistence.

MCP controllers use `operator_request_clarification`; hosted/Desktop callers use
the authenticated Assignment API. Assistant prose may render the question but
cannot create or resolve clarification state by itself.

## Verified no-op safety

A mutation is never a no-op merely because execution is quiescent or two reads
were successful. `revit-operator.assignment-noop-completion-claim/v1` requires:

- a fully specified desired postcondition frozen from the user request or a
  resolved clarification;
- an exact target identity and fingerprint;
- two fresh, authoritative, settled read observations of that exact target;
- authentic current-Assignment receipts and EvidenceRefs;
- deterministic assertions covering every Assignment acceptance criterion;
- no apply attempt, unknown effect, contradiction, or pending clarification.

The canonical validator, not the claimant, decides equivalence. Missing desired
state remains `awaiting_user_input`; discovery-only reads and assistant prose
cannot satisfy the contract.

## Work units, rollback, and deviation

Goal work items may describe `independent_safe_to_keep`, `coupled_atomic`, or
`analysis_or_advisory` execution. Each item carries dependencies, criterion
state, atomic group, retention policy, rollback scope, verification method,
unresolved variables, deviation envelope, attempt IDs, and primary artifacts.

An invalid coupled group rolls back that group. It does not erase unrelated,
independently useful completed work. Assignment-wide rollback is reserved for
an explicit all-or-nothing request or document-integrity requirement.

A reversible alternative may be retained only inside its declared tolerance and
the same semantic scope and host, with no code, clearance, accessibility, or
safety uncertainty. It becomes `awaiting_user_review` or
`complete_with_issues`; it is never presented as exact conformance.

## Work Return

`revit-operator.work-return/v1` is the concise user surface derived from the
canonical Assignment. It names completed work, primary model/document artifacts,
affected targets, material deviations/open items, one pending question, and the
recommended next step. Immutable JSON and Markdown are stored under the existing
Workspace artifact tree and retrieved through:

`GET /api/assignments/<assignment-id>/work-return`

The full Verified Work Packet remains the audit artifact. Failure to generate a
secondary audit artifact cannot rewrite valid native model state; it is reported
as a separate artifact failure.

## Protocol V2 interaction identity

Interactive benchmark execution preserves separate source and execution case
hashes, transformation identity/version, conversation-sequence hash,
candidate-visible input hash, protected evaluator-oracle hash, and per-turn
identities. Candidate-visible clarification answers are ordinary authenticated
user turns; evaluator-only criteria remain separate and are never exposed to the
candidate.

