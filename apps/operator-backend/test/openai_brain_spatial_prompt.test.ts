import assert from "node:assert/strict";
import test from "node:test";
import { __testOnlyBuildPromptForRequest } from "../src/brains/openai_brain.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest } from "../src/contracts.js";
import { compactIncomingToolResult } from "../src/tool_result_compaction.js";

function spatialItems(): unknown[] {
  const physical = Array.from({ length: 66 }, (_, index) => ({
    elementId: 1000 + index,
    category: "Pipe Fittings",
    builtInCategory: "OST_PipeFitting",
    name: `Device ${index}`,
    levelName: "LEVEL 02",
    superComponentId: null,
    topLevelParentId: null,
    isNested: false,
    spatialContext: {
      status: "resolved",
      spatialKindPreference: "room",
      method: "point_in_boundary",
      selected: {
        spatialKind: "Room",
        number: `R-${index}`,
        name: `Room ${index}`,
        spatialId: 5000 + index,
        sourceScopedId: `77:${5000 + index}`,
        sourceScope: "linked",
        linkInstanceId: 77,
        linkInstanceName: "Architectural",
        sourceDocumentTitle: "Architecture",
        phaseId: 3,
        phaseName: "New Construction",
        method: "point_in_boundary",
        boundaryDistanceFt: 1.25,
        equivalentSourceIds: [`77:${5000 + index}`]
      },
      matches: [],
      nearestCandidates: []
    }
  }));
  const nested = Array.from({ length: 66 }, (_, index) => ({
    elementId: 2000 + index,
    category: "Center line",
    builtInCategory: "OST_PipeFitting",
    name: `Nested ${index}`,
    levelName: "LEVEL 02",
    superComponentId: 1000 + index,
    topLevelParentId: 1000 + index,
    isNested: true,
    spatialContext: {
      status: "resolved",
      spatialKindPreference: "room",
      method: "point_in_boundary",
      selected: {
        spatialKind: "Room",
        number: `R-${index}`,
        spatialId: 5000 + index,
        sourceScopedId: `77:${5000 + index}`,
        sourceScope: "linked",
        phaseId: 3,
        phaseName: "New Construction",
        method: "point_in_boundary"
      },
      matches: [],
      nearestCandidates: []
    }
  }));
  return [...physical, ...nested];
}

for (const contextDiet of [true, false]) {
  test(`spatial prompt preserves all physical and nested locate rows with context diet ${contextDiet}`, async () => {
    const req: ChatRequest = {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      session_id: `spatial-prompt-${contextDiet}`,
      message_id: "continuation",
      user_text: "",
      context: {
        ui: {
          speed_settings: {
            speed_mode: true,
            context_diet: contextDiet,
            verbose_tool_results: !contextDiet
          }
        }
      },
      tool_results: [
        {
          action_id: "prior-large-result",
          method: "POST",
          path: "/revit/get-parameters",
          status: "done",
          result_json: { noise: "x".repeat(20_000) }
        },
        {
          action_id: "spatial-all-devices",
          method: "POST",
          path: "/revit/locate-elements",
          status: "done",
          result_json: {
            status: "Ok",
            count: 132,
            spatialResolution: "geometry_with_nearest",
            items: spatialItems(),
            warnings: []
          }
        }
      ]
    };

    const prompt = await __testOnlyBuildPromptForRequest(req);
    const spatialBlock = prompt.split("Spatial locate results (complete bounded per-instance JSON; do not drop tail devices):")[1] ?? "";
    assert.match(spatialBlock, /"elementId":\s*1000/);
    assert.match(spatialBlock, /"elementId":\s*1065/);
    assert.match(spatialBlock, /"elementId":\s*2000/);
    assert.match(spatialBlock, /"elementId":\s*2065/);
    assert.match(spatialBlock, /"number":\s*"R-65"/);
    assert.match(spatialBlock, /"isNested":\s*true/);
    assert.doesNotMatch(spatialBlock, /…\(truncated\)|"_truncated": true/);
  });
}

