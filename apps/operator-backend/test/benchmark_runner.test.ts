import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { getConfigById, loadBenchmarkConfigBundle } from "../src/benchmark/config.js";
import { assertRunnableRevitWorkflowOverride, findBenchmarkOverridePlaceholders } from "../src/benchmark/environment.js";
import { runSingleBenchmark } from "../src/benchmark/runner.js";
import { getTaskById, loadBenchmarkTasks } from "../src/benchmark/tasks.js";
import type { BenchmarkModelClient, BenchmarkModelRequest, BenchmarkModelResponse } from "../src/benchmark/types.js";

class FakeModelClient implements BenchmarkModelClient {
  private readonly responses: string[];
  private index = 0;

  constructor(responses: string[]) {
    this.responses = responses;
  }

  async createResponse(request: BenchmarkModelRequest): Promise<BenchmarkModelResponse> {
    const output = this.responses[this.index++];
    assert.ok(output, `No fake response available for ${request.model}`);
    return {
      model: request.model,
      output_text: output,
      raw_response: {
        id: `fake-${this.index}`,
        output_text: output,
        usage: { input_tokens: 120, output_tokens: 60, total_tokens: 180 }
      },
      usage: {
        input_tokens: 120,
        output_tokens: 60,
        total_tokens: 180,
        source: "api"
      },
      response_id: `fake-${this.index}`
    };
  }
}

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "benchmark-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test("split planner/executor benchmark run writes artifacts and aggregates metrics", async () => {
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "split_54_medium__54mini_low");
  const task = getTaskById("placeholder_open_settings_panel", tasks);
  const fakeClient = new FakeModelClient([
    JSON.stringify({
      objective: task.description,
      preconditions: task.setup_instructions,
      ordered_subgoals: [
        { id: "open_profile", title: "Open the profile menu", success_signal: "profile menu is open" },
        { id: "open_settings", title: "Open settings", success_signal: "settings panel is open" },
        { id: "open_notifications", title: "Open notifications", success_signal: "notifications are visible" }
      ],
      expected_visible_state_changes: task.success_criteria,
      escalation_rules: task.failure_criteria,
      done_criteria: task.success_criteria
    }),
    JSON.stringify({
      current_subgoal: "Open the profile menu",
      current_subgoal_id: "open_profile",
      chosen_action: "click",
      target: "profile",
      brief_reason: "Need the menu to reach settings.",
      expected_result: "Profile menu opens.",
      expected_state: "The profile menu is open.",
      confidence: 0.9,
      recommend_escalation: false,
      done: false,
      subgoal_completed: true
    }),
    JSON.stringify({
      current_subgoal: "Open settings",
      current_subgoal_id: "open_settings",
      chosen_action: "click",
      target: "settings",
      brief_reason: "Next planned destination.",
      expected_result: "Settings panel opens.",
      expected_state: "The settings panel is open.",
      confidence: 0.88,
      recommend_escalation: false,
      done: false,
      subgoal_completed: true
    }),
    JSON.stringify({
      current_subgoal: "Open notifications",
      current_subgoal_id: "open_notifications",
      chosen_action: "click",
      target: "notifications",
      brief_reason: "Need the target section visible.",
      expected_result: "Notifications settings are visible.",
      expected_state: "Notifications settings are visible.",
      confidence: 0.92,
      recommend_escalation: false,
      done: true,
      subgoal_completed: true
    })
  ]);

  const batchDir = tempDir("runner");
  const run = await runSingleBenchmark(
    task,
    config,
    {
      batch_id: "test_batch",
      batch_dir: batchDir,
      repeat_index: 1
    },
    fakeClient
  );

  assert.equal(run.success_label, "success");
  assert.equal(run.total_planner_calls, 1);
  assert.equal(run.total_executor_calls, 3);
  assert.equal(run.total_escalations, 0);
  assert.ok(fs.existsSync(run.steps_artifact_path));
  assert.ok(fs.existsSync(run.summary_artifact_path));
});

test("deterministic Revit workflow benchmark run uses no model calls", async () => {
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_receptacles", tasks);
  const fakeClient = new FakeModelClient([]);

  const batchDir = tempDir("deterministic-revit-workflow");
  const run = await runSingleBenchmark(
    task,
    config,
    {
      batch_id: "test_batch",
      batch_dir: batchDir,
      repeat_index: 1
    },
    fakeClient
  );

  assert.equal(run.success_label, "success");
  assert.equal(run.total_planner_calls, 0);
  assert.equal(run.total_executor_calls, 0);
  assert.equal(run.estimated_total_cost_usd, 0);
  assert.ok(fs.existsSync(path.join(run.artifact_dir, "revit_workflow_result.json")));
});

test("deterministic Revit workflow run can use local request overrides", async () => {
  const original = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_receptacles", tasks);
  const batchDir = tempDir("deterministic-revit-overrides");
  const overridePath = path.join(batchDir, "overrides.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      tasks: {
        demo_takeoff_receptacles: {
          request: { filters: { keywords_include: ["override"] } },
          mock: {
            "/revit/quantify": {
              summary: { total: 1, groups: { "Override Group": 1 } },
              rows: [{ id: 9001, type: "Override" }]
            }
          }
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "success");
    assert.match(run.observed_outcome_summary, /Counted 1 element/);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = original;
  }
});

test("deterministic Revit workflow blocks live add-tag without explicit override", async () => {
  const originalMocks = process.env.OPERATOR_BENCHMARK_USE_MOCKS;
  const originalOverride = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_redline_add_tag", tasks);
  const batchDir = tempDir("deterministic-revit-add-tag-live-no-override");

  try {
    process.env.OPERATOR_BENCHMARK_USE_MOCKS = "0";
    delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "fail");
    assert.match(run.termination_reason, /live runs require OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON/i);
  } finally {
    if (originalMocks === undefined) delete process.env.OPERATOR_BENCHMARK_USE_MOCKS;
    else process.env.OPERATOR_BENCHMARK_USE_MOCKS = originalMocks;
    if (originalOverride === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = originalOverride;
  }
});

test("deterministic Revit workflow run validates only the selected task override", async () => {
  const original = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_mechanical_equipment", tasks);
  const batchDir = tempDir("deterministic-revit-scoped-overrides");
  const overridePath = path.join(batchDir, "overrides.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      tasks: {
        demo_takeoff_mechanical_equipment: {
          request: { filters: { keywords_include_any: ["VAV"] } },
          mock: {
            "/revit/quantify": {
              summary: { total: 1, groups: { "Mechanical Equipment | VAV": 1 } },
              rows: [{ id: 9002, category: "Mechanical Equipment", type: "VAV" }]
            }
          }
        },
        demo_redline_mep_route: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "success");
    assert.match(run.observed_outcome_summary, /Counted 1 element/);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = original;
  }
});

