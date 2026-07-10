import test from "node:test";
import assert from "node:assert/strict";
import { requiredLiveRevitEndpointPaths, selectedTasksNeedLiveRevitPreflight, selectedTasksRequireWriteGrant, textNoteReplaceDryRunProbeRequest } from "../src/benchmark/revit_live_guard.js";
import type { BenchmarkTaskDefinition } from "../src/benchmark/types.js";

function task(taskId: string, adapterId: string, adapterConfig: Record<string, unknown> = {}): BenchmarkTaskDefinition {
  return {
    schema_version: 1,
    task_id: taskId,
    name: taskId,
    description: taskId,
    environment: { adapter_id: adapterId },
    setup_instructions: [],
    success_criteria: [],
    failure_criteria: [],
    max_time_seconds: 30,
    max_steps: 1,
    requires_manual_grade: false,
    grader_notes: [],
    tags: [],
    optional_cleanup_steps: [],
    adapter_config: adapterConfig
  };
}

test("live Revit guard skips mocked Revit workflow tasks by default", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow", { mock: { "/revit/quantify": {} } })]
    }),
    false
  );
});

test("live Revit guard runs when mocks are explicitly disabled", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow", { mock: { "/revit/quantify": {} } })],
      useMocksEnv: "0"
    }),
    true
  );
});

test("live Revit guard runs for Revit workflow tasks without mocks", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["demo_takeoff"],
      allTasks: [task("demo_takeoff", "revit_workflow")]
    }),
    true
  );
});

test("live Revit guard ignores non-Revit workflow tasks", () => {
  assert.equal(
    selectedTasksNeedLiveRevitPreflight({
      taskIds: ["scripted"],
      allTasks: [task("scripted", "scripted_demo")],
      useMocksEnv: "0"
    }),
    false
  );
});

test("live Revit guard derives required CAD documentation endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks: [
        task("demo_documentation_primitives", "revit_workflow", {
          workflow: "documentation_primitives",
          request: {
            cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg" },
            cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 }
          }
        })
      ]
    }),
    ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  );
});

test("live Revit guard derives CAD endpoints from local request overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks: [
        task("demo_documentation_primitives", "revit_workflow", {
          workflow: "documentation_primitives",
          request: { textNote: { text: "base docs task" } }
        })
      ],
      requestOverridesByTaskId: {
        demo_documentation_primitives: {
          request: {
            cadLink: { sourcePath: "artifacts/cad/Snowdon-M104-Plan-HVAC-L4.dwg" },
            cadGraphicsOverride: { layerOrSubcategoryName: "M104-FUTURE", lineWeight: 5 }
          }
        }
      }
    }),
    ["/revit/context", "/revit/export-image", "/revit/link-cad", "/revit/visibility"]
  );
});

test("live Revit guard derives active-project TextNote replacement endpoints and probe body", () => {
  const allTasks = [
    task("demo_documentation_primitives", "revit_workflow", {
      workflow: "documentation_primitives",
      request: { textNote: { text: "base docs task" } }
    })
  ];
  const requestOverridesByTaskId = {
    demo_documentation_primitives: {
      request: {
        textNote: {
          editExisting: true,
          textNoteId: 1422186,
          viewId: 32,
          expectedExistingText: "Electrical Transformer Pad",
          text: "Electrical Transformer Pad - VERIFIED"
        }
      }
    }
  };

  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks,
      requestOverridesByTaskId
    }),
    ["/revit/context", "/revit/export-image", "/revit/find-text-notes", "/revit/replace-text-note"]
  );
  assert.deepEqual(
    textNoteReplaceDryRunProbeRequest({
      taskIds: ["demo_documentation_primitives"],
      allTasks,
      requestOverridesByTaskId
    }),
    {
      elementId: 1422186,
      newText: "Electrical Transformer Pad - VERIFIED",
      dryRun: true,
      apply: false
    }
  );
});

