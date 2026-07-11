import test from "node:test";
import assert from "node:assert/strict";
import { resolveMepSemanticRoutePlan } from "../src/deterministic/mep_semantic_route.js";

test("semantic MEP planner requests read-only discovery for main-to-sink piping", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Extend that piping from the main to that sink.",
    view_id: 101,
    room_number: "405",
    level_name: "L4"
  });

  assert.equal(response.handled, true);
  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan?.kind, "pipe");
  assert.equal(response.plan?.operation, "branch_to_target");
  assert.equal(response.plan?.target_class, "sink");
  assert.equal(response.plan?.topology, "single_branch");
  assert.equal(response.plan?.size_policy, "inherit_from_main");
  assert.ok(response.plan?.assumptions.some((line) => /nearest compatible editable pipe main/i.test(line)));
  assert.ok(response.plan?.required_discovery.includes("visible_or_selected_target_with_location_and_connectors"));
  assert.ok(response.plan?.required_discovery.includes("nearest_compatible_editable_main_with_connectors"));
  assert.ok(response.next_actions.some((action) => action.path === "/revit/find-elements" && (action.body as Record<string, unknown>).category === "OST_PlumbingFixtures"));
  assert.ok(response.next_actions.some((action) => action.path === "/revit/find-elements" && (action.body as Record<string, unknown>).category === "OST_PipeCurves"));
  assert.equal(response.next_actions.some((action) => action.path.includes("create") || action.path.includes("connect-mep-branch")), false);
});

test("semantic MEP planner treats the repeated Room 405 extension request as constructive routing", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Assess extending domestic plumbing piping from an existing main to the sink in Room 405. Confirm required discovery before routing.",
    room_number: "405"
  });

  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan?.kind, "pipe");
  assert.equal(response.plan?.operation, "branch_to_target");
  assert.deepEqual(response.next_actions.map((action) => [action.path, (action.body as Record<string, unknown>).category]), [
    ["/revit/find-elements", "OST_PlumbingFixtures"],
    ["/revit/find-elements", "OST_PipeCurves"]
  ]);
});

test("semantic MEP planner treats the authoritative requestText noun extension as a branch", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Assess a potential piping extension from the main to the sink in Room 405. Identify the sink, main, connectors, and routing constraints that must be discovered before planning. Confirm Room 405 boundaries and level context. Do not modify the model or execute any next_actions.",
    room_number: "405"
  });

  assert.equal(response.plan?.operation, "branch_to_target");
  assert.deepEqual(response.next_actions.map((action) => [action.path, (action.body as Record<string, unknown>).category]), [
    ["/revit/find-elements", "OST_PlumbingFixtures"],
    ["/revit/find-elements", "OST_PipeCurves"]
  ]);
});

test("semantic MEP planner preserves explicit confirm-only connectivity as verification", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Confirm whether existing piping connectivity already reaches the sink in Room 405.",
    room_number: "405"
  });

  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan?.operation, "verify_existing");
});

test("semantic MEP planner turns resolved sink and main evidence into guarded branch dry-run", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Extend that piping from the main to that sink.",
    view_id: 101,
    tool_results: [
      {
        action_id: "semantic_mep_find_targets",
        method: "POST",
        path: "/revit/find-elements",
        status: "done",
        result_json: {
          elements: [
            {
              id: 2001,
              category: "OST_PlumbingFixtures",
              name: "Sink",
              point: { x: 14, y: 20, z: 0 }
            }
          ]
        }
      },
      {
        action_id: "semantic_mep_find_mains",
        method: "POST",
        path: "/revit/find-elements",
        status: "done",
        result_json: {
          elements: [
            {
              id: 3001,
              category: "OST_PipeCurves",
              name: "Domestic Cold Water Main",
              systemName: "Domestic Cold Water",
              projectedPoint: { x: 10, y: 20, z: 0 }
            }
          ]
        }
      }
    ]
  });

  assert.equal(response.status, "dry_run_ready");
  assert.equal(response.plan?.source.element_id, 3001);
  assert.equal(response.plan?.targets[0]?.element_id, 2001);
  assert.equal(response.plan?.evidence.has_target_point, true);
  assert.equal(response.plan?.evidence.has_projected_main_point, true);
  assert.equal(response.next_actions.length, 1);
  const dryRun = response.next_actions[0];
  assert.equal(dryRun?.path, "/revit/connect-mep-branch");
  assert.equal((dryRun?.body as Record<string, unknown>).kind, "pipe");
  assert.equal((dryRun?.body as Record<string, unknown>).mainElementId, 3001);
  assert.equal((dryRun?.body as Record<string, unknown>).dryRun, true);
  assert.equal((dryRun?.body as Record<string, unknown>).verify, true);
  assert.equal((dryRun?.body as Record<string, unknown>).visualVerify, false);
  assert.deepEqual((dryRun?.body as Record<string, unknown>).branchPoints, [
    { x: 10, y: 20, z: 0 },
    { x: 14, y: 20, z: 0 }
  ]);
});

test("semantic MEP planner handles low-pressure ductwork to diffusers as network discovery", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Route the low pressure ductwork to the diffusers in this area.",
    view_id: 202,
    room_number: "407"
  });

  assert.equal(response.status, "needs_discovery");
  assert.equal(response.plan?.kind, "duct");
  assert.equal(response.plan?.operation, "route_network_to_targets");
  assert.equal(response.plan?.target_class, "diffuser");
  assert.equal(response.plan?.topology, "trunk_with_branches");
  assert.equal(response.plan?.system.policy, "explicit_from_text");
  assert.equal(response.plan?.system.value, "low pressure");
  assert.ok(response.next_actions.some((action) => action.path === "/revit/find-elements" && (action.body as Record<string, unknown>).category === "OST_DuctTerminal"));
  assert.ok(response.next_actions.some((action) => action.path === "/revit/find-elements" && (action.body as Record<string, unknown>).category === "OST_DuctCurves"));
  assert.ok(response.next_actions.some((action) => action.path === "/revit/export-visible-elements"));
});

test("semantic MEP planner blocks ambiguous single-branch sink target evidence", () => {
  const response = resolveMepSemanticRoutePlan({
    user_text: "Extend piping from the main to that sink.",
    tool_results: [
      {
        action_id: "targets",
        method: "POST",
        path: "/revit/find-elements",
        status: "done",
        result_json: {
          elements: [
            { id: 1, category: "OST_PlumbingFixtures", name: "Sink", point: { x: 1, y: 1, z: 0 }, projectedPoint: { x: 0, y: 1, z: 0 } },
            { id: 2, category: "OST_PlumbingFixtures", name: "Sink", point: { x: 5, y: 5, z: 0 } },
            { id: 3, category: "OST_PipeCurves", name: "Pipe Main", projectedPoint: { x: 0, y: 1, z: 0 } }
          ]
        }
      }
    ]
  });

  assert.equal(response.status, "blocked");
  assert.match(response.blocker ?? "", /Multiple possible targets/);
  assert.equal(response.next_actions.some((action) => action.path === "/revit/connect-mep-branch"), false);
});
