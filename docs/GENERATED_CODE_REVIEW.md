# Generated Revit code: comparison and qualification

Reviewed 2026-09-13 against [Demolinator/revit-mcp-server at 40af5a7](https://github.com/Demolinator/revit-mcp-server/tree/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6), specifically [the execution handler](https://github.com/Demolinator/revit-mcp-server/blob/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6/revit_mcp/code_execution.py) and [the MCP definition](https://github.com/Demolinator/revit-mcp-server/blob/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6/tools/code_execution_tools.py). Its MIT license permits reuse with the copyright and permission notice. This review copies no implementation code.

## What the comparison establishes

| Boundary | Upstream execution handler | Operator's current generated-code path |
| --- | --- | --- |
| Language and API reach | IronPython 2.7, `doc`, `DB`, pyRevit and CLR inside Revit | C# 12 compiled outside Revit; loops, LINQ, calculations, assertions and supported SDK operations |
| Full Revit API | Direct access; can reach API functionality absent from named tools | Direct `Autodesk.Revit` references forbidden; the trusted host implements a finite operation vocabulary |
| Transactions | One transaction around the submitted program; rollback on caught exception | Host-owned rollback preview, fresh authorization, commit/readback and evidence-bound continuation |
| Execution feedback | Printed output, partial output, exception type, traceback and repair hints | Bounded logs/reports, compile ranges, structured diagnostic phase/action, step/assertion/fact traces; exception source lines and retained partial logs; source-repair controller handoff remains under qualification |
| Runtime limits | No source/output/runtime limit visible in this handler | Bounded source, worker CPU/memory, observations, operations and outputs; supervisor owns worker termination |
| Interruption and retries | No durable reconciliation visible in these two files | Durable assignment effects, five evidence-bound repair/fact attempts, separate verified checkpoints for up to 64 steps |
| Machine access | Code executes with the Revit process's access | Worker has no network or arbitrary filesystem/process access; trusted file capabilities are separate |

The upstream handler calls `Transaction.Commit()` without inspecting its returned status. A returned success message therefore should not be treated as independent proof of a committed model change. This is a source-level observation about the pinned handler, not a live test of that project.

Operator is **not unrestricted arbitrary Revit API execution**. Its sandbox is useful for containing generated algorithms, but an SDK contract in the tree does not prove that a particular installed host exposes it. Use capability discovery, the exact installed runtime package and fresh native receipts to establish availability. Main add-in compatibility spans 2023–2027; each generated-code host needs its own qualification.

## Changes and remaining opportunities

The EPIC-0462 audit reproduced rejection of a valid report string containing `System.IO` and `dynamic`. Admission now compares executable token sequences, allowing prose and ordinary identifiers while reporting exact ranges for prohibited syntax. Semantic symbol checks, metadata checks and operating-system isolation remain in place; a text denylist is not the security boundary. Runtime diagnostics now preserve exception types and deduplicate the two replay tasks' root causes.

The MCP launcher now locates the installed add-in's bundled supervisor and worker for the selected Revit year on Windows, using the existing workspace token file. Explicit paired runtime paths remain supported. Missing packages, incomplete overrides and unavailable years fail before dispatch. This discovery does not replace native package authentication or make a remote Linux MCP process able to execute a Windows runtime. The model-facing result-reference interface name is corrected to the actual SDK type.

The largest capability opportunity is Revit API breadth. Extend trusted operations for concrete team tasks that fail the pilot, with native transactions, target scope, rollback and readback. Do not advertise unimplemented graph operations, turn off admission to make a demo pass, or place raw code in Revit's UI thread without an explicit runtime design. A hung arbitrary in-process API call cannot be safely killed like the isolated worker.

Current result-reference execution also selects one activated primitive family per graph. A combined MEP-and-annotation job needs separate verified steps; it is not one atomic cross-domain program. Qualify the handoff and final completeness of such jobs before treating that composition as dependable team automation.

The installed UI pilot exposed an integration gap before the first generated program ran: the model could not discover the basic SDK and spent its task budget searching for it. The tool now includes the actual DTO contract and a working bounded duct report. Explicit `read` mode binds the open document before computation and rejects any generated model operation before preview or apply. Reports cross the same canonical task/evidence boundary as other tools and can be selected directly for user-facing delivery. Read mode currently uses the basic snapshot SDK, not result-reference mutation graphs.

Compilation success and native completion are separate outcomes. Host rejection retains diagnostic evidence even after successful compilation. A missing apply completion remains unknown; timeout wording cannot make the program automatically retryable. Failed compilation and a rejected read-only graph retain their evidence-bound source-repair path. These boundaries have deterministic tests; installed UI qualification is recorded separately.

Failed-program feedback now leads with the native failure, bounded compiler diagnostics and source positions, while the full original snapshot, receipts and payload digest remain in retained evidence. Code-mode discovery explains how to display already rendered tool output and why Revit may report dependent affected elements for a single direct edit. Input schema validation happens before admitting a potentially mutating operation, so a rejected argument can be corrected without creating a fictitious unknown effect. Errors after dispatch remain subject to reconciliation.

Basic generated parameter edits have a dedicated postcondition adapter. It binds the admitted source to the retained executed graph, native committed receipt, document/session and authoritative observation hash, then requires a separate native parameter read matching every direct target and value. Program reports cannot establish completion. Missing operations, mixed graph kinds and repeated writes to the same parameter fail closed; broader MEP, annotation and movement graphs need reviewed verification adapters and live qualification. This is not a claim that all generated graph types complete through the user-facing assignment lifecycle.

Generated runtime failures now retain bounded partial logs/reports as informational diagnostics, including an explicit diagnostic-only authority, replay index and omission counts. They never expose a partial executable graph or successful report. Embedded debug symbols map exceptions to generated source lines and survive compiled-code reuse; host stack paths are not exposed. The diagnostic bundle binds the retained text, and removing informational logs does not count as repair progress. This batch passed focused worker and MCP tests plus a standalone worker replay; installed Revit 2024 testing exposed the expected partial log and line 9/column 9. The corrected source then hit a separate controller fact-class mismatch and did not deliver a successful repair through the UI; that handoff remains under qualification. Keep long tasks in verified steps: a 30-second worker computation and a short Revit transaction can participate in an hours-long assignment; an hours-long UI-thread transaction prevents normal Revit work. The assignment default permits 32 provider calls, 128 operations, 30 minutes and four million raw tokens, including cached input. Identical-operation and no-progress stops remain in force; explicit smaller budgets still win. This is a bounded task budget, not a claim of unattended multi-hour qualification.

## Acceptance cases

1. A valid program with comments, ordinary strings, raw strings and interpolation text mentioning prohibited APIs executes; an actual forbidden call inside interpolation still fails.
2. Aliased/escaped forbidden symbols, P/Invoke, reflection and process/network/file operations remain rejected. Loops, LINQ and deterministic engineering calculations remain usable.
3. Compile errors report source ranges; corrected source produces a different source identity and preserves the earlier failure receipt.
4. Preview leaves the disposable model unchanged; apply produces committed native readback. A later failure does not silently commit an earlier partial batch.
5. Lost replies, user cancellation and restart reconcile the prior effect before resubmission. A verified checkpoint advances to a new step without replaying the prior write.
6. Missing facts produce an explicit fact request; stale or foreign document/session/target evidence fails before mutation.

Deterministic checks and native Revit qualification are separate results. The team pilot should record both, plus user review time and rework.

## Installed qualification on 2026-09-14

Public runtime revision `71e4a92c346a23f2da6c5320eb105af4b8aba545` passed the natural C# preview and apply cases in Operator on Revit 2024.3 with Sol / Medium. The preview compiled a real parameter operation and rolled it back; a separate paged read of all 1,053 duct Comments found no changes. The apply test first submitted excessive worker/transaction deadlines, received validation errors before admission, corrected them, and committed one direct Comments edit. A fresh native parameter read supplied `verification.postcondition_satisfied`; the assignment and UI both completed. Independent comparison found exactly one changed Comment and 1,052 unchanged, with the new value also visible in Revit Properties.

Earlier installed candidates passed the bounded report, deliberate compiler-error repair and exact repair lineage. Their first failures are retained rather than replaced by the final passing replay. Current deterministic qualification includes both 127-family release frontiers and full changed backend suites; the unchanged full MCP, Dynamic Runtime and Revit compatibility results are recorded separately. These checks are not a penetration test, unrestricted Revit API qualification, or proof of multi-hour unattended reliability.

A later installed UI test retained the requested runtime log and exception source line and repaired the same program successfully in read mode. Its final answer nevertheless omitted the original diagnostics because the answer-delivery layer accepted only successful observations. The current implementation allows hash-verified failed read diagnostics to be presented with explicit failure labels, while keeping them ineligible as proof of task success. Controller and HTTP tests cover delivery of both runs; the corrected installed answer still requires qualification.
