import assert from "node:assert/strict";
import test from "node:test";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { __testOnlyClearScheduleReadStates, maybeRunDeterministicScheduleRead } from "../src/deterministic/schedule_read_runtime.js";

function request(user_text: string, tool_results?: ChatRequest["tool_results"]): ChatRequest {
  return { version: OPERATOR_BACKEND_CONTRACT_VERSION, session_id: "schedule-read", message_id: crypto.randomUUID(), user_text, tool_results };
}

test("explicit schedule id read bypasses generic exact-element lookup with safe native limits", () => {
  const result = maybeRunDeterministicScheduleRead(request("Read-only inspection only: inspect Revit schedule with element/view id 2284420. Return every displayed column heading and the exact body-row count."));
  assert.deepEqual(result?.actions, [{ action_id: "schedule-read-detail", method: "POST", path: "/revit/schedules", body: { action: "detail", scheduleId: 2284420, exact: false, includeFields: true, includeData: true, maxRows: 500, maxColumns: 100 } }]);
  assert.doesNotMatch(JSON.stringify(result), /find-elements-by-parameter/);
});

test("Sidecar delegate expansion retains exact schedule routing", () => {
  const result = maybeRunDeterministicScheduleRead(request("Read-only inspection: inspect Revit schedule with explicit element/view id 2284420. Return the exact ordered column headings."));
  assert.equal((result?.actions[0]?.body as any)?.scheduleId, 2284420);
});

test("teammate row-value question reads the exact named schedule instead of listing schedules", () => {
  __testOnlyClearScheduleReadStates();
  const result = maybeRunDeterministicScheduleRead(request("What is Space 101 named in the Space Schedule? Do not change anything."));
  assert.deepEqual(result?.actions, [{
    action_id: "schedule-read-detail",
    method: "POST",
    path: "/revit/schedules",
    body: { action: "detail", query: "Space Schedule", exact: true, requireUniqueQuery: true, includeFields: true, includeData: true, maxRows: 500, maxColumns: 100 }
  }]);
});

test("teammate row-value question reports the unique displayed value", () => {
  __testOnlyClearScheduleReadStates();
  maybeRunDeterministicScheduleRead(request("What is Space 101 named in the Space Schedule? Do not change anything."));
  const result = maybeRunDeterministicScheduleRead(request("", [{
    action_id: "schedule-read-detail", method: "POST", path: "/revit/schedules", status: "done",
    result_json: {
      schedule: { id: 1422218, name: "Space Schedule" },
      fields: [{ heading: "Number" }, { heading: "Name" }, { heading: "Area" }, { heading: "Level" }],
      table: { body: { totalRows: 12, returnedRows: 12, hasMoreRows: false, rows: [
        { cells: ["Number", "Name", "Area", "Level"] },
        { cells: ["101", "Cafe", "643 SF", "L1 - Block 35"] },
        ...Array.from({ length: 10 }, () => ({ cells: ["", "", "", ""] }))
      ] } }
    }
  }]));
  assert.equal(result?.assistant_message, "Space 101 — Name: `Cafe` in `Space Schedule`. No model changes were made.");
  assert.equal(result?.aec_query_receipt?.status, "complete");
});

test("authoritative Sidecar wording wins over a broadened schedule-list paraphrase", () => {
  __testOnlyClearScheduleReadStates();
  const req = request("Read-only: list the schedules in the open model.");
  req.context = { ui: { authoritative_user_text: "What is Space 101 named in the Space Schedule? Do not change anything." } };
  const result = maybeRunDeterministicScheduleRead(req);
  assert.equal((result?.actions[0]?.body as any)?.query, "Space Schedule");
  assert.equal((result?.actions[0]?.body as any)?.action, "detail");
});

test("schedule read reports native body total, nonblank data count, headings, and designation samples", () => {
  __testOnlyClearScheduleReadStates();
  const result = maybeRunDeterministicScheduleRead(request("", [{
    action_id: "schedule-read-detail", method: "POST", path: "/revit/schedules", status: "done",
    result_json: {
      schedule: { id: 2284420, name: "Mechanical Equipment" },
      fields: [{ heading: "DESIG." }, { heading: "Description" }],
      table: { body: { totalRows: 5, returnedRows: 5, hasMoreRows: false, rows: [
        { cells: ["DESIG.", "Description"] },
        { cells: ["", ""] },
        { cells: ["<varies>", "Pump"] },
        { cells: ["B2-G-ET-02", "EXPANSION TANK"] },
        { cells: ["B2-G-ET-01", "EXPANSION TANK"] }
      ] } }
    }
  }]));
  assert.match(result?.assistant_message ?? "", /Body totalRows: \*\*5\*\*/);
  assert.match(result?.assistant_message ?? "", /Nonblank data rows: \*\*3\*\*/);
  assert.match(result?.assistant_message ?? "", /`DESIG\.`, `Description`/);
  assert.match(result?.assistant_message ?? "", /`<varies>`, `B2-G-ET-02`/);
  assert.equal(result?.aec_query_receipt?.workflow_id, "query.schedule_detail");
});

test("schedule mutations remain available to the guarded write runtimes", () => {
  assert.equal(maybeRunDeterministicScheduleRead(request("Update schedule id 2284420 and change AHU-1 supply air to 20,000.")), null);
});

test("failed exact schedule read stops without broadening", () => {
  __testOnlyClearScheduleReadStates();
  const result = maybeRunDeterministicScheduleRead(request("", [{ action_id: "schedule-read-detail", method: "POST", path: "/revit/schedules", status: "failed", error: "schedule not found" }]));
  assert.equal(result?.actions.length, 0);
  assert.match(result?.assistant_message ?? "", /schedule not found/);
  assert.equal(result?.aec_query_receipt?.status, "failed");
});
