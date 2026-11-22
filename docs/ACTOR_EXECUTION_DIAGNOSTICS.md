# Actor execution diagnostics

The unified desktop actor can inspect its own current-run function calls with inspect_execution. This is available beside its existing computer tool, native Revit tools, generated C# execution, read_executed_code, operator_retrieve_evidence and review_current_work.

Use the index for a specific failed call or confusing result. It returns up to eight recent bound receipts, exact call IDs, errors, compiler diagnostics, native outcome references and pagination. A call_id request includes available review findings and capture/reference identities. Retrieve the retained evidence for a missing value, read the executed source when applicable, correct the request through the existing tools, and reconcile uncertain effects before retrying writes.

The index does not execute code, change the model or verify a result. It covers only retained current-run function receipts; absence is not proof that earlier work did not happen. It neither exposes arbitrary log paths nor grants access to another task. Stop/Pause and task-binding checks apply. Image metadata is historical; fresh inspection or image retrieval is required to see actual pixels.

Diagnostics are stored normally and delivered through a bounded model-facing output, preserving the error instead of replacing it with a generic evidence summary. Compiler diagnostics preceding a native transaction do not become transaction attestations.

report_work_for_review has explicit non-strict function schema handling because needs_input is optional. Omit it when no decision is missing. An advisory result can be returned for review without manufacturing a clarification request. Strict native verification and unknown-effect rules are unchanged. OpenAI's supported optional-field behavior is documented at https://developers.openai.com/api/docs/guides/function-calling#strict-mode .

Local testing covers ownership, foreign/stale runs, Pause, bounded output delivery, pagination, compiler-error recovery, and reporting with and without a real user question. Installed qualification is separate from a release or a claim of general autonomous recovery.