test("Revit workflow overrides reject unfilled corpus template placeholders", async () => {
  const placeholders = findBenchmarkOverridePlaceholders({
    tasks: {
      demo_redline_move_light: {
        request: {
          viewId: "__FILL_VERIFIED_VIEW_ID__",
          familyInstance: { symbolName: "__FILL_SYMBOL_OR_TYPE_NAME__" }
        }
      }
    }
  });
  assert.deepEqual(placeholders, [
    "$.tasks.demo_redline_move_light.request.viewId",
    "$.tasks.demo_redline_move_light.request.familyInstance.symbolName"
  ]);
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      status: "template_requires_verified_revit_ids",
      ready_to_run: false,
      placeholder_count: 2,
      tasks: {
        demo_redline_move_light: {
          request: { viewId: "__FILL_VERIFIED_VIEW_ID__" }
        }
      }
    }, "template.json"),
    /not runnable.*placeholder_count=2.*request\.viewId/is
  );
});

test("Revit workflow overrides reject batch template status without placeholders", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      status: "batch_template_requires_verified_revit_ids",
      ready_to_run: false,
      placeholder_count: 0,
      tasks: {
        demo_redline_mep_route: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "batch-template.json"),
    /not runnable.*status=batch_template_requires_verified_revit_ids.*placeholder_count=0/is
  );
});

test("Revit workflow overrides reject task-level ready_to_run false", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_add_tag: {
          ready_to_run: false,
          request: {
            viewId: 4001,
            targetKind: "tag",
            dryRunPreflightReviewed: true,
            tag: {
              viewId: 4001,
              elementIds: [9001],
              tagTypeId: 9101,
              readbackRequired: true
            },
            cleanupCreatedElements: true
          }
        }
      }
    }, "task-ready-false.json"),
    /not runnable/is
  );
});

test("demo live request example includes move MEP accessory scaffold", () => {
  const examplePath = path.join(process.cwd(), "benchmark", "configs", "demo_live_requests.example.json");
  const example = JSON.parse(fs.readFileSync(examplePath, "utf8")) as {
    tasks?: Record<string, { request?: Record<string, unknown> }>;
  };
  const request = example.tasks?.demo_redline_move_mep_accessory?.request;
  assert.equal(request?.targetKind, "manual_balancing_damper");
  assert.equal((request?.familyInstance as Record<string, unknown> | undefined)?.symbolName, "Manual Balancing Damper");
  assert.deepEqual(request?.move, {
    mode: "vector",
    vectorX: 1,
    vectorY: 0,
    vectorZ: 0,
    behavior: "allOrNothing"
  });
});

test("Revit workflow overrides reject incomplete scoped MEP sizing requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_size_transition: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            hostElementId: 1542001,
            upstreamDuctSize: "28x18",
            downstreamDuctSize: "16x14",
            transitionNormalized: 0.45,
            expectedFitting: "transition",
            apply: true,
            verifyConnectorNetwork: true,
            visualVerify: true,
            cleanupCreatedElements: true,
            sizingScope: {
              region: "marked room band",
              perSegmentReadbackRequired: false
            }
          }
        }
      }
    }, "scoped-sizing.json"),
    /invalid scoped MEP sizing inputs.*elementIds.*engineeringSizingBasis.*perSegmentReadbackRequired/is
  );
});

test("Revit workflow overrides accept filled scoped MEP sizing requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_pipe_size_transition: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            hostElementId: 1642001,
            upstreamPipeSize: "2\"",
            downstreamPipeSize: "1\"",
            transitionChainageFt: 8.5,
            expectedFitting: "reducer",
            apply: true,
            verifyConnectorNetwork: true,
            visualVerify: true,
            cleanupCreatedElements: true,
            sizingScope: {
              elementIds: [1642001, 1642002],
              region: "marked pipe rack band",
              engineeringSizingBasis: "redline airflow/flow calculation notes",
              perSegmentReadbackRequired: true
            }
          }
        }
      }
    }, "scoped-sizing.json")
  );
});

test("Revit workflow overrides accept disposable setup for MEP size-transition and branch-network requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      ready_to_run: true,
      placeholder_count: 0,
      tasks: {
        demo_redline_mep_pipe_size_transition: {
          request: {
            viewId: 1363433,
            visualViewId: 1363433,
            upstreamPipeSize: "1 inch",
            downstreamPipeSize: "1.5 in",
            expectedFitting: "transition",
            transitionNormalized: 0.5,
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true,
            createHostRoute: {
              pipeSize: "1 inch",
              points: [{ x: 70, y: -76, z: 43 }, { x: 94, y: -76, z: 43 }]
            }
          }
        },
        demo_redline_mep_pipe_tap_branch: {
          request: {
            branchNetworkWorkflow: true,
            viewId: 1363433,
            visualViewId: 1363433,
            projectedTapPoint: { x: 97.5, y: -82 },
            mainPoints: [{ x: 90, y: -82, z: 43 }, { x: 105, y: -82, z: 43 }],
            branches: [{
              points: [{ x: 97.5, y: -82, z: 43 }, { x: 97.5, y: -75, z: 43 }]
            }],
            pipeSize: "1 inch",
            expectedFitting: "tee",
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "disposable-mep-live.json")
  );
});

test("Revit workflow overrides reject incomplete unscoped MEP size-transition requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_size_transition: {
          request: {
            viewId: 4001,
            hostElementId: 1542001,
            upstreamDuctSize: "28x18",
            downstreamDuctSize: "16x14"
          }
        }
      }
    }, "single-transition.json"),
    /invalid MEP size-transition inputs.*visualViewId.*transitionNormalized.*expectedFitting.*apply.*verify.*visualVerify.*cleanupCreatedElements/is
  );
});

test("deterministic Revit workflow run blocks unscoped MEP size-transition overrides before runtime", async () => {
  const original = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_redline_mep_duct_size_transition", tasks);
  const batchDir = tempDir("deterministic-revit-unscoped-size-transition-guard");
  const overridePath = path.join(batchDir, "overrides.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      tasks: {
        demo_redline_mep_duct_size_transition: {
          request: {
            viewId: 4001,
            upstreamDuctSize: "28x18",
            downstreamDuctSize: "16x14",
            apply: true,
            verifyConnectorNetwork: true
          }
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "fail");
    assert.match(run.termination_reason, /invalid MEP size-transition inputs/i);
    assert.match(run.termination_reason, /hostElementId/i);
    assert.match(run.termination_reason, /transitionNormalized/i);
    assert.match(run.termination_reason, /visualViewId/i);
    assert.match(run.termination_reason, /visualVerify/i);
    assert.match(run.termination_reason, /cleanupCreatedElements/i);
    assert.equal(run.total_executor_calls, 0);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = original;
  }
});

test("Revit workflow overrides accept bounded single size-transition requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_size_transition: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            hostElementId: 1542001,
            upstreamDuctSize: "28x18",
            downstreamDuctSize: "16x14",
            projectedTransitionPoint: { x: 12.5, y: 18.25, z: 3 },
            expectedFitting: "transition",
            apply: true,
            verifyConnectorNetwork: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "single-transition.json")
  );
});

