import test from "node:test";
import assert from "node:assert/strict";
import type { AssignmentSnapshotV2 } from "../src/domain/assignment-kernel/index.js";
import { appliedModelWriteIdsFromOperations } from "../src/verification/model_redline_guard.js";

const operation = (overrides: Record<string, unknown> = {}) => ({
  requested_effect: "apply", persistent_effect: "applied",
  request_identity: { method: "POST", path: "/revit/mep-route-workflow" },
  result: { status: "succeeded", native_transaction_state: "committed",
    affected_target_identities: ["element_id:1543117", "element_id:1543120", "element_id:1543126"] },
  ...overrides
});

const operations = (...rows: ReturnType<typeof operation>[]) => Object.fromEntries(
  rows.map((row, index) => [`operation-${index}`, row])
) as unknown as AssignmentSnapshotV2["operations"];

test("a committed V2 MEP route remains model-write evidence on a later chat turn", () => {
  assert.deepEqual(appliedModelWriteIdsFromOperations(operations(operation())),
    ["element_id:1543117", "element_id:1543120", "element_id:1543126"]);
});

test("V2 dry runs, uncommitted results, non-model writes, and empty targets give no model-write evidence", () => {
  assert.deepEqual(appliedModelWriteIdsFromOperations(operations(
    operation({ requested_effect: "preview", persistent_effect: "none" }),
    operation({ result: { status: "succeeded", native_transaction_state: "rolled_back",
      affected_target_identities: ["element_id:1543117"] } }),
    operation({ request_identity: { method: "POST", path: "/revit/create-text" } }),
    operation({ result: { status: "succeeded", native_transaction_state: "committed",
      affected_target_identities: [] } })
  )), []);
});