test("live Revit guard derives existing tag value edit endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks: [
        task("demo_documentation_primitives", "revit_workflow", {
          workflow: "documentation_primitives",
          request: { tag: { elementIds: [301] } }
        })
      ],
      requestOverridesByTaskId: {
        demo_documentation_primitives: {
          request: {
            tag: {
              editExistingValue: true,
              viewId: 32,
              existingTagIds: [1411236],
              elementIds: [1411195],
              valueSourceParameterName: "Number",
              expectedExistingValue: "100",
              requestedTagValueHint: "100X",
              readbackRequired: true,
              revertAfterVerify: true
            },
            visualVerify: true
          }
        }
      }
    }),
    ["/revit/context", "/revit/export-image", "/revit/export-visible-elements", "/revit/get-parameters", "/revit/set-parameter"]
  );
});

test("live Revit guard derives schedule edit endpoints from replacement overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks: [
        task("demo_documentation_primitives", "revit_workflow", {
          workflow: "documentation_primitives",
          request: {
            cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg" },
            tag: { elementIds: [301] }
          }
        })
      ],
      requestOverridesByTaskId: {
        demo_documentation_primitives: {
          request: {
            replaceBaseRequest: true,
            viewId: 1422218,
            visualViewId: 1422218,
            schedule: {
              editExistingValue: true,
              scheduleId: 1422218,
              elementId: 1422594,
              rowKey: "101",
              parameterName: "Name",
              expectedExistingValue: "Cafe",
              replacementValue: "Cafe - Verified"
            }
          }
        }
      }
    }),
    ["/revit/context", "/revit/export-image", "/revit/export-schedule-csv", "/revit/get-parameters", "/revit/set-parameter"]
  );
});

test("live Revit guard narrows documentation endpoints for graphics-only overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_documentation_primitives"],
      allTasks: [
        task("demo_documentation_primitives", "revit_workflow", {
          workflow: "documentation_primitives",
          request: {
            cadLink: { sourcePath: "benchmark/fixtures/cad/operator-demo-keyplan.dwg" },
            tag: { elementIds: [301] }
          }
        })
      ],
      requestOverridesByTaskId: {
        demo_documentation_primitives: {
          request: {
            graphicsOnly: true,
            viewId: 8251,
            visualViewId: 8251,
            categoryVisibility: {
              action: "set_category_override",
              viewId: 8251,
              categoryName: "Lines",
              lineWeight: 5,
              readbackRequired: true,
              revertAfterVerify: true
            }
          }
        }
      }
    }),
    ["/revit/context", "/revit/export-image", "/revit/visibility"]
  );
});

test("live Revit guard requires write grants for mutating redline move workflows", () => {
  assert.equal(
    selectedTasksRequireWriteGrant({
      taskIds: ["demo_redline_move_tag"],
      allTasks: [
        task("demo_redline_move_tag", "revit_workflow", {
          workflow: "redline_move",
          request: {
            targetKind: "tag",
            tag: { elementIds: [1366896] },
            move: { vectorX: 1, vectorY: 0, vectorZ: 0 }
          }
        })
      ]
    }),
    true
  );
});

test("live Revit guard derives move-tag readback and move endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_move_tag"],
      allTasks: [
        task("demo_redline_move_tag", "revit_workflow", {
          workflow: "redline_move",
          request: {
            targetKind: "tag",
            tag: { existingTagIds: [1411245], readbackRequired: true },
            existingTarget: { moveExisting: true, elementIds: [1411245] },
            move: { vectorX: 0, vectorY: 8.35, vectorZ: 0 },
            revertAfterVerify: true
          }
        })
      ]
    }),
    ["/revit/context", "/revit/export-visible-elements", "/revit/move-elements"]
  );
});

