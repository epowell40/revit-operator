# Asynchronous settlement barrier

Revit Operator treats admitted asynchronous work as canonical Assignment state,
not as an implementation detail of a provider turn. The durable Assignment
event stream records a lease on the canonical attempt before the app-server
awaits MCP or native execution.

## Ordering contract

For an executable `item/tool/call`, the required order is:

1. validate the current Assignment, run, and generation;
2. admit the exact tool request;
3. create the stable attempt and record its bounded lease;
4. record dispatch when the MCP client accepts the request;
5. await and normalize the result against that attempt;
6. attach native settlement and receipt truth;
7. retain the complete result as an `EvidenceRef`;
8. settle the attempt and resolve its lease; and
9. return the tool output to the model.

`item/completed` may enrich this history, but correlation by Assignment,
generation, app-server request, and tool-call identity makes it idempotent. It
must not create a second attempt.

## Quiescence

The control-plane projection exposes `in_flight_attempt_ids`,
`in_flight_count`, `next_in_flight_deadline`, `quiescent`, and
`settlement_barrier_reason`. Work remains in flight while its current-generation
attempt is admitted, dispatching, dispatched, retaining evidence, awaiting native
settlement, or awaiting a required transport outcome.

Provider-call accounting is an absolute resource budget. Provider receipts do
not independently advance or terminate the semantic stagnation watchdog.
Semantic progress is evaluated only at controlled checkpoints, and no diagnosis,
tool-family switch, or repeated-no-progress termination is consumed while the
Assignment is non-quiescent.

Every terminal request passes through the settlement barrier. A terminal event
is deferred with `assignment_settlement_deferred_in_flight`, the pending attempt
IDs, and the nearest existing deadline. Waiting is event-driven; the barrier
does not add a grace period or extend an operation deadline.

## Deadline, cancellation, and restart truth

- A read deadline settles persistent effect as `none`; a missing result remains
  a truthful task failure.
- A preview requires authoritative noncommit or rollback evidence.
- An apply that may have dispatched remains `unknown` and enters reconciliation;
  it is never replayed automatically.
- Cancellation before dispatch settles `none`. Cancellation does not erase an
  already-dispatched read or possible mutation.
- Provider timeout interrupts inference but drains the independently bounded
  tool lease to its original deadline.
- Restart reconstructs active leases from the Assignment stream and looks up the
  durable courier job by its captured correlation data. Recovery attaches a
  retained completion to the original attempt and never replays execution.

A result after its model turn but within the lease deadline settles normally. A
result after authoritative terminal settlement is retained as a linked
late-receipt incident, quarantined, and cannot reopen the Assignment or rewrite
its immutable Work Packet.

## Settlement and publication

A tool result is settled only after canonical effect truth, receipt retention,
and required EvidenceRefs are attached. Evidence-retention failure preserves the
native receipt and is recorded separately. Accepted terminal truth synchronizes
the Goal lifecycle status and `finished_at` before Work Packet persistence.

Protocol V2 will not finalize a case with bound in-flight work. After the
existing deadline it publishes an immutable, non-promotable failure artifact
that distinguishes still-in-flight, timed-out, missing, collection-failed, and
quarantined receipt conditions.
