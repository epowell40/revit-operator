import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { loadBenchmarkTasks } from "../src/benchmark/tasks.js";
import { MockBridgeTransport, runRevitDemoWorkflow } from "../src/benchmark/revit_workflows.js";

function tempDir(name: string): string {
  const dir = path.join(process.cwd(), "local-work", "aec-mep-eval-tests", name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const AEC_MEP_TASK_IDS = [
  "aec_mep_duct_route_vector_pdf",
  "aec_mep_pipe_route_labeled_redline",
  "aec_mep_duct_callout_existing_model",
  "aec_mep_wrong_bay_false_positive",
  "aec_mep_connected_duct_resize",
  "aec_mep_branch_tee_tap_feasibility"
];

test("AEC-MEP eval V1 task fixtures replay through the existing benchmark workflow adapter", async () => {
  const tasks = loadBenchmarkTasks();
  for (const taskId of AEC_MEP_TASK_IDS) {
    const task = tasks.find((entry) => entry.task_id === taskId);
    assert.ok(task, `missing task ${taskId}`);
    const result = await runRevitDemoWorkflow(task.adapter_config as any, tempDir(taskId));

    assert.equal(result.workflow, "aec_mep_eval", taskId);
    assert.equal(result.success, true, `${taskId}: ${result.failure_reason ?? ""}`);
    assert.equal(result.failure_classification ?? null, null, taskId);
    assert.ok(result.verification_results.length > 0, taskId);
    assert.ok(fs.existsSync(result.output_artifacts[0] ?? ""), `${taskId} summary json exists`);
    assert.ok(fs.existsSync(result.output_artifacts[1] ?? ""), `${taskId} summary md exists`);
  }
});

test("AEC-MEP route replay classifies endpoint mismatch failures", async () => {
  const dir = tempDir("route-mismatch");
  const result = await runRevitDemoWorkflow(
    {
      workflow: "aec_mep_eval",
      request: {
        scenarioId: "route_mismatch",
        scenarioKind: "duct_route_redline_vector_pdf",
        redline: {
          source: "vector_pdf_geometry",
          geometryRole: "target_path",
          verticesNorm: [
            { x: 0.3, y: 0.4 },
            { x: 0.7, y: 0.4 }
          ]
        },
        route: {
          kind: "duct",
          ductSize: "12x10",
          apply: true,
          visualVerify: true,
          points: [
            { x: 40, y: 27 },
            { x: 58, y: 27 }
          ]
        },
        expected: {
          kind: "duct",
          size: "12x10",
          minCreatedElementCount: 1,
          maxEndpointErrorFt: 1,
          requiresPostChangeCapture: true
        }
      }
    },
    dir,
    new MockBridgeTransport({
      "/revit/mep-route-workflow": {
        status: "AppliedVisualVerificationReady",
        applyResult: {
          status: "CreatedWithOpenConnectors",
          plannedPoints: [
            { x: 40, y: 39 },
            { x: 58, y: 39 }
          ],
          chosenSize: { requested: "12x10", applied: "12x10" },
          createdElementIds: [1542929],
          openConnectorCount: 2
        },
        visualVerification: {
          status: "CaptureReadyForAIReview",
          capturePath: "artifacts/aec-mep/wrong-route-after.jpg"
        }
      }
    })
  );

  assert.equal(result.success, false);
  assert.equal(result.failure_classification, "route_geometry_mismatch");
  assert.equal(result.verification_results.some((entry) => entry.name === "route_endpoint_error_within_tolerance" && !entry.ok), true);
  assert.ok(fs.existsSync(result.output_artifacts[0] ?? ""));
});