test("Revit workflow overrides reject incomplete parameter edit requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_parameter_edit: {
          request: {
            elementIds: [301],
            parameterName: "Comments",
            readbackRequired: true
          }
        }
      }
    }, "parameter-edit.json"),
    /invalid parameter edit inputs.*value.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept bounded parameter edit requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_parameter_edit: {
          request: {
            elementIds: [301, 302],
            parameterName: "Comments",
            value: "DEMO VERIFIED",
            minTargetCount: 2,
            readbackRequired: true,
            revertAfterVerify: true
          }
        }
      }
    }, "parameter-edit.json")
  );
});

test("Revit workflow overrides reject ungrounded MEP accessory parameter text edits", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_text_edit_mep_accessory: {
          request: {
            elementIds: [801],
            parameterName: "Mark",
            value: "MBD-1A",
            readbackRequired: true,
            revertAfterVerify: true
          }
        }
      }
    }, "accessory-parameter-edit.json"),
    /invalid parameter edit inputs.*expectedCategory.*expectedFamilyName.*visualVerify.*visualViewId/is
  );
});

test("Revit workflow overrides accept grounded MEP accessory parameter text edits", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_text_edit_mep_accessory: {
          request: {
            elementIds: [801],
            parameterName: "Mark",
            value: "MBD-1A",
            minTargetCount: 1,
            targetKind: "mep_accessory",
            targetGrounding: {
              expectedCategory: "OST_DuctAccessory",
              expectedFamilyName: "Manual Balancing Damper",
              expectedTypeName: "8x8"
            },
            readbackRequired: true,
            revertAfterVerify: true,
            visualVerify: true,
            visualViewId: 4001
          }
        }
      }
    }, "accessory-parameter-edit.json")
  );
});

test("Revit workflow overrides reject incomplete existing schedule text edits", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              useExisting: true,
              name: "RAT Schedule",
              category: "Mechanical Equipment",
              fields: ["Flow"]
            },
            configureSchedule: {
              requireExistingScheduleTarget: true,
              requestedTextOrValue: "400 CFM",
              readbackRequired: true
            }
          }
        }
      }
    }, "schedule-edit.json"),
    /invalid documentation primitive inputs.*configureSchedule existing schedule edits require schedule\.scheduleId.*targetFieldName.*targetRowKey/is
  );
});

test("Revit workflow overrides accept bounded existing schedule text edits", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              useExisting: true,
              scheduleId: 8101,
              name: "RAT Schedule",
              category: "Mechanical Equipment",
              fields: ["Flow"]
            },
            configureSchedule: {
              requireExistingScheduleTarget: true,
              targetFieldName: "Flow",
              targetRowKey: "RAT-1",
              requestedTextOrValue: "400 CFM",
              readbackRequired: true
            }
          }
        }
      }
    }, "schedule-edit.json")
  );
});

test("Revit workflow overrides reject incomplete parameter-backed schedule edits", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            replaceBaseRequest: true,
            viewId: 1422218,
            visualViewId: 1422218,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              editExistingValue: true,
              scheduleId: 1422218,
              rowKey: "101",
              replacementValue: "Cafe - Verified"
            }
          }
        }
      }
    }, "schedule-parameter-edit.json"),
    /invalid documentation primitive inputs.*schedule\.elementId.*schedule\.parameterName.*schedule\.expectedExistingValue.*schedule\.readbackRequired.*schedule\.revertAfterVerify/is
  );
});

test("documentation primitives can edit and revert a parameter-backed schedule row with CSV readback", async () => {
  const originalOverride = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_documentation_primitives", tasks);
  const batchDir = tempDir("documentation-schedule-parameter-edit");
  const afterCsvPath = path.join(batchDir, "space_schedule_after.csv");
  const finalCsvPath = path.join(batchDir, "space_schedule_final.csv");
  fs.writeFileSync(afterCsvPath, `"Number","Name"\n"101","Cafe - Verified"\n`, "utf8");
  fs.writeFileSync(finalCsvPath, `"Number","Name"\n"101","Cafe"\n`, "utf8");
  const overridePath = path.join(batchDir, "overrides.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      tasks: {
        demo_documentation_primitives: {
          request: {
            replaceBaseRequest: true,
            viewId: 1422218,
            visualViewId: 1422218,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              editExistingValue: true,
              scheduleId: 1422218,
              scheduleName: "Space Schedule",
              elementId: 1422594,
              rowKey: "101",
              parameterName: "Name",
              expectedExistingValue: "Cafe",
              replacementValue: "Cafe - Verified",
              preserveTextCase: true,
              readbackRequired: true,
              revertAfterVerify: true
            }
          },
          mock: {
            "/revit/get-parameters:1": { items: [{ id: 1422594, parameters: { Name: "Cafe" } }] },
            "/revit/set-parameter:1": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 1422594, parameterName: "Name", ok: true }] },
            "/revit/set-parameter:2": { status: "Applied", dryRun: false, diffs: [{ elementId: 1422594, parameterName: "Name", ok: true }] },
            "/revit/get-parameters:2": { items: [{ id: 1422594, parameters: { Name: "Cafe - Verified" } }] },
            "/revit/export-schedule-csv:1": { status: "Success", path: afterCsvPath, schedule: { id: 1422218, name: "Space Schedule" } },
            "/revit/set-parameter:3": { status: "Dry Run", dryRun: true, diffs: [{ elementId: 1422594, parameterName: "Name", ok: true }] },
            "/revit/set-parameter:4": { status: "Applied", dryRun: false, diffs: [{ elementId: 1422594, parameterName: "Name", ok: true }] },
            "/revit/get-parameters:3": { items: [{ id: 1422594, parameters: { Name: "Cafe" } }] },
            "/revit/export-schedule-csv:2": { status: "Success", path: finalCsvPath, schedule: { id: 1422218, name: "Space Schedule" } }
          }
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "success");
    const resultPath = path.join(run.artifact_dir, "revit_workflow_result.json");
    const result = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    const verificationNames = (result.verification_results as Array<{ name: string; ok: boolean }>).filter((entry) => entry.ok).map((entry) => entry.name);
    assert.ok(verificationNames.includes("schedule_csv_readback_matches_request"));
    assert.ok(verificationNames.includes("schedule_revert_csv_matches_original"));
    assert.equal(result.execution_source, "mock");
  } finally {
    if (originalOverride === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = originalOverride;
  }
});

test("Revit workflow overrides reject incomplete existing text-note edits", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            textNote: {
              editExisting: true,
              text: "MOTORIZED"
            }
          }
        }
      }
    }, "text-note-edit.json"),
    /invalid documentation primitive inputs.*textNote\.textNoteId.*textNote\.expectedExistingText.*textNote\.readbackRequired.*textNote\.revertAfterVerify/is
  );
});

test("Revit workflow overrides accept bounded existing text-note edits", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            textNote: {
              editExisting: true,
              viewId: 8101,
              textNoteId: 4401,
              expectedExistingText: "COUNTERBALANCED",
              text: "MOTORIZED",
              readbackRequired: true,
              revertAfterVerify: true
            }
          }
        }
      }
    }, "text-note-edit.json")
  );
});