test("spatial prompt uses valid explicit omission metadata when its character budget is exceeded", async () => {
  const oversizedItems = Array.from({ length: 500 }, (_, index) => ({
    elementId: 5000 + index,
    category: "Mechanical Equipment",
    name: `Oversized device ${index} ${"x".repeat(1400)}`,
    spatialContext: {
      status: "resolved",
      method: "point_in_boundary",
      selected: {
        spatialKind: "Room",
        number: `R-${index}`,
        spatialId: 8000 + index,
        sourceScope: "linked",
        sourceScopedId: `77:${8000 + index}`
      },
      matches: [],
      nearestCandidates: []
    }
  }));
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "spatial-prompt-budget",
    message_id: "continuation",
    user_text: "",
    tool_results: [{
      action_id: "spatial-oversized",
      method: "POST",
      path: "/revit/locate-elements",
      status: "done",
      result_json: {
        status: "Ok",
        count: oversizedItems.length,
        spatialResolution: "geometry_with_nearest",
        items: oversizedItems,
        warnings: []
      }
    }]
  };

  const prompt = await __testOnlyBuildPromptForRequest(req);
  const marker = "Spatial locate results (explicitly incomplete bounded JSON; honor omission metadata and issue focused follow-up batches before claiming completeness):";
  const spatialBlock = (prompt.split(marker)[1] ?? "").trim();
  const receipt = JSON.parse(spatialBlock);
  assert.equal(receipt.promptComplete, false);
  assert.equal(receipt.followUpRequired, true);
  assert.ok(receipt.promptItemsOmitted > 0);
  assert.ok(receipt.promptItemsReturned > 0);
  assert.doesNotMatch(spatialBlock, /…\(truncated\)|"_truncated": true/);
});

test("normalized then projected spatial results retain every inherited omission category", async () => {
  const rawItems = Array.from({ length: 501 }, (_, index) => ({
    elementId: 9000 + index,
    category: "Pipe Accessories",
    name: `Device ${index}`,
    spatialContext: index === 0 ? {
      status: "unresolved",
      method: "none",
      selected: {
        spatialKind: "Room",
        number: "401",
        equivalentSourceIds: Array.from({ length: 21 }, (_, sourceIndex) => `selected-${sourceIndex}`)
      },
      matches: [],
      nearestCandidates: Array.from({ length: 21 }, (_, candidateIndex) => ({
        spatialKind: "Room",
        number: `N-${candidateIndex}`,
        equivalentSourceIds: Array.from({ length: 21 }, (_, sourceIndex) => `nearest-${candidateIndex}-${sourceIndex}`)
      }))
    } : { status: "resolved", selected: null, matches: [], nearestCandidates: [] }
  }));
  const normalized = compactIncomingToolResult({
    action_id: "spatial-normalized",
    method: "POST",
    path: "/revit/locate-elements",
    status: "done",
    result_json: {
      status: "Ok",
      count: rawItems.length,
      spatialResolution: "geometry_with_nearest",
      items: rawItems
    }
  });
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "spatial-normalize-project",
    message_id: "continuation",
    user_text: "",
    tool_results: [normalized]
  };

  const prompt = await __testOnlyBuildPromptForRequest(req);
  const marker = "Spatial locate results (explicitly incomplete bounded JSON; honor omission metadata and issue focused follow-up batches before claiming completeness):";
  const receipt = JSON.parse((prompt.split(marker)[1] ?? "").trim());
  assert.equal(receipt.promptComplete, false);
  assert.equal(receipt.followUpRequired, true);
  assert.equal(receipt.sourceItemsOmitted, 1);
  assert.ok(receipt.candidateEntriesOmitted >= 22);
});

test("explicit source incompleteness requires follow-up even without numeric omissions or truncation", async () => {
  const normalized = compactIncomingToolResult({
    action_id: "spatial-explicit-incomplete",
    method: "POST",
    path: "/revit/locate-elements",
    status: "done",
    result_json: {
      status: "Ok",
      count: 1,
      spatialResolution: "geometry",
      items: [{
        elementId: 42,
        spatialContext: { status: "unresolved", selected: null, matches: [], nearestCandidates: [] }
      }],
      itemsOmitted: 0,
      itemsComplete: false,
      truncated: false
    }
  });
  const req: ChatRequest = {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    session_id: "spatial-explicit-incomplete",
    message_id: "continuation",
    user_text: "",
    tool_results: [normalized]
  };

  const prompt = await __testOnlyBuildPromptForRequest(req);
  const marker = "Spatial locate results (explicitly incomplete bounded JSON; honor omission metadata and issue focused follow-up batches before claiming completeness):";
  const receipt = JSON.parse((prompt.split(marker)[1] ?? "").trim());
  assert.equal(receipt.sourceItemsOmitted, 0);
  assert.equal(receipt.sourceTruncatedResults, 0);
  assert.equal(receipt.sourceIncompleteResults, 1);
  assert.equal(receipt.promptComplete, false);
  assert.equal(receipt.followUpRequired, true);
});
