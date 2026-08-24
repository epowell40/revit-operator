# Assignment control plane

Status: canonical production contract, version 1

The existing durable Goal record is the Assignment ledger. `goal.json` stores an
`assignment_control_plane` event stream; no second database or parallel
settlement record exists. The pure reducer in
`apps/operator-backend/src/assignments/control_plane.ts` deterministically
projects that stream after a process restart.

External controllers start or recover their bound run through the generic Goal
API by sending `start_assignment_run: true` and, preferably, their durable
`assignment_run_id`. The response returns `assignment_run` with the Assignment
ID, exact run ID, and generation. Every later settlement callback must carry
that run/generation pair; it is never inferred from caller prose.

## Effect invariant

Every attempt has exactly one authoritative persistent-effect state:

- `none`: the host proves that no persistent change occurred. Admission,
  schema, confirmation, authorization, and pre-dispatch transport rejection,
  plus a successful native rollback, settle here. This does not consume the
  Assignment's apply opportunity.
- `unknown`: dispatch may have occurred but persistence is unresolved. No
  mutation or unrelated discovery is admitted until an exact-target read-only
  reconciliation resolves the original attempt.
- `applied`: a native transaction, native receipt, or exact target readback
  proves persistence. Open discovery and planning are closed immediately;
  only exact bounded verification, reconciliation, explicitly authorized
  rollback, or terminal settlement can follow.

Caller receipts and assistant prose are evidence, not effect authority. A
caller-reported apply success therefore remains `unknown`; prose cannot upgrade,
downgrade, or contradict the reducer.

## Versioned record

`revit-operator.assignment-attempt/v1` records the Assignment, attempt, run and
generation; purpose and requested read/preview/apply effect; route/tool,
canonical action signature, exact target fingerprint and target identities;
admission and dispatch; effect state/reason/authority; affected targets;
receipt/evidence references; verification; retry/reconciliation relationships;
timestamps; and terminal state. Events use
`revit-operator.assignment-attempt-event/v1`; the durable container and reducer
projection use `revit-operator.assignment-control-plane/v1` and
`revit-operator.assignment-control-plane-projection/v1`.

Events are append-only. Invalid, duplicate-terminal, stale-run, superseded-run,
closed-Assignment, and old-generation callbacks are retained in the Goal's
bounded quarantine and cannot change the projection.

## Before and after control flow

Before convergence, each row below classified or settled work independently.
After convergence, planners may differ, but every row journals through the same
event contract and consumes the same reducer projection.

| Path | Before | Canonical flow |
| --- | --- | --- |
| Goal/Assignment creation | Goal service created lifecycle truth; other lanes inferred their own run | Goal service creates the sole durable event container; the outer chat turn or explicitly bound external controller begins the run and generation |
| Codex General Agent | Tool observations, counters, teammate prose, and completion audit independently inferred success | MCP observations journal action, admission, dispatch, native effect and exact verification events; turn settlement consumes the reducer |
| Desktop computer loop | Planned `ActionCall`s and returned `ToolResult`s were a separate transport truth | Every outgoing action receives Assignment/run/generation/signature/target binding; every result journals against that attempt |
| deterministic/semantic fast paths | Bypassed General-Agent settlement and could complete without equivalent history | Alternative planning only; `/chat` journals their actions/results identically to delegated actions |
| generic `/revit/*` and typed MCP | Transport envelopes and tool wrappers reinterpreted dispatch and outcome | Both enter through the shared journal; native settlement is trusted only when all available bindings match |
| Dynamic Revit program | Supervisor receipt and benchmark verifier formed a separate completion lane | Provider receipt journals dispatch and effect through the same attempt; trusted completed apply is native-receipt authority and exact verification remains bound |
| native Revit execution | HTTP server, event queue, courier, action runner and handlers exposed scattered booleans | Host-owned `revit-operator.native-attempt-settlement.v1` classifies pre/post-dispatch failure, rollback, committed transaction, and certified receipts |
| Sidecar settlement | Caller report could create `complete_with_issues` or blocked truth | Report is untrusted evidence. A bound current-generation report can request terminal blocked only when canonical truth has neither unknown nor applied effect; completion requires canonical terminal truth |
| benchmark recovery/grading | Reconstructed action success from logs, response text, and transport receipts | Consumes the generic Assignment projection, fails closed on canonical unknown/open verification, and recovers verified mutation paths from canonical attempt receipts |

