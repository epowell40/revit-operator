import assert from "node:assert/strict";
import test from "node:test";
import {
  executeWorkbenchActions,
  type WorkbenchAction
} from "../src/workbench/workbench_runner.js";

test("safe workbench registers one connector-snapped route", { concurrency: false }, async () => {
  const previousAuth = process.env.OPERATOR_AUTH_MODE;
  const previousEnabled = process.env.OPERATOR_WORKBENCH_ENABLED;
  process.env.OPERATOR_AUTH_MODE = "clashpilot_jwt";
  delete process.env.OPERATOR_WORKBENCH_ENABLED;
  try {
    let received: WorkbenchAction | null = null;
    const action: WorkbenchAction = {
      type: "register_existing_conditions_route_snap",
      candidate_json: JSON.stringify({ schema_version: 1, primitive_id: "route-1" }),
      connector_tool_action_id: "connectors-1"
    };
    const out = await executeWorkbenchActions([action], {
      registerExistingConditionsRouteSnap: async value => {
        received = value;
        return { status: "registered_for_staged_dry_run" };
      }
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.ok, true);
    assert.equal(out[0]?.type, "register_existing_conditions_route_snap");
    assert.equal(received, action);
    assert.equal((out[0]?.details as any)?.status, "registered_for_staged_dry_run");
  } finally {
    if (previousAuth === undefined) delete process.env.OPERATOR_AUTH_MODE;
    else process.env.OPERATOR_AUTH_MODE = previousAuth;
    if (previousEnabled === undefined) delete process.env.OPERATOR_WORKBENCH_ENABLED;
    else process.env.OPERATOR_WORKBENCH_ENABLED = previousEnabled;
  }
});

test("safe workbench discovers a native frontier before registering one route", { concurrency: false }, async () => {
  const previousAuth = process.env.OPERATOR_AUTH_MODE;
  const previousEnabled = process.env.OPERATOR_WORKBENCH_ENABLED;
  process.env.OPERATOR_AUTH_MODE = "clashpilot_jwt";
  delete process.env.OPERATOR_WORKBENCH_ENABLED;
  try {
    let received: WorkbenchAction | null = null;
    const action: WorkbenchAction = {
      type: "register_existing_conditions_route_frontier",
      candidate_json: JSON.stringify({ schema_version: 1, primitive_id: "route-2" }),
      connector_tool_action_id: "frontier-connectors-1"
    };
    const out = await executeWorkbenchActions([action], {
      registerExistingConditionsRouteFrontier: async value => {
        received = value;
        return { status: "frontier_resolved_and_registered_for_staged_dry_run" };
      }
    });
    assert.equal(out.length, 1);
    assert.equal(out[0]?.ok, true);
    assert.equal(out[0]?.type, "register_existing_conditions_route_frontier");
    assert.equal(received, action);
    assert.equal((out[0]?.details as any)?.status, "frontier_resolved_and_registered_for_staged_dry_run");
  } finally {
    if (previousAuth === undefined) delete process.env.OPERATOR_AUTH_MODE;
    else process.env.OPERATOR_AUTH_MODE = previousAuth;
    if (previousEnabled === undefined) delete process.env.OPERATOR_WORKBENCH_ENABLED;
    else process.env.OPERATOR_WORKBENCH_ENABLED = previousEnabled;
  }
});