test("Revit workflow overrides reject composite text-note edits without grouped visual proof", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            textNote: {
              editExisting: true,
              viewId: 8101,
              textNoteId: 4401,
              expectedExistingText: "COUNTERBALANCED",
              text: "MOTORIZED",
              readbackRequired: true,
              revertAfterVerify: true,
              compositeGroupEdit: true,
              groupGrounding: {
                groupIndex: "7",
                annotationIndices: "40|41|42",
                reviewGroupActionability: "likely_single_action"
              }
            }
          }
        }
      }
    }, "composite-text-note-edit.json"),
    /invalid documentation primitive inputs.*textNote\.groupVisualProofReviewed/is
  );
});

test("Revit workflow overrides accept bounded composite text-note edits with grouped visual proof", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 8101,
            visualViewId: 8101,
            visualVerify: true,
            cleanupCreatedElements: true,
            textNote: {
              editExisting: true,
              viewId: 8101,
              textNoteId: 4401,
              expectedExistingText: "COUNTERBALANCED",
              text: "MOTORIZED",
              readbackRequired: true,
              revertAfterVerify: true,
              compositeGroupEdit: true,
              groupGrounding: {
                groupIndex: "7",
                annotationIndices: "40|41|42",
                reviewGroupActionability: "likely_single_action"
              },
              groupVisualProofReviewed: true
            }
          }
        }
      }
    }, "composite-text-note-edit.json")
  );
});

test("Revit workflow overrides reject incomplete MEP route requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_route: {
          request: {
            viewId: 4001,
            levelName: "L4",
            systemType: "Supply Air",
            ductSize: "12x10",
            points: [{ x: 40, y: 27 }],
            apply: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "route.json"),
    /invalid MEP route inputs.*visualViewId.*points.*dryRunFirst.*dryRunPreviewReviewed.*endpointGrounding.*verify.*visualVerify/is
  );
});

test("Revit workflow overrides accept bounded MEP route requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_pipe_route: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            levelName: "L4",
            systemType: "Domestic Cold Water",
            pipeSize: "2\"",
            points: [{ x: 42, y: 24 }, { x: 55, y: 24 }],
            apply: true,
            dryRunFirst: true,
            dryRunPreviewReviewed: true,
            endpointGrounding: {
              allowOpenEndsForDisposableBenchmark: true,
              openEndPolicy: "disposable benchmark route cleaned after verification"
            },
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "route.json")
  );
});

test("Revit workflow overrides reject incomplete MEP route mutation requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_duct_route: {
          request: {
            viewId: 4001,
            levelName: "L4",
            systemType: "Supply Air",
            points: [{ x: 40, y: 27 }],
            cleanupCreatedElements: true
          }
        }
      }
    }, "route-mutation.json"),
    /invalid MEP route mutation inputs.*ductSize.*points.*verify.*move\.vectorX\/Y\/Z/is
  );
});

test("Revit workflow overrides accept bounded MEP route mutation requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_pipe_route: {
          request: {
            viewId: 4001,
            levelName: "L4",
            systemType: "Domestic Cold Water",
            pipeSize: "2\"",
            points: [{ x: 42, y: 24 }, { x: 55, y: 24 }],
            verify: true,
            cleanupCreatedElements: true,
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        }
      }
    }, "route-mutation.json")
  );
});

test("Revit workflow overrides reject unsafe existing route move requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_duct_route: {
          request: {
            viewId: 4001,
            targetKind: "duct_route",
            existingTarget: {
              moveExisting: true,
              elementIds: [7301],
              expectedCategory: "OST_DuctCurves",
              readbackRequired: true
            },
            move: { vectorX: 0, vectorY: 0, vectorZ: 1 },
            visualVerify: true
          }
        }
      }
    }, "route-existing-move.json"),
    /invalid MEP route mutation inputs.*expectedKind.*expectedSystemName.*connectedNetworkAuditRequired.*dryRunPreflightReviewed.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept grounded existing route move requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_pipe_route: {
          request: {
            viewId: 4001,
            targetKind: "pipe_route",
            kind: "pipe",
            existingTarget: {
              moveExisting: true,
              elementIds: [7401],
              expectedKind: "pipe",
              expectedCategory: "OST_PipeCurves",
              expectedSystemName: "Domestic Cold Water",
              readbackRequired: true,
              connectedNetworkAuditRequired: true
            },
            move: { vectorX: 0, vectorY: 1, vectorZ: 0 },
            dryRunPreflightReviewed: true,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "route-existing-move.json")
  );
});

test("Revit workflow overrides reject incomplete type-change requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_type_change_duct: {
          request: {
            elementIds: [9501],
            targetTypeId: 9602,
            visualVerify: true
          }
        }
      }
    }, "type-change.json"),
    /invalid type-change inputs.*category.*dryRunPreflightReviewed.*targetTypeCompatibilityReviewed.*sourceTypeGrounding.*visualViewId.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept bounded type-change requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_type_change_device: {
          request: {
            elementIds: [9301],
            category: "OST_ElectricalFixtures",
            targetTypeId: 9402,
            sourceTypeGrounding: { expectedCurrentTypeId: 9401 },
            dryRunPreflightReviewed: true,
            targetTypeCompatibilityReviewed: true,
            visualViewId: 4001,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "type-change.json")
  );
});

test("Revit workflow overrides require accessory identity grounding for MEP accessory type changes", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_type_change_mep_accessory: {
          request: {
            elementIds: [9701],
            category: "OST_DuctAccessory",
            targetTypeId: 9802,
            sourceTypeGrounding: { expectedCurrentTypeId: 9801 },
            dryRunPreflightReviewed: true,
            targetTypeCompatibilityReviewed: true,
            visualViewId: 4001,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "type-change-accessory.json"),
    /sourceFamilyGrounding.*expectedFamilyName.*expectedTypeName.*expectedCategory/is
  );

  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_type_change_mep_accessory: {
          request: {
            elementIds: [9701],
            category: "OST_DuctAccessory",
            targetTypeId: 9802,
            sourceFamilyGrounding: { expectedFamilyName: "Manual Balancing Damper" },
            sourceTypeGrounding: { expectedCurrentTypeId: 9801 },
            dryRunPreflightReviewed: true,
            targetTypeCompatibilityReviewed: true,
            visualViewId: 4001,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "type-change-accessory.json"),
    /sourceFamilyGrounding.*expectedFamilyName.*expectedTypeName.*expectedCategory/is
  );

  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_type_change_mep_accessory: {
          request: {
            elementIds: [9701],
            category: "OST_DuctAccessory",
            targetTypeId: 9802,
            sourceFamilyGrounding: { expectedFamilyName: "Manual Balancing Damper", expectedTypeName: "12x12 Manual Balancing Damper", expectedCategory: "OST_DuctAccessory" },
            sourceTypeGrounding: { expectedCurrentTypeId: 9801 },
            dryRunPreflightReviewed: true,
            targetTypeCompatibilityReviewed: true,
            visualViewId: 4001,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "type-change-accessory.json")
  );
});

