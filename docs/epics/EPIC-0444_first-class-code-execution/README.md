# EPIC-0444: First-class Dynamic Revit code execution

This epic turns generated code from a one-shot graph generator into a bounded observe–reason–act–verify loop. It adopts the parts that make strong coding agents effective—persistent attempt state, precise diagnostics, inspectable artifacts, deterministic execution, small feedback cycles, and explicit evidence of progress—without giving untrusted code ambient machine or Revit authority. It remains development/laboratory-only and does not broaden production exposure or mutation authority.

## Execution loop

1. The trusted host supplies snapshot-bound observation pages and exact external-target facts.
2. The sandbox compiles the generated C# and records both the program hash and raw compiled-assembly hash.
3. Two isolated executions run concurrently over independent deep-cloned inputs. Their graph or fact-request, semantic trace, logs, and report must have one identical execution identity.
4. The program either:
   - returns `Complete()` with a graph whose nodes are covered exactly once by semantic trace steps; or
   - returns `NeedFacts(...)` with a bounded selector that does not repeat a supplied scope and explicitly grants no authority.
5. A completed graph proceeds through the existing rollback preview, fresh one-use authorization, apply, and readback chain. A needs-facts result stops before preview and before a write grant is required.
6. Every MCP invocation writes a non-authorizing, content-addressed iteration receipt beside its source, config, and supervisor evidence. A later invocation may bind itself to that exact parent as one of:
   - `facts`: preserve source and expand the observation selector to cover the exact prior fact request;
   - `repair`: change source after a retryable code/policy/assertion failure; or
   - `retry`: preserve source for a retryable transient failure.
7. The full ancestry is re-read through regular-file handles, checked for links and identity swaps, hash-verified back to one root, and capped at five attempts. Execution mode and program lane cannot change inside a chain.
8. A successful `apply` with an allowed `committed_verified` host receipt emits a separate task checkpoint. A checkpoint binds the exact source, graph, evidence bytes, apply receipt, document fingerprint/session, prior checkpoint, and restoration obligation. `continue_from_checkpoint` starts a fresh five-attempt diagnostic loop against that committed Revit state. This permits up to 64 cumulative designer-style steps without pretending that one transaction or rollback spans the whole task.
9. Checkpoint continuation is accepted only while the exact document session remains active. Restart/reopen recovery is deliberately not inferred from a matching title or model path; it requires a future explicit reconciliation protocol. Earlier committed steps survive a later failed step, and every checkpoint remains marked pending final acceptance or verified compensation/discard.

## Program-facing contract

Result-reference programs can use:

- `c.Fact(fact, fieldPath)` to bind a decision to an exact snapshot/revision/scope/fact identity;
- `c.TraceStep(stepId, purpose, operations, facts, dependsOn)` to map semantic steps to graph nodes and dependencies;
- `c.Require(assertionId, stepId, condition, message, kind, facts)` for structured, retryable diagnostics;
- `c.NeedFacts(requestId, reason, selector)` to request another bounded observation scope without guessing; and
- `c.Complete()` to emit a traced graph.

The agent tool returns one of `completed`, `needs_facts`, or `failed`. A `needs_facts` response includes the exact fact request, execution trace, compiled assembly identity, and execution identity. The caller should expand or replace its observation selector based on that request and submit a `facts` resume. It must never interpret the continuation or iteration receipt as apply authorization.

Failures return bounded structured diagnostics instead of an opaque stderr blob. Each diagnostic carries phase, severity, source start/end range, semantic step/assertion coordinates when available, retryability, and a constrained repair action such as `edit_source`, `remove_nondeterminism`, `reduce_scope_or_optimize`, or `revise_plan_or_request_facts`. The worker hashes the canonical diagnostic bundle; the MCP boundary recomputes that identity before returning it to the agent.

Each iteration also classifies progress as `completed`, `advanced_to_observation`, `diagnostics_reduced`, `no_progress`, or `regressed_or_changed`, with exact resolved and introduced diagnostic codes. This is evidence for the agent's next decision, not a claim that changed code is automatically better.

