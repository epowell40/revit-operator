type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

/** Surface delegated native calls in benchmark traces when the outer computer run has no rounds. */
export function extractGeneralRevitToolCalls(attempt: Row): Row[] {
  const outer: Row[] = [];
  for (const round of Array.isArray(attempt.rounds) ? attempt.rounds : []) {
    for (const action of Array.isArray(row(round).actions) ? row(round).actions as unknown[] : []) {
      outer.push(row(action));
    }
  }
  if (outer.length > 0) return outer;

  const projected: Row[] = [];
  const seen = new Set<string>();
  const kernel = row(attempt.assignment_kernel_v2);
  for (const assignment of Array.isArray(kernel.assignments) ? kernel.assignments : []) {
    const operations = row(row(assignment).snapshot).operations;
    for (const operation of Object.values(row(operations))) {
      const op = row(operation), input = row(op.input), result = row(op.result);
      const id = typeof op.operation_id === 'string' ? op.operation_id : '';
      const method = typeof input.method === 'string' ? input.method : '';
      const path = typeof input.path === 'string' ? input.path : '';
      if (!id || seen.has(id) || !['GET', 'POST'].includes(method) || !path.startsWith('/')) continue;
      seen.add(id);
      projected.push({
        action_id: id, method, path,
        request_effect: op.requested_effect ?? null,
        request_dispatched: result.dispatch_state === 'dispatched',
        status: result.status === 'succeeded' ? 'success' : 'failed',
        ...(input.body === undefined ? {} : { arguments: input.body }),
        source: 'durable_assignment_kernel_v2',
        ...(typeof result.native_transaction_state === 'string' ? { native_transaction_state: result.native_transaction_state } : {}),
        ...(typeof result.error_code === 'string' ? { error_code: result.error_code } : {}),
      });
    }
  }
  return projected;
}

export function dynamicReceiptActions(state: Row): Row[] {
  const receipts = Array.isArray(state.dynamicProgramReceipts) ? state.dynamicProgramReceipts.map(row) : [];
  return receipts.map((receipt, index) => {
    const mode = String(receipt.requested_mode || "preview").toLowerCase() === "apply" ? "apply" : "preview";
    return {
      action_id: String(receipt.run_id || `dynamic-${index + 1}`),
      method: "POST",
      path: `/revit/dynamic-runtime/${mode}`,
      request_effect: mode,
      request_dispatched: receipt.execution_ok === true,
      status: receipt.execution_ok === true ? "success" : "failed",
      receipt
    };
  });
}

export function sidecarFunctionReceiptActions(state: Row): Row[] {
  const receipts = Array.isArray(state.functionToolReceipts) ? state.functionToolReceipts.map(row) : [];
  return receipts.map((receipt, index) => ({
    action_id: String(receipt.call_id || `function-${index + 1}`),
    method: "POST",
    path: String(receipt.path || ""),
    request_effect: String(receipt.request_effect || "read"),
    request_dispatched: receipt.request_dispatched === true,
    status: String(receipt.status || "failed"),
    receipt
  }));
}