test("Revit workflow overrides reject incomplete add-like tag requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_add_tag: {
          request: {
            viewId: 4001,
            tag: {
              elementIds: []
            }
          }
        }
      }
    }, "add-tag.json"),
    /invalid redline add inputs.*cleanupCreatedElements.*tag\.viewId.*tag\.elementIds.*tag\.readbackRequired.*tag\.tagTypeId or tag\.tagTypeName.*dryRunPreflightReviewed/is
  );
});

test("Revit workflow overrides accept bounded add-like tag requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_add_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            tag: {
              viewId: 4001,
              elementIds: [9001],
              tagTypeId: 9101,
              onlyUntagged: false,
              addLeader: false,
              readbackRequired: true
            },
            dryRunPreflightReviewed: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "add-tag.json")
  );
});

test("Revit workflow overrides reject unsafe existing tag delete apply requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            tag: {
              existingTagIds: [9201],
              readbackRequired: true
            },
            existingTarget: {
              deleteExisting: true,
              elementIds: [9201],
              expectedCategory: "Tags",
              expectedTagText: "EF-1",
              readbackRequired: true
            },
            applyExistingDelete: true
          }
        }
      }
    }, "delete-tag-existing.json"),
    /invalid redline mutation inputs.*applyExistingDelete is not supported for existing tag deletes/is
  );
});

test("Revit workflow overrides accept grounded existing tag delete preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            tag: {
              existingTagIds: [9201],
              elementIds: [9001],
              readbackRequired: true
            },
            existingTarget: {
              deleteExisting: true,
              elementIds: [9201],
              expectedCategory: "Tags",
              expectedTagText: "EF-1",
              taggedElementIds: [9001],
              readbackRequired: true
            },
            applyExistingDelete: false
          }
        }
      }
    }, "delete-tag-existing.json")
  );
});

test("Revit workflow overrides reject incomplete add-like family instance requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_add_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            familyInstance: {
              familyName: "Manual Balancing Damper",
              x: 10,
              y: 20
            },
            cleanupCreatedElements: true
          }
        }
      }
    }, "add-family-instance.json"),
    /invalid redline add inputs.*symbolName.*levelName.*hostElementId.*placementBasis.*x\/y\/z/is
  );
});

test("Revit workflow overrides accept bounded add-like family instance requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_add_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            familyInstance: {
              familyName: "Manual Balancing Damper",
              symbolName: "Manual Balancing Damper",
              levelName: "L4",
              hostElementId: 1542919,
              placementBasis: "hosted on verified duct accessory insertion point",
              x: 10,
              y: 20,
              z: 0
            },
            cleanupCreatedElements: true
          }
        }
      }
    }, "add-family-instance.json")
  );
});

test("Revit workflow overrides reject incomplete redline mutation requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            tag: {
              elementIds: [9001]
            }
          }
        },
        demo_redline_rotate_text: {
          request: {
            viewId: 4001,
            textNote: {
              text: "ROTATE ME"
            }
          }
        }
      }
    }, "redline-mutation.json"),
    /invalid redline mutation inputs.*move\.vectorX\/Y\/Z.*tag\.viewId.*rotate\.angleDegrees.*rotate\.axis\.pointX\/Y.*textNote\.x\/y/is
  );
});

test("Revit workflow overrides accept bounded redline mutation requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_family_instance: {
          request: {
            viewId: 4001,
            targetKind: "family_instance",
            familyInstance: {
              familyName: "Generic Annotation",
              symbolName: "Generic Annotation",
              levelName: "L4",
              x: 10,
              y: 20,
              z: 0
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        },
        demo_redline_rotate_text: {
          request: {
            viewId: 4001,
            targetKind: "text_note",
            textNote: {
              x: 10,
              y: 20,
              text: "ROTATE ME"
            },
            rotate: { angleDegrees: 90, axis: { pointX: 10, pointY: 20, pointZ: 0 } }
          }
        }
      }
    }, "redline-mutation.json")
  );
});

test("Revit workflow overrides reject unsafe existing TextNote delete requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_text: {
          request: {
            viewId: 4001,
            targetKind: "text_note",
            existingTarget: {
              deleteExisting: true,
              elementIds: [7601]
            }
          }
        }
      }
    }, "existing-text-delete.json"),
    /invalid redline mutation inputs.*expectedText.*expectedCategory.*readbackRequired/is
  );
});

test("Revit workflow overrides accept grounded existing TextNote delete preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_text: {
          request: {
            viewId: 4001,
            targetKind: "text_note",
            textNote: {
              textNoteId: 7601,
              expectedExistingText: "REMOVE THIS NOTE",
              readbackRequired: true
            },
            existingTarget: {
              deleteExisting: true,
              elementIds: [7601],
              expectedCategory: "OST_TextNotes",
              expectedText: "REMOVE THIS NOTE",
              readbackRequired: true
            },
            applyExistingDelete: false
          }
        }
      }
    }, "existing-text-delete.json")
  );
});

test("Revit workflow overrides reject unsafe existing family-instance delete apply requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_light: {
          request: {
            viewId: 4001,
            targetKind: "family_instance",
            existingTarget: {
              deleteExisting: true,
              elementIds: [9301],
              expectedFamilyName: "Wall Sconce",
              expectedTypeName: "Type A",
              expectedCategory: "OST_LightingFixtures",
              readbackRequired: true
            },
            applyExistingDelete: true
          }
        }
      }
    }, "existing-light-delete.json"),
    /invalid redline mutation inputs.*applyExistingDelete is not supported/is
  );
});

test("Revit workflow overrides accept grounded existing family-instance delete preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_receptacle: {
          request: {
            viewId: 4001,
            targetKind: "family_instance",
            existingTarget: {
              deleteExisting: true,
              elementIds: [9301],
              expectedFamilyName: "Duplex Receptacle",
              expectedTypeName: "GFCI",
              expectedCategory: "OST_ElectricalFixtures",
              readbackRequired: true
            },
            applyExistingDelete: false
          }
        }
      }
    }, "existing-receptacle-delete.json")
  );
});

test("Revit workflow overrides reject ungrounded existing family-instance move requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_light: {
          request: {
            viewId: 4001,
            targetKind: "family_instance",
            existingTarget: {
              moveExisting: true,
              elementIds: [9301]
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        }
      }
    }, "existing-light-move.json"),
    /invalid redline mutation inputs.*expectedFamilyName or expectedTypeName.*expectedCategory.*dryRunPreflightReviewed.*readbackRequired.*visualVerify.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept grounded existing family-instance move requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_receptacle: {
          request: {
            viewId: 4001,
            targetKind: "family_instance",
            existingTarget: {
              moveExisting: true,
              elementIds: [9301],
              expectedFamilyName: "Duplex Receptacle",
              expectedTypeName: "GFCI",
              expectedCategory: "OST_ElectricalFixtures",
              readbackRequired: true
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 },
            dryRunPreflightReviewed: true,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "existing-receptacle-move.json")
  );
});