test("live Revit guard derives type-change apply and visual endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_type_change_duct"],
      allTasks: [
        task("demo_redline_type_change_duct", "revit_workflow", {
          workflow: "redline_type_change",
          request: {
            elementIds: [1464225],
            category: "OST_DuctCurves",
            targetTypeId: 139185,
            sourceTypeGrounding: { expectedCurrentTypeId: 139186 },
            visualVerify: true,
            revertAfterVerify: true
          }
        })
      ]
    }),
    ["/revit/change-element-type", "/revit/context", "/revit/export-image"]
  );
});

test("live Revit guard does not require write grants for read-only takeoff workflows", () => {
  assert.equal(
    selectedTasksRequireWriteGrant({
      taskIds: ["demo_takeoff"],
      allTasks: [
        task("demo_takeoff", "revit_workflow", {
          workflow: "takeoff_csv",
          request: { categories: ["OST_MechanicalEquipment"] }
        })
      ]
    }),
    false
  );
});

test("live Revit guard derives MEP size-transition endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_mep_duct_size_transition"],
      allTasks: [
        task("demo_redline_mep_duct_size_transition", "revit_workflow", {
          workflow: "redline_mep_size_transition",
          request: {
            hostElementId: 1542001,
            transitionPoint: { x: 52, y: 27 },
            cleanupCreatedElements: true
          }
        })
      ]
    }),
    ["/revit/context", "/revit/delete", "/revit/reroute-mep-route-segment"]
  );
});

test("live Revit guard derives MEP route creation endpoints", () => {
  for (const taskId of ["demo_redline_mep_route", "demo_redline_mep_pipe_route"]) {
    assert.deepEqual(
      requiredLiveRevitEndpointPaths({
        taskIds: [taskId],
        allTasks: [
          task(taskId, "revit_workflow", {
            workflow: "redline_mep_route",
            request: {
              kind: taskId.includes("_pipe_") ? "pipe" : "duct",
              points: [{ x: 40, y: 27 }, { x: 58, y: 27 }],
              apply: true,
              cleanupCreatedElements: true
            }
          })
        ]
      }),
      ["/revit/context", "/revit/delete", "/revit/mep-route-workflow"]
    );
  }
});

test("live Revit guard derives add-tag endpoints and cleanup dependency", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_add_tag"],
      allTasks: [
        task("demo_redline_add_tag", "revit_workflow", {
          workflow: "redline_add",
          request: {
            targetKind: "tag",
            cleanupCreatedElements: true,
            tag: {
              viewId: 32,
              elementIds: [1411195],
              tagTypeName: "Space Tag"
            }
          }
        })
      ]
    }),
    ["/revit/context", "/revit/delete", "/revit/tag-elements"]
  );
});

test("live Revit guard derives disposable delete-tag endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_delete_tag"],
      allTasks: [
        task("demo_redline_delete_tag", "revit_workflow", {
          workflow: "redline_delete",
          request: {
            targetKind: "tag",
            tag: {
              viewId: 32,
              elementIds: [1411195],
              tagTypeName: "Space Tag"
            }
          }
        })
      ]
    }),
    ["/revit/context", "/revit/delete", "/revit/export-visible-elements", "/revit/tag-elements"]
  );
});

test("live Revit guard derives disposable MEP route delete endpoints", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_delete_pipe_route"],
      allTasks: [
        task("demo_redline_delete_pipe_route", "revit_workflow", {
          workflow: "redline_delete",
          request: {
            targetKind: "pipe_route",
            kind: "pipe",
            viewId: 1363433,
            cleanupCreatedElements: true
          }
        })
      ]
    }),
    ["/revit/context", "/revit/delete", "/revit/export-visible-elements", "/revit/mep-route-workflow"]
  );
});

test("live Revit guard does not create disposable route for existing route delete preflight", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_delete_pipe_route"],
      allTasks: [
        task("demo_redline_delete_pipe_route", "revit_workflow", {
          workflow: "redline_delete",
          request: {
            targetKind: "pipe_route",
            viewId: 1363433,
            existingTarget: {
              elementIds: [1542001],
              deleteExisting: true
            }
          }
        })
      ]
    }),
    ["/revit/context", "/revit/delete", "/revit/export-visible-elements"]
  );
});

