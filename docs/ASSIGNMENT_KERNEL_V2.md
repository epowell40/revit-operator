# Assignment Kernel V2

Status: pure kernel and reviewed edge adapters implemented; execution feature
flag defaults off.

## Decision

V2 Assignments have one durable event journal and one pure snapshot. The
canonical domain consists of `AssignmentSpecV2`, `AssignmentEventV2`,
`AssignmentSnapshotV2`, `OperationV2`, `OperationResultV2`, `ObservationV2`,
and `CriterionEvaluationV2`.

HTTP, MCP, Codex app-server, Sidecar, Revit routes, Work Returns, Work Packets,
and benchmark records are not Assignment truth. They are edge adapters or
read-only projections. Historical V1 Assignments remain immutable and readable
through a legacy adapter; new V2 Assignments will write only the V2 journal.

## Invariants

1. The trusted host creates `AssignmentSpecV2` and injects principal, session,
   run, generation, and document binding. A model cannot author those values.
2. Requested effect is assigned by the spec or an admitted work unit. No
   transport or presentation layer may reclassify it.
3. The kernel assigns one `operation_id` before dispatch. That identity survives
   planner, transport, native execution, result, observation, and settlement.
4. Controller acceptance, MCP acceptance, native dispatch, native transaction
   settlement, result return, and evidence retention are distinct facts.
5. Native/runtime edges return one validated `OperationResultV2`. Canonical
   settlement does not recursively search arbitrary JSON or compare route
   strings to reconstruct identity.
6. Raw bytes are retained once. An `ObservationV2` is their single semantic
   interpretation. Evidence references and projections are storage and model-
   context views, not verifier truth.
7. Criteria cite stable operation, observation, and semantic-fact identities.
   There is no separate read-completion or no-op assertion language.
8. Assignment outcome is derived from criteria, work units, and operation
   state. Work Return, Work Packet, and Protocol V2 consume the same immutable
   snapshot and cannot write truth back.
9. Response loss is recovered by rereading Assignment identity and version,
   never by reconstructing state from a response-specific handoff.
10. V2 is disabled unless `OPERATOR_ASSIGNMENT_KERNEL_V2` is explicitly `1`,
    `true`, or `enabled`.
11. A trusted external controller starts either V1 or V2, never both. When V2
    is enabled, `/api/agent-goal` creates the V2 journal before returning the
    run binding and leaves the legacy control-plane event list untouched.
12. A committed apply is not task completion. It must be followed by a
    successful retained verification Observation linked to the exact applied
    operation and canonical target before an apply Assignment can derive
    `complete`.
13. Assignment progression is a versioned kernel concern. Each provider call
    and operation must eventually cite stable unresolved gap and criterion
    identities; a provider transcript cannot decide to continue on its own.
14. Semantic fact identity is schema-aware. Singular facts conflict only when
    the same identity has incompatible values; collection facts use declared
    identity dimensions and preserve distinct members.
15. Native bytes and normalized semantic payloads have separate hashes joined
    by an explicit, versioned transformation. Canonical settlement never
    compares hashes of different byte representations as though they were the
    same payload.

## Target flow

```text
trusted host -> AssignmentSpecV2 -> AssignmentEventV2 journal
planner -> admitted OperationV2(operation_id) -> transport edge
native edge -> OperationResultV2(operation_id) -> retained raw bytes
observation edge -> ObservationV2 semantic facts -> criterion events
pure reducer -> AssignmentSnapshotV2 -> read-only API/UI/audit projections
```

## Progression contracts

`ProgressGapV2` names the exact unresolved criterion, work unit, required fact,
and currently available observations. `ProgressDecisionV2` is the single typed
answer to "what happens next?" and `ProgressEpochV2` records whether a bounded
reasoning/execution cycle changed authoritative domain truth. Provider prose,
repeated observations, and equivalent operations are not progress.

The EPIC-0457 controller is a pure reducer-side decision owner. It evaluates
qualifying observations before admitting another reasoning turn, waits for
durably recorded provider calls and operations, prioritizes reconciliation,
requests authenticated input/review, and derives a truthful blocked or terminal
decision when no justified work remains. The live Codex edge now consults this
decision before starting a turn, injects only the admitted gap/criterion scope,
and stops the active turn when post-tool progression derives terminal,
clarification, review, or blocker truth.