## Ownership after convergence

- Creation and durable ownership: Goal/Assignment service.
- Run and generation ownership: outer `/chat` or `/chat/stream` turn, or the
  explicitly bound external controller returned by the Goal API.
- Planning: Codex, deterministic, semantic, or Dynamic Runtime planner.
- Authorization/admission: existing backend and native policies, journaled on the
  attempt.
- Dispatch: MCP/desktop/native transport, journaled before settlement.
- Receipt creation: native host or Dynamic Runtime; callers may only report
  integrity evidence.
- Effect classification: canonical reducer from admitted authority events.
- Verification: exact Assignment/attempt/target/postcondition-bound readback.
- Terminal settlement: canonical turn/Sidecar settlement over the reducer.

## Reconciliation, retry, and verification

An `unknown` attempt admits only an exact-target read-only reconciliation. It
preserves the original attempt and evidence and resolves to `none`, `applied`,
or remains `unknown`; it never replays the mutation. A retry is admitted only
after authoritative `none` and records both the prior attempt and one material
delta: corrected schema/confirmation, new target evidence, changed plan,
recovered authorization, resolved host state, or reconciliation result. Blind
same-signature/same-target replay is rejected.

After `applied`, the phase becomes `verifying`. Verification must bind the exact
applied attempt and target fingerprint. Failure does not erase the applied
receipt. A no-op requires two distinct fresh target-bound observations.

## Progress and restart

Each turn fingerprints unresolved criteria, grounded targets, action signature,
observations, verified facts, plan, model state, tool family, and generation. A
turn must add a target, verified fact, materially changed plan, admitted/executed
action, observed state change, or terminal reason. Repeated identical no-progress
fingerprints permit one diagnosis, then one legitimate tool-family switch, then
terminate truthfully. This is the shared bound used instead of adding another
independent search counter.

On restart, the reducer replays the stored events to the same projection. Old
Goal records with no control-plane field safely project as an empty version-1
stream and enter the canonical model when their next run starts. Active unknown
or applied effects survive run supersession and continue to constrain the new
generation.

Admitted asynchronous tool execution is represented by a durable lease on the
canonical attempt. The projection is non-quiescent until native settlement,
receipt and EvidenceRef retention, and attempt settlement complete. Raw provider
receipts count against the resource budget but cannot independently terminalize
semantic stagnation. All terminal requests pass through the bounded,
event-driven settlement barrier. See [Asynchronous settlement barrier](ASYNC_SETTLEMENT_BARRIER.md).

## Canonical read completion

Settled read actions establish native facts; they do not by themselves prove
that the user's task was answered. A read-only Assignment completes through the
versioned `revit-operator.assignment-read-completion-claim/v1` handoff:

1. `operator_submit_read_completion` submits the exact Assignment, run,
   generation, criteria, action attempts, receipts, EvidenceRefs, and bounded
   deterministic result assertions.
2. The claim is durably journaled while its non-Revit tool lease is active.
3. At the next quiescent turn boundary, the canonical validator reopens the
   immutable evidence and evaluates the assertions. It checks current binding,
   authoritative read settlement, complete criteria coverage, requested result
   shape, evidence scope/trust, contradictions, and absence of apply/unknown
   effects.
4. Only an accepted claim permits terminal reason
   `authoritative_read_completed`. The normal terminal projection then
   synchronizes Goal lifecycle and persists the Work Packet.

Claim submission is not verification authority. Quiescence, discovery,
EvidenceRef expansion, provider receipts, and assistant prose cannot substitute
for the validator. A claim made before quiescence remains pending and may be
validated after the existing settlement barrier resolves; there is no polling
or grace delay.

## Dependency boundary

Production exposes generic Assignment, native settlement, and Dynamic Runtime
contracts. Benchmark code may consume them; production code may not import
benchmark case IDs, prompts, fixture IDs, oracles, or settlement rules.
`scripts/check_benchmark_runtime_boundary.ps1` enforces this direction in the
repository gate.
