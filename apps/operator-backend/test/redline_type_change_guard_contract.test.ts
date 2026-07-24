import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRedlineTypeChangeLiveAdapterReadiness } from "../src/redline/type_change_live_adapter_contract.js";

test("type-change live adapter guards apply and revert with expected old types", () => {
  const readiness = evaluateRedlineTypeChangeLiveAdapterReadiness(
    {
      operation: "type_change",
      target: "duct",
      elementIds: [9501],
      category: "OST_DuctCurves",
      visualViewId: 101,
      targetTypeId: 9602,
      sourceTypeGrounding: { expectedCurrentTypeId: 9601 }
    },
    {
      elementIds: [9501],
      category: "OST_DuctCurves",
      visualViewId: 101,
      currentTypeId: 9601,
      targetTypeId: 9602,
      dryRunPreflightReviewed: true,
      targetTypeCompatibilityReviewed: true,
      dryRunChangedIds: [9501],
      appliedChangedIds: [9501],
      readbackTypeId: 9602,
      postChangeCapturePath: "artifacts/captures/type-change-duct-after.png",
      postChangeCaptureViewId: 101,
      revertDryRunIds: [9501],
      revertedIds: [9501],
      finalTypeId: 9601,
      summaryArtifactPath: "artifacts/redline_type_change_summary.json"
    }
  );

  const apply = readiness.adapter_operations.find(operation => operation.purpose === "type_change_apply");
  const revert = readiness.adapter_operations.find(operation => operation.purpose === "revert_apply");
  assert.deepEqual((apply?.request as any).elementIds, [9501]);
  assert.equal((apply?.request as any).ids, undefined);
  assert.deepEqual((revert?.request as any).elementIds, [9501]);
  assert.deepEqual((apply?.request as any).expectedOldTypes, [{ elementId: 9501, typeId: 9601 }]);
  assert.deepEqual((revert?.request as any).expectedOldTypes, [{ elementId: 9501, typeId: 9602 }]);
});