test("live Revit guard derives disposable setup endpoints for MEP size-transition overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_mep_pipe_size_transition"],
      allTasks: [
        task("demo_redline_mep_pipe_size_transition", "revit_workflow", {
          workflow: "redline_mep_size_transition",
          request: {
            cleanupCreatedElements: true
          }
        })
      ],
      requestOverridesByTaskId: {
        demo_redline_mep_pipe_size_transition: {
          request: {
            createHostRoute: {
              pipeSize: "1 inch",
              points: [{ x: 70, y: -76 }, { x: 94, y: -76 }]
            }
          }
        }
      }
    }),
    ["/revit/context", "/revit/create-mep-route", "/revit/delete", "/revit/reroute-mep-route-segment"]
  );
});

test("live Revit guard derives MEP tap branch endpoints", () => {
  for (const taskId of ["demo_redline_mep_duct_tap_branch", "demo_redline_mep_pipe_tap_branch"]) {
    assert.deepEqual(
      requiredLiveRevitEndpointPaths({
        taskIds: [taskId],
        allTasks: [
          task(taskId, "revit_workflow", {
            workflow: "redline_mep_tap_branch",
            request: {
              mainElementId: 1542001,
              projectedTapPoint: { x: 52, y: 27 },
              branchPoints: [{ x: 52, y: 27 }, { x: 52, y: 35 }],
              cleanupCreatedElements: true
            }
          })
        ]
      }),
      ["/revit/connect-mep-branch", "/revit/context", "/revit/delete"]
    );
  }
});

test("live Revit guard derives branch-network endpoint for disposable tap branch overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_mep_pipe_tap_branch"],
      allTasks: [
        task("demo_redline_mep_pipe_tap_branch", "revit_workflow", {
          workflow: "redline_mep_tap_branch",
          request: {
            cleanupCreatedElements: true
          }
        })
      ],
      requestOverridesByTaskId: {
        demo_redline_mep_pipe_tap_branch: {
          request: {
            branchNetworkWorkflow: true,
            mainPoints: [{ x: 90, y: -82 }, { x: 105, y: -82 }]
          }
        }
      }
    }),
    ["/revit/context", "/revit/delete", "/revit/mep-branch-network-workflow"]
  );
});

test("live Revit guard derives MEP reroute endpoints", () => {
  for (const taskId of ["demo_redline_mep_duct_reroute", "demo_redline_mep_pipe_reroute"]) {
    assert.deepEqual(
      requiredLiveRevitEndpointPaths({
        taskIds: [taskId],
        allTasks: [
          task(taskId, "revit_workflow", {
            workflow: "redline_mep_reroute",
            request: {
              hostElementId: 1542919,
              split1ChainageFt: 6,
              split2ChainageFt: 18,
              dropFt: 1,
              cleanupCreatedElements: true
            }
          })
        ]
      }),
      ["/revit/context", "/revit/delete", "/revit/reroute-mep-route-segment"]
    );
  }
});

test("live Revit guard derives disposable setup endpoints for MEP reroute overrides", () => {
  assert.deepEqual(
    requiredLiveRevitEndpointPaths({
      taskIds: ["demo_redline_mep_duct_reroute"],
      allTasks: [
        task("demo_redline_mep_duct_reroute", "revit_workflow", {
          workflow: "redline_mep_reroute",
          request: {
            cleanupCreatedElements: true
          }
        })
      ],
      requestOverridesByTaskId: {
        demo_redline_mep_duct_reroute: {
          request: {
            createHostRoute: {
              ductType: "Rectangular Duct",
              ductSize: "12x10",
              points: [{ x: 70, y: -35, z: 43 }, { x: 94, y: -35, z: 43 }]
            }
          }
        }
      }
    }),
    ["/revit/context", "/revit/create-mep-route", "/revit/delete", "/revit/reroute-mep-route-segment"]
  );
});
