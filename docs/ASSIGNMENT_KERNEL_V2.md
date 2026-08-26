# Assignment Kernel V2

Status: architecture contract; execution feature flag defaults off.

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

## Target flow

```text
trusted host -> AssignmentSpecV2 -> AssignmentEventV2 journal
planner -> admitted OperationV2(operation_id) -> transport edge
native edge -> OperationResultV2(operation_id) -> retained raw bytes
observation edge -> ObservationV2 semantic facts -> criterion events
pure reducer -> AssignmentSnapshotV2 -> read-only API/UI/audit projections
```

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