test("Revit workflow overrides reject ungrounded existing MEP accessory move requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            existingTarget: {
              moveExisting: true,
              elementIds: [8301]
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        }
      }
    }, "existing-accessory-move.json"),
    /invalid redline mutation inputs.*expectedFamilyName or expectedTypeName.*expectedCategory.*dryRunPreflightReviewed.*readbackRequired.*visualVerify.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept bounded existing MEP accessory move requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            existingTarget: {
              moveExisting: true,
              elementIds: [8301],
              expectedFamilyName: "Manual Balancing Damper",
              expectedTypeName: "MBD-8",
              expectedCategory: "Mechanical Equipment",
              readbackRequired: true
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 },
            dryRunPreflightReviewed: true,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "existing-accessory-move.json")
  );
});

test("Revit workflow overrides reject unsafe existing tag move requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            existingTarget: {
              moveExisting: true,
              elementIds: [8501]
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        }
      }
    }, "existing-tag-move.json"),
    /invalid redline mutation inputs.*expectedCategory.*expectedTagText or tagged element ids.*dryRunPreflightReviewed.*readbackRequired.*visualVerify.*revertAfterVerify/is
  );
});

test("Revit workflow overrides accept grounded existing tag move requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_move_tag: {
          request: {
            viewId: 4001,
            targetKind: "tag",
            tag: {
              existingTagIds: [8501],
              elementIds: [9001],
              readbackRequired: true
            },
            existingTarget: {
              moveExisting: true,
              elementIds: [8501],
              expectedCategory: "OST_DuctTags",
              expectedTagText: "EF-1",
              taggedElementIds: [9001],
              readbackRequired: true
            },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 },
            dryRunPreflightReviewed: true,
            visualVerify: true,
            revertAfterVerify: true
          }
        }
      }
    }, "existing-tag-move.json")
  );
});

test("Revit workflow overrides reject unsafe existing MEP accessory delete apply requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            existingTarget: {
              deleteExisting: true,
              elementIds: [8301],
              expectedFamilyName: "Manual Balancing Damper",
              expectedTypeName: "MBD-8",
              expectedCategory: "Mechanical Equipment",
              readbackRequired: true
            },
            applyExistingDelete: true
          }
        }
      }
    }, "existing-accessory-delete.json"),
    /invalid redline mutation inputs.*applyExistingDelete is not supported/is
  );
});

test("Revit workflow overrides accept grounded existing MEP accessory delete preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_mep_accessory: {
          request: {
            viewId: 4001,
            targetKind: "mep_accessory",
            existingTarget: {
              deleteExisting: true,
              elementIds: [8301],
              expectedFamilyName: "Manual Balancing Damper",
              expectedTypeName: "MBD-8",
              expectedCategory: "Mechanical Equipment",
              readbackRequired: true
            },
            applyExistingDelete: false
          }
        }
      }
    }, "existing-accessory-delete.json")
  );
});

test("Revit workflow overrides reject unsafe existing duct route delete apply requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_duct_route: {
          request: {
            viewId: 4001,
            targetKind: "duct_route",
            kind: "duct",
            existingTarget: {
              deleteExisting: true,
              elementIds: [1542001],
              expectedKind: "duct",
              expectedCategory: "OST_DuctCurves",
              expectedSystemName: "Supply Air",
              readbackRequired: true,
              connectedNetworkAuditRequired: true
            },
            applyExistingDelete: true
          }
        }
      }
    }, "existing-duct-route-delete.json"),
    /invalid MEP route mutation inputs.*applyExistingDelete is not supported/is
  );
});

test("Revit workflow overrides accept grounded existing pipe route delete preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_delete_pipe_route: {
          request: {
            viewId: 4001,
            targetKind: "pipe_route",
            kind: "pipe",
            existingTarget: {
              deleteExisting: true,
              elementIds: [1642001],
              expectedKind: "pipe",
              expectedCategory: "OST_PipeCurves",
              expectedSystemName: "Domestic Cold Water",
              readbackRequired: true,
              connectedNetworkAuditRequired: true
            },
            applyExistingDelete: false
          }
        }
      }
    }, "existing-pipe-route-delete.json")
  );
});

test("Revit workflow overrides reject incomplete documentation primitive requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            categoryVisibility: {
              categoryName: "Ducts",
              lineWeight: 5
            },
            cadGraphicsOverride: {
              layerOrSubcategoryName: "M104-FUTURE",
              lineWeight: 5
            },
            linkedModelGraphicsOverride: {
              linkedModelName: "Architectural",
              categoryOrSubcategoryName: "Plumbing Fixtures",
              visibilityOrLineweight: "5"
            }
          }
        }
      }
    }, "documentation.json"),
    /invalid documentation primitive inputs.*linkedModelGraphicsOverride.*categoryVisibility\.readbackRequired.*categoryVisibility\.revertAfterVerify.*cadGraphicsOverride requires cadLink/is
  );
});

test("Revit workflow overrides reject weak documentation tag requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            tag: {
              viewId: 4001,
              elementIds: [301, 302]
            }
          }
        }
      }
    }, "documentation-tag.json"),
    /invalid documentation primitive inputs.*tag\.readbackRequired.*tag\.tagTypeId or tag\.tagTypeName/is
  );
});

test("Revit workflow overrides reject incomplete existing tag value edits", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            tag: {
              editExistingValue: true,
              viewId: 4001,
              elementIds: [301],
              requestedTagValueHint: "EF-2",
              readbackRequired: true
            }
          }
        }
      }
    }, "documentation-tag-value-edit.json"),
    /invalid documentation primitive inputs.*tag\.existingTagIds.*tag\.valueSourceParameterName.*tag\.expectedExistingValue.*tag\.revertAfterVerify/is
  );
});

test("Revit workflow overrides accept bounded existing tag value edits", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            tag: {
              editExistingValue: true,
              viewId: 4001,
              existingTagIds: [9001],
              elementIds: [301],
              valueSourceParameterName: "Mark",
              expectedExistingValue: "EF-1",
              requestedTagValueHint: "EF-2",
              readbackRequired: true,
              revertAfterVerify: true
            }
          }
        }
      }
    }, "documentation-tag-value-edit.json")
  );
});

test("Revit workflow overrides accept composite visible text for existing tag value edits", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            tag: {
              editExistingValue: true,
              viewId: 4001,
              existingTagIds: [9001],
              elementIds: [301],
              valueSourceParameterName: "Name",
              expectedExistingValue: "Exit Lobby",
              expectedExistingVisibleText: "Exit Lobby100",
              requestedTagValueHint: "Exit Lobby QA",
              requestedVisibleText: "Exit Lobby QA100",
              readbackRequired: true,
              revertAfterVerify: true
            }
          }
        }
      }
    }, "documentation-composite-tag-value-edit.json")
  );
});

