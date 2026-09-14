# Generated Revit code: comparison and qualification

Reviewed 2026-09-13 against [Demolinator/revit-mcp-server at 40af5a7](https://github.com/Demolinator/revit-mcp-server/tree/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6), specifically [the execution handler](https://github.com/Demolinator/revit-mcp-server/blob/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6/revit_mcp/code_execution.py) and [the MCP definition](https://github.com/Demolinator/revit-mcp-server/blob/40af5a7860b4470ad8f80ea327cf4a9cd31ca0a6/tools/code_execution_tools.py). Its MIT license permits reuse with the copyright and permission notice. This review copies no implementation code.

## What the comparison establishes

| Boundary | Upstream execution handler | Operator's current generated-code path |
| --- | --- | --- |
| Language and API reach | IronPython 2.7, `doc`, `DB`, pyRevit and CLR inside Revit | C# 12 compiled outside Revit; loops, LINQ, calculations, assertions and supported SDK operations |
| Full Revit API | Direct access; can reach API functionality absent from named tools | Direct `Autodesk.Revit` references forbidden; the trusted host implements a finite operation vocabulary |
| Transactions | One transaction around the submitted program; rollback on caught exception | Host-owned rollback preview, fresh authorization, commit/readback and evidence-bound continuation |
| Execution feedback | Printed output, partial output, exception type, traceback and repair hints | Bounded logs/reports, compile ranges, structured diagnostic phase/action, step/assertion/fact traces; runtime exception source traces and partial logs remain a gap |
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

Prioritize useful feedback next: retain bounded partial reports on program failure, map runtime exceptions to generated source, and expose an exact installed SDK reference with working examples. These reduce correction turns without broadening write authority. Keep long tasks in verified steps: a 30-second worker computation and a short Revit transaction can participate in an hours-long assignment; an hours-long UI-thread transaction prevents normal Revit work.

## Acceptance cases

1. A valid program with comments, ordinary strings, raw strings and interpolation text mentioning prohibited APIs executes; an actual forbidden call inside interpolation still fails.
2. Aliased/escaped forbidden symbols, P/Invoke, reflection and process/network/file operations remain rejected. Loops, LINQ and deterministic engineering calculations remain usable.
3. Compile errors report source ranges; corrected source produces a different source identity and preserves the earlier failure receipt.
4. Preview leaves the disposable model unchanged; apply produces committed native readback. A later failure does not silently commit an earlier partial batch.
5. Lost replies, user cancellation and restart reconcile the prior effect before resubmission. A verified checkpoint advances to a new step without replaying the prior write.
6. Missing facts produce an explicit fact request; stale or foreign document/session/target evidence fails before mutation.

Deterministic checks and native Revit qualification are separate results. The team pilot should record both, plus user review time and rework.