Provider calls have a durable lifecycle ledger (`admitted`, `dispatched`,
`response_started`, `usage_received`, `completed`, and downstream
`response_transport_completed`). The provider call is bound at admission to
exact gaps, criteria, and expected information. Provider completion—not the
survival of a downstream response socket—ends provider work for Assignment
quiescence. Late telemetry can enrich a completed call without regressing or
rewriting its completion.

The app-server raw completion edge persists a compact completed lifecycle in
one journal event, including the distinct stage timestamps and exact usage.
This avoids converting one provider receipt into several expensive Goal-store
writes while preserving the same ledger semantics. A provider receipt never
creates semantic progress by itself. A no-tool response is judged only at the
quiescent turn checkpoint; a tool response is judged after the operation and
Observation settle. Either receipt/Observation ordering reaches the same
criterion evaluation without a grace-period timer.

Operations carry `advances_criterion_ids` and `resolves_gap_ids`; admission
fails when neither points to currently unresolved Assignment work. Equivalent
operation repetition needs a typed retry or reconciliation basis. Progress
epochs count only changes to authoritative observations, gaps, criteria, input,
review, uncertainty, work units, or derived outcome. Consecutive no-progress
epochs are bounded per unresolved gap set rather than accumulated forever
across unrelated productive work.

The generic emergency budgets bound provider calls, reasoning turns,
operations, equivalent operations, no-progress epochs, reconciliation attempts,
wall time, and known tokens. Exhaustion never creates success. Unknown effects
remain visible and replay-prohibited; once bounded reconciliation is exhausted,
the controller derives a truthful blocked outcome.

Semantic fact cardinality is part of the Observation contract:

- `one` uses the fact identity, dimensions, and target as one value slot;
- `many` additionally uses declared identity dimensions to distinguish
  collection members;
- byte-for-byte duplicate members are idempotent;
- incompatible values for the same fully resolved identity remain a conflict.

`PayloadProvenanceV2` records both the authenticated source-byte digest and the
canonical normalized-payload digest. The transformation ID and version explain
the relationship; neither digest is substituted for the other.

## Settlement ordering

An admitted operation is `open`, becomes `awaiting_result` only after explicit
native dispatch, and becomes `retaining_observation` when an authoritative
result requires durable semantic retention. It is `settled` only after the
matching `ObservationV2` has been appended. Therefore neither response return
nor controller acceptance can make a V2 Assignment quiescent prematurely.

Pre-dispatch rejection proves effect `none`. A dispatched apply is `unknown`
until an authoritative committed result or target-bound reconciliation settles
it. Retry requires a settled no-effect predecessor and a typed material-change
basis. Quiescence means no provider call or operation is actively executing;
a settled unknown effect remains an explicit reconciliation gap. A terminal
event is rejected while execution is in flight, and completion cannot be
derived while an unknown effect remains.

## Criterion authority

Each criterion declares accepted deterministic evaluator and observation
authorities plus stable semantic-fact requirements. A pass must cite current,
settled operations and every required fact. The pure evaluator detects
contradictory values for the same fact identity and produces `uncertain`.
Desired-state equivalence is an ordinary criterion basis: it requires known
stable input variables and explicit fact-to-variable comparisons. It is not a
second no-op proof language.

A one-criterion trusted Assignment may use the bounded `result.available`
fallback. A multi-criterion Assignment must provide an explicit
`assignment_kernel_v2_criteria` semantic-fact contract at the trusted creation
edge. This prevents one generic success flag from silently satisfying several
materially different requirements.

Opaque mutation input detection also runs once at the trusted AssignmentSpec
edge. Missing values become stable input variables (for example,
`replacement_text`) before provider inference; they are not guessed or added
later by a transport controller.

The result adapter unwraps only reviewed, explicit transport envelopes. It does
not recursively search result JSON. External field spelling and clarification
aliases are normalized once at their edge; lifecycle binding fields are never
accepted from model-authored input.

External spelling, transport envelopes, typed aliases, and native route names
are normalized exactly once at their registered edge. They do not enter the
domain vocabulary.

## Migration

The migration is intentionally not a dual write:

- V2 flag off: existing V1 execution is unchanged.
- V2 flag on for a new Assignment: write V2 journal only.
- Legacy consumers: receive V1-compatible read projections derived from V2.
- Historical V1 records: remain immutable and use the legacy read adapter.

The allowed semantic adapters are machine registered in
`scripts/assignment_kernel_allowed_adapters.v2.json`. Architecture checks reject
unregistered internal translation layers and forbidden domain dependencies.