test("Revit workflow overrides require CAD owner-view bbox readback flag", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            cadLink: {
              sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg"
            }
          }
        }
      }
    }, "documentation-cad.json"),
    /invalid documentation primitive inputs.*cadLink\.ownerViewBoundingBoxRequired/is
  );
});

test("Revit workflow overrides require grounded CAD reload preflight inputs", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            cadReload: {
              existingCadLinkIds: [7001],
              readbackRequired: true,
              applyReload: true
            }
          }
        }
      }
    }, "documentation-cad-reload.json"),
    /invalid documentation primitive inputs.*cadReload\.expectedSourcePath.*cadReload\.ownerViewId.*cadReload\.applyReload/is
  );
});

test("Revit workflow overrides accept no-write CAD reload preflight requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            cadReload: {
              preflightOnly: true,
              existingCadLinkIds: [7001],
              expectedCadLinkName: "Snowdon-M104-Plan-HVAC-L4.dwg",
              expectedSourcePath: "Snowdon-M104-Plan-HVAC-L4.dwg",
              ownerViewId: 5001,
              readbackRequired: true,
              applyReload: false
            }
          }
        }
      }
    }, "documentation-cad-reload.json")
  );
});

test("Revit workflow overrides accept bounded documentation primitive requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              name: "Operator Verified Door Schedule",
              category: "OST_Doors",
              fields: ["Family and Type"]
            },
            categoryVisibility: {
              categoryName: "Lines",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true
            },
            linkedModelCategoryVisibility: {
              linkedModelName: "Snowdon Towers Sample Architectural.rvt",
              categoryName: "Plumbing Fixtures",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true
            },
            phaseVisibility: {
              phaseName: "New Construction",
              phaseFilterName: "Show Complete",
              originalPhaseName: "Existing",
              originalPhaseFilterName: "Show All",
              readbackRequired: true,
              revertAfterVerify: true
            },
            filterVisibility: {
              filterName: "Operator Verified Future Work",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true,
              createFilter: {
                categoryName: "OST_Doors",
                ruleParameterName: "Comments",
                ruleParameterStorageType: "string",
                ruleOperator: "contains",
                ruleValue: "OPERATOR-BENCHMARK-NO-MATCH"
              }
            },
            templateCategoryVisibility: {
              categoryName: "Lines",
              lineWeight: 5
            },
            textNote: {
              x: 1,
              y: 1,
              text: "Operator verified annotation"
            },
            tag: {
              viewId: 4001,
              elementIds: [301, 302],
              tagTypeName: "Duct Size Tag",
              requestedTagKindHint: "duct size tag",
              readbackRequired: true
            },
            cadLink: {
              sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg",
              ownerViewBoundingBoxRequired: true
            },
            cadGraphicsOverride: {
              layerOrSubcategoryName: "M104-FUTURE",
              lineWeight: 5
            }
          }
        }
      }
    }, "documentation.json")
  );
});

test("Revit workflow overrides accept below-schedule notes with grounded schedule placement", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              name: "Operator Verified Schedule Note Layout",
              category: "OST_MechanicalEquipment",
              fields: ["Family and Type", "Mark"],
              placeOnSheet: {
                sheetId: 1420963,
                x: 1,
                y: 8
              }
            },
            configureSchedule: {
              filters: [
                {
                  field: "Mark",
                  op: "begins_with",
                  value: "VAV-1-"
                }
              ]
            },
            textNote: {
              placeBelowSchedule: true,
              belowOffsetFeet: 0.25,
              text: "NOTE 1: PROVIDE ACCESS CLEARANCE."
            }
          }
        }
      }
    }, "documentation-schedule-note.json")
  );
});

test("Revit workflow overrides reject below-schedule notes without grounded schedule placement", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            schedule: {
              name: "Operator Ungrounded Schedule Note Layout",
              category: "OST_MechanicalEquipment",
              fields: ["Family and Type", "Mark"]
            },
            configureSchedule: {
              filters: [
                {
                  field: "Mark",
                  op: "begins_with",
                  value: "VAV-1-"
                }
              ]
            },
            textNote: {
              placeBelowSchedule: true,
              text: "NOTE 1: PROVIDE ACCESS CLEARANCE."
            }
          }
        }
      }
    }, "documentation-schedule-note.json"),
    /invalid documentation primitive inputs.*textNote\.placeBelowSchedule requires grounded schedule sheet placement/is
  );
});

test("Revit workflow overrides accept bounded batch schedule layout requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            scheduleSheetLayout: {
              sheetId: 1420963,
              avoidOverlap: true
            },
            schedules: [
              {
                name: "Operator Layout Schedule 1",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Mark"]
              },
              {
                name: "Operator Layout Schedule 2",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Count"]
              }
            ]
          }
        }
      }
    }, "documentation-schedule-layout.json")
  );
});

test("Revit workflow overrides accept bounded existing schedule reflow requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            scheduleSheetLayout: {
              sheetId: 1420963,
              avoidOverlap: true,
              reflowExisting: true,
              reflowPlacements: [{ x: 1, y: 6.5 }]
            },
            schedules: [
              {
                name: "Operator Layout Schedule 1",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Mark"],
                placement: { x: 1, y: 8 }
              }
            ]
          }
        }
      }
    }, "documentation-schedule-reflow.json")
  );
});

test("Revit workflow overrides accept bounded schedule remove-from-sheet requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            scheduleSheetLayout: {
              sheetId: 1420963,
              avoidOverlap: true,
              removeFromSheetAfterPlace: true
            },
            schedules: [
              {
                name: "Operator Layout Schedule 1",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Mark"],
                placement: { x: 1, y: 8 }
              }
            ]
          }
        }
      }
    }, "documentation-schedule-remove-from-sheet.json")
  );
});

test("Revit workflow overrides reject reflow requests without a target placement", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            scheduleSheetLayout: {
              sheetId: 1420963,
              reflowExisting: true
            },
            schedules: [
              {
                name: "Operator Layout Schedule 1",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Mark"]
              }
            ]
          }
        }
      }
    }, "documentation-schedule-reflow.json"),
    /invalid documentation primitive inputs.*scheduleSheetLayout\.reflowExisting requires reflowPlacements or per-schedule reflowPlacement/is
  );
});

test("Revit workflow overrides reject ungrounded batch schedule layout requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 1420963,
            visualViewId: 1420963,
            visualVerify: true,
            cleanupCreatedElements: true,
            scheduleSheetLayout: {
              avoidOverlap: true
            },
            schedules: [
              {
                name: "Operator Layout Schedule 1",
                category: "OST_MechanicalEquipment",
                fields: ["Family and Type", "Mark"]
              },
              {
                category: "OST_MechanicalEquipment",
                fields: []
              }
            ]
          }
        }
      }
    }, "documentation-schedule-layout.json"),
    /invalid documentation primitive inputs.*scheduleSheetLayout requires sheetId or sheetNumber.*schedules\[1\]\.name.*schedules\[1\]\.fields/is
  );
});

