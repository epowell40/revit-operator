# EPIC-0458 Observation Commit and Publication Design

## Bounded design

The implementation uses a recoverable two-stage commit. The durable Assignment
journal remains the transaction boundary and preserves these ordered facts:

1. `operation_result_recorded` retains the exact `OperationResultV2` and the
   screened Observation commit input in one idempotent journal append.
2. The operation enters `retaining_observation`.
3. Evidence persistence, normalized digest validation, and Observation creation
   are retried against that same durable result and payload.
4. `observation_retained` atomically adds the Observation and settles the
   operation.

The commit input is bound to the immutable result ID. Duplicate delivery of the
same event is idempotent; the same result ID with changed result or payload
content is an event-integrity conflict.

## Recovery and failure

Recovery branches on `retaining_observation` before operation deadlines or
transport recovery. That branch can only persist evidence, validate the shared
payload digest, create the Observation, and append the Observation event. It
cannot invoke Revit or admit another operation.

Retry failures append `observation_commit_retry_recorded` while the operation
remains in `retaining_observation`, so blocking children continue to block their
parents and the progress controller returns `await_operation`. After the bounded
attempt limit, `observation_commit_failed` preserves the successful native
result, derives a specific blocker, and terminalizes the Assignment truthfully.
The historical `observation_retention_failed` reducer behavior is retained only
for immutable Candidate 2 journal replay and is no longer emitted.

## Canonical publication

The V2 session index lists lightweight Assignment identities and versions from
the V2 store. Consumers follow each identity through the exact
`GET /api/assignments/v2/:assignment_id` publication, which contains the
canonical snapshot and provider ledger.

The benchmark runner collects that exact publication. Protocol V2 refuses a V1
fallback when an indexed V2 Assignment lacks its exact publication and reports
`v2_publication_missing`. The legacy Assignment list excludes V2 Goals before
running the V1 projector, preventing malformed or historical V2 journals from
causing an HTTP failure. Terminal Work Packet and Work Return generation receive
the same canonical snapshot instance and version used at terminal publication.