For result-reference programs, the MCP result derives a bounded step plan from the already validated trace: ordered dependency waves, per-step node/fact/assertion counts, parallel-wave presence, and critical dependency depth. Compile and execution timings are returned alongside verification identities. The agent can therefore focus its next inspection or repair on an exact semantic step instead of reparsing the entire program or receipt chain.

## Verification properties

- Exact protocol, SDK, primitive, package, supervisor, worker, and Revit-host identities are package-bound.
- Every cited fact is rebound by the worker and supervisor to exactly one supplied observation page.
- Step dependencies are backward-only; graph nodes cannot be omitted or bound twice on the strict agent lane.
- Assertion failures report exact step/assertion coordinates and are marked retryable.
- Nondeterministic programs fail before preview.
- Successful evidence must bind the worker-reported normalized source identity and execution status to the submitted invocation.
- Parent evidence bytes, iteration receipt, diagnostic bundle, and every ancestor receipt are independently rehashed before a resume is accepted.
- Committed task checkpoints form an independent, fully rehashed ancestry chain. A checkpoint is issued only from `committed_verified` apply evidence whose source, graph, document, and session agree with the worker and host receipts.
- The supervisor independently rejects a checkpoint when the current snapshot document fingerprint or session differs and echoes a non-authorizing checkpoint binding into evidence.
- `repair` cannot reuse unchanged source; `retry` cannot smuggle changed source; `facts` cannot omit a requested observation dimension.
- Result-reference observation and needs-facts phases do not require a mutation grant; completed apply still does.
- Revit 2023, 2024, 2025, and 2026 host artifacts are selected and verified through one trusted capability manifest.

## Deliberate limits and next performance work

The worker remains a fresh, zero-capability process per invocation. This maximizes isolation but repeats compilation across successive fact-gathering turns. A future compilation cache must be content-addressed by normalized source, compiler runtime, SDK/package identities, and policy identity; store only verified assembly bytes in an RX staged image; and rerun metadata admission before loading. It must not cache document observations, grants, admissions, or results.

The current deterministic replay passes run concurrently, so verification normally adds CPU rather than doubling wall-clock latency. Compilation and execution timings are emitted separately to support profiling and future cache acceptance tests.

The next high-value code-execution slices are:

1. A trusted content-addressed compilation cache keyed by normalized source, compiler/runtime, SDK/package, language options, and policy identity. Cached bytes must be immutable/RX, bounded and eviction-safe, rehashed on load, and metadata-readmitted before execution. No observations, grants, admissions, or results may be cached.
2. Typed postcondition descriptors emitted by generated programs and evaluated by the trusted Revit host after rollback preview and again after apply. Primitive readback remains authoritative; program postconditions add task-level invariants such as exact cardinality, topology, containment, and no-change sets.
3. Delta observation pages and trace compaction so later fact turns receive only newly authorized facts while retaining exact snapshot/scope provenance. This reduces tokens and serialization without weakening stale-state rejection.
4. A provider-neutral session coordinator that feeds the same iteration, diagnostic, and committed-checkpoint protocol back into OpenAI, Anthropic, and Gemini agent loops. It should choose inspect/repair/retry/continue/finalize based on verified receipts, compact older traces, and never treat model prose as mutation or restoration authority.
5. Continuous code-execution evals over the frozen redline-style corpus: compile repair, missing-fact recovery, transient stale-state retry, deterministic failure, preview mismatch, apply rollback, and verification-driven correction. Scoring must come from authenticated artifacts, never model self-report.
6. Explicit task finalization and recovery: accept final state, execute a separately previewed/authorized compensation graph, or prove discard of an evaluator-owned working copy. Cross-process restart reconciliation should bind a fresh trusted snapshot to the last checkpoint and return `outcome_uncertain` whenever equivalence cannot be proven.