test("Revit workflow overrides require linked readback/revert and phase readback flags", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            linkedModelCategoryVisibility: {
              linkedModelName: "Snowdon Towers Sample Architectural.rvt",
              categoryName: "Plumbing Fixtures",
              lineWeight: 5
            },
            phaseVisibility: {
              phaseName: "New Construction",
              phaseFilterName: "Show Complete"
            }
          }
        }
      }
    }, "documentation.json"),
    /invalid documentation primitive inputs.*linkedModelCategoryVisibility\.readbackRequired.*linkedModelCategoryVisibility\.revertAfterVerify.*phaseVisibility\.readbackRequired.*phaseVisibility\.revertAfterVerify.*phaseVisibility\.originalPhaseName.*phaseVisibility\.originalPhaseFilterName/is
  );
});

test("Revit workflow overrides require filter graphics revert evidence", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            filterVisibility: {
              filterName: "Operator Verified Future Work",
              lineWeight: 5
            }
          }
        }
      }
    }, "documentation.json"),
    /invalid documentation primitive inputs.*filterVisibility must include existing filterId.*filterVisibility\.readbackRequired.*filterVisibility\.revertAfterVerify/is
  );
});

test("Revit workflow overrides reject ElementId view-filter parameters without typed values", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            filterVisibility: {
              filterName: "Operator Verified Future Work",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true,
              createFilter: {
                categoryName: "Ducts",
                ruleParameterName: "System Type",
                ruleOperator: "contains",
                ruleValue: "Supply"
              }
            }
          }
        }
      }
    }, "documentation-filter-system-type.json"),
    /invalid documentation primitive inputs.*ruleParameterStorageType must be element_id.*ruleValueElementId or numeric ruleValue/is
  );
});

test("Revit workflow overrides accept ElementId view-filter value id without duplicate ruleValue", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            filterVisibility: {
              filterName: "Operator Verified System Filter",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true,
              createFilter: {
                categoryName: "Ducts",
                ruleParameterName: "System Type",
                ruleParameterStorageType: "element_id",
                ruleOperator: "equals",
                ruleValueElementId: 12345
              }
            }
          }
        }
      }
    }, "documentation-filter-system-type-value-id.json")
  );
});

test("Revit workflow overrides reject decimal and text-operator ElementId view-filter values", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            filterVisibility: {
              filterName: "Operator Verified System Filter",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true,
              createFilter: {
                categoryName: "Ducts",
                ruleParameterName: "System Type",
                ruleParameterStorageType: "element_id",
                ruleOperator: "contains",
                ruleValue: 123.45
              }
            }
          }
        }
      }
    }, "documentation-filter-system-type-decimal.json"),
    /invalid documentation primitive inputs.*ruleValueElementId or numeric ruleValue.*ruleOperator must be equals or not_equals/is
  );
});

test("Revit workflow overrides accept bounded existing view-filter graphics", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_documentation_primitives: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            visualVerify: true,
            cleanupCreatedElements: true,
            filterVisibility: {
              filterId: 9101,
              filterName: "Operator Verified Future Work",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true
            }
          }
        }
      }
    }, "documentation-filter.json")
  );
});

test("Revit workflow overrides reject incomplete MEP tap branch requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_tap_branch: {
          request: {
            viewId: 4001,
            mainElementId: 1542001,
            branchPoints: [{ x: 52, y: 27 }],
            branchSize: "14x4",
            apply: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "tap-branch.json"),
    /invalid MEP tap\/branch inputs.*visualViewId.*projectedTapPoint.*branchPoints.*verify/is
  );
});

test("Revit workflow overrides accept bounded MEP tap branch requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_pipe_tap_branch: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            mainElementId: 1642001,
            projectedTapPoint: { x: 58, y: 22 },
            branchPoints: [{ x: 58, y: 22 }, { x: 58, y: 30 }],
            pipeSize: "1\"",
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "tap-branch.json")
  );
});

test("Revit workflow overrides reject incomplete MEP reroute requests", async () => {
  assert.throws(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_reroute: {
          request: {
            viewId: 4001,
            hostElementId: 1542919,
            split1Point: { x: 76, y: -35 },
            apply: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "reroute.json"),
    /invalid MEP reroute inputs.*visualViewId.*splitPoints.*dropFt.*verify/is
  );
});

test("Revit workflow overrides accept bounded MEP reroute requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_pipe_reroute: {
          request: {
            viewId: 4001,
            visualViewId: 4001,
            hostElementId: 1642919,
            splitPoints: [{ x: 64, y: 18 }, { x: 72, y: 18 }],
            offsetVector: { x: 0, y: 0, z: -1 },
            apply: true,
            verifyConnectorNetwork: true,
            visualVerify: true,
            cleanupCreatedElements: true
          }
        }
      }
    }, "reroute.json")
  );
});

test("Revit workflow overrides accept disposable-host MEP reroute requests", async () => {
  assert.doesNotThrow(
    () => assertRunnableRevitWorkflowOverride({
      tasks: {
        demo_redline_mep_duct_reroute: {
          request: {
            viewId: 1363433,
            visualViewId: 1363433,
            split1Point: { x: 76, y: -110 },
            split2Point: { x: 88, y: -110 },
            dropFt: 1,
            apply: true,
            verify: true,
            visualVerify: true,
            cleanupCreatedElements: true,
            createHostRoute: {
              ductSize: "12x10",
              points: [{ x: 70, y: -110, z: 43 }, { x: 94, y: -110, z: 43 }]
            }
          }
        }
      }
    }, "reroute.json")
  );
});

test("deterministic Revit workflow run fails before using unfilled corpus override", async () => {
  const original = process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
  const bundle = loadBenchmarkConfigBundle();
  const tasks = loadBenchmarkTasks();
  const config = getConfigById(bundle, "deterministic_skill_only");
  const task = getTaskById("demo_takeoff_receptacles", tasks);
  const batchDir = tempDir("deterministic-revit-unfilled-corpus-overrides");
  const overridePath = path.join(batchDir, "redline_corpus_live_request_template.json");
  fs.writeFileSync(
    overridePath,
    JSON.stringify({
      schema_version: 1,
      status: "template_requires_verified_revit_ids",
      ready_to_run: false,
      placeholder_count: 1,
      placeholder_task_count: 1,
      tasks: {
        demo_takeoff_receptacles: {
          request: { filters: { keywords_include: ["__FILL_KEYWORD__"] } },
          placeholder_paths: ["request.filters.keywords_include[0]"]
        }
      }
    }),
    "utf8"
  );

  try {
    process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = overridePath;
    const run = await runSingleBenchmark(
      task,
      config,
      {
        batch_id: "test_batch",
        batch_dir: batchDir,
        repeat_index: 1
      },
      new FakeModelClient([])
    );

    assert.equal(run.success_label, "fail");
    assert.match(run.termination_reason, /not runnable/i);
    assert.match(run.termination_reason, /placeholder_count=1/);
    assert.equal(run.total_executor_calls, 0);
  } finally {
    if (original === undefined) delete process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON;
    else process.env.OPERATOR_BENCHMARK_REVIT_REQUESTS_JSON = original;
  }
});
