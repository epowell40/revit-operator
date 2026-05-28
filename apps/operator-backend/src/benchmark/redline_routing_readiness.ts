import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  __testOnlyBuildRedlineExecutionBridge,
  __testOnlyBuildRedlineExecutionBridgeAsync,
  __testOnlyBuildSpatialPlacementPreviewPlan,
  __testOnlyBuildSpatialRedlineRefinementBridge
} from "../brains/openai_brain.js";
import type { ChatResponse, ToolResult, UserAttachment } from "../contracts.js";
import { compactVisibleElementsResult } from "../tool_result_compaction.js";

const RED_MARK_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAAAjklEQVR4nO3QgQmAQAwEwfRfo71oCf6C+CgzpIDLzsmy2T3gS8QKxArECsQKxArECsQKxArECsQKxArECsQKxArECsQKxArECm5iHTPr99bmbcQKxArECsQKxArECsQKxArECsQKxArECsQKxAr+/+GDxArECsQKxArECsQKxArECsQKxArECsQKxArECi60AYGwUqdYywAAAABJRU5ErkJggg==";

type RedlineRoutingReadinessCaseResult = {
  name: string;
  ok: boolean;
  expected: string;
  actual: string;
  assistant_message: string;
  actions: Array<{ path: string; body?: unknown }>;
};

export type RedlineRoutingReadinessResult = {
  ok: boolean;
  cases: RedlineRoutingReadinessCaseResult[];
};

function summarizeResponse(response: ChatResponse | null): Pick<RedlineRoutingReadinessCaseResult, "actual" | "assistant_message" | "actions"> {
  const actions = (response?.actions ?? []).map((action) => ({ path: action.path, body: action.body }));
  return {
    actual: actions.map((action) => action.path).join(", ") || "no actions",
    assistant_message: response?.assistant_message ?? "",
    actions
  };
}

function activePowerPlanContext(): Record<string, unknown> {
  return {
    revit: {
      document: {
        activeView: { id: 1363337, name: "L4 - Power", type: "EngineeringPlan" }
      }
    }
  };
}

function writeNeutralClipboardPng(root: string): UserAttachment {
  const relativePath = "artifacts/uploads/clipboard_20260524_011111_123.png";
  const fullPath = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, Buffer.from(RED_MARK_PNG_BASE64, "base64"));
  return {
    id: "clipboard-neutral",
    filename: "clipboard_20260524_011111_123.png",
    relative_path: relativePath,
    mime: "image/png"
  };
}

function unit405PlacementToolResults(): ToolResult[] {
  return [
    {
      action_id: "room",
      method: "POST",
      path: "/revit/room-contents",
      status: "done",
      result_json: {
        roomId: 1390985,
        roomNumber: "405",
        spatialKind: "Space",
        resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
        elementIds: [1002],
        boundaryLoops: [
          [
            { start: [0, 0, 0], end: [10, 0, 0] },
            { start: [10, 0, 0], end: [10, 10, 0] },
            { start: [10, 10, 0], end: [0, 10, 0] },
            { start: [0, 10, 0], end: [0, 0, 0] }
          ]
        ]
      }
    },
    {
      action_id: "rank",
      method: "POST",
      path: "/revit/rank-similar-devices-on-wall",
      status: "done",
      result_json: {
        recommendedElementId: 1002,
        candidates: [{ elementId: 1002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
      }
    },
    {
      action_id: "room-wall",
      method: "POST",
      path: "/revit/resolve-room-wall",
      status: "done",
      result_json: {
        status: "Ok",
        roomNumber: "405",
        requestedRoomSide: "left",
        walls: [
          {
            hostElementId: 2002,
            supportsPlacement: true,
            placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
            hostContext: {
              hostElementId: 2002,
              projectedPoint: { x: 0, y: 0, z: 0 },
              tangent: { x: 0, y: 1, z: 0 },
              curveLengthFt: 10
            }
          }
        ]
      }
    },
    {
      action_id: "frame",
      method: "POST",
      path: "/revit/export-view-frame",
      status: "done",
      result_json: {
        frameId: "frame-405",
        viewId: 1363337,
        widthPx: 1000,
        heightPx: 1000,
        mapping: {
          topLeftXyz: [0, 10, 0],
          topRightXyz: [10, 10, 0],
          bottomLeftXyz: [0, 0, 0]
        }
      }
    },
    {
      action_id: "placement-context",
      method: "POST",
      path: "/revit/get-placement-context",
      status: "done",
      result_json: {
        status: "Ok",
        elementId: 1002,
        insertionPoint: { x: 0.5, y: 5, z: 1.5 },
        room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390985, kind: "Space" },
        placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
        wallPlacement: {
          hostElementId: 2002,
          projectedPoint: [0, 0, 0],
          tangent: [0, 1, 0]
        },
        hostLocalFrame: {
          basis: "WallCurve",
          hostElementId: 2002,
          chainageFt: 5,
          normalizedChainage: 0.5,
          curveLengthFt: 10
        },
        diagnostics: {
          hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" }
        },
        suggestedPlacement: {
          createSimilar: {
            action: "/revit/create-similar-from-instance",
            body: {
              exemplarElementId: 1002,
              hostElementId: 2002,
              roomNumber: "405",
              roomSide: "left",
              dryRun: true,
              includePreviewImage: true
            }
          }
        }
      }
    }
  ];
}

async function runFilenameNeutralClipboardCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-readiness-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const attachment = writeNeutralClipboardPng(root);
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      userAttachments: [attachment],
      context: activePowerPlanContext(),
      workbenchResults: [
        {
          index: 1,
          type: "redline_orient",
          ok: true,
          summary: "mapped red mark",
          details: {
            file_path: attachment.relative_path,
            analysis: {
              file_path: attachment.relative_path,
              ocr: { text_excerpt: "Live/Work Loft\nUnit\n405" }
            },
            mapping: {
              summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
              regions: [
                {
                  index: 1,
                  primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                  targets: [
                    {
                      kind: "viewport",
                      view_id: 1363337,
                      score: 0.95,
                      overlap_ratio: 0.3,
                      contains_center: true,
                      view_hint: { normalized_x: 0.02, normalized_y: 0.5 }
                    }
                  ]
                }
              ]
            }
          }
        }
      ] as any,
      toolResults: unit405PlacementToolResults()
    });
    const summary = summarizeResponse(response);
    const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
    const placement = Array.isArray(body?.placements) ? body.placements[0] as Record<string, unknown> | undefined : undefined;
    const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
    const ok =
      !!body &&
      body.exemplarElementId === 1002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      typeof placement?.targetNormalizedChainage === "number" &&
      targetChainage !== null &&
      targetChainage > 0 &&
      targetChainage < 10;
    return {
      name: "filename_neutral_clipboard_ocr_room_adjacent_circuit",
      ok,
      expected: "guard + /revit/create-similar-from-instance with room 405, left side, exemplar 1002, source circuit match, interior target chainage",
      ...summary
    };
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows image tooling can briefly hold temp files; leaving a temp
      // readiness workspace behind is better than failing the routing check.
    }
  }
}

async function runScreenshotMarkSyntheticHintCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-synthetic-hint-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const attachment = writeNeutralClipboardPng(root);
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
      userAttachments: [attachment],
      context: activePowerPlanContext(),
      toolResults: [
        {
          action_id: "rooms-405",
          method: "POST",
          path: "/revit/rooms",
          status: "done",
          result_json: { number: "405", id: 1390985, name: "Live/Work Loft Unit" }
        },
        {
          action_id: "room-wall",
          method: "POST",
          path: "/revit/resolve-room-wall",
          status: "done",
          result_json: {
            status: "Ok",
            roomNumber: "405",
            requestedRoomSide: "left",
            walls: [
              {
                hostElementId: 2002,
                supportsPlacement: true,
                hostContext: {
                  hostElementId: 2002,
                  projectedPoint: { x: 0, y: 0, z: 0 },
                  tangent: { x: 0, y: 1, z: 0 },
                  curveLengthFt: 10
                }
              }
            ]
          }
        },
        {
          action_id: "frame-405",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-405",
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        },
        {
          action_id: "inventory",
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: { viewId: 1363337, count: 1, items: [] }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const first = summary.actions[0];
    const body = first?.body as Record<string, unknown> | undefined;
    return {
      name: "screenshot_mark_requires_view_alignment_for_coordinates",
      ok:
        first?.path === "/revit/rank-similar-devices-on-wall" &&
        body?.roomNumber === "405" &&
        body?.roomSide === "left" &&
        body?.targetPointXyz === undefined,
      expected: "/revit/rank-similar-devices-on-wall may use screenshot mark for room side, but must not derive targetPointXyz until the mark is view-aligned",
      ...summary
    };
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // Best-effort temp cleanup only.
    }
  }
}

async function runPathlessAnalyzeMarkSideCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (image); primary_sheet=none.",
        details: {
          image_meta: { width: 762, height: 636 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "room-contents-405",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390985,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390985, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1555916],
          boundaryLoops: [
            [
              { start: [-20, -30, 0], end: [-20, 2, 0] },
              { start: [-20, 2, 0], end: [4, 2, 0] },
              { start: [4, 2, 0], end: [4, -30, 0] },
              { start: [4, -30, 0], end: [-20, -30, 0] }
            ]
          ]
        }
      },
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 762,
          heightPx: 636,
          mapping: {
            topLeftXyz: [-20, 2, 0],
            topRightXyz: [4, 2, 0],
            bottomLeftXyz: [-20, -30, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          compaction: "visible-elements-inventory-summary",
          viewId: 1363337,
          count: 1,
          itemsSampled: [
            {
              elementId: 1555916,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              familyName: "Duplex Receptacle",
              space: { number: "405", name: "Live/Work Loft Unit 405" },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  const body = first?.body as Record<string, unknown> | undefined;
  return {
    name: "pathless_analyze_mark_side_room_wall_targeting",
    ok: first?.path === "/revit/resolve-room-wall" && body?.roomNumber === "405" && body?.side === "left",
    expected: "/revit/resolve-room-wall for room 405 left side when analyze_redline mark geometry lacks file_path metadata",
    ...summary
  };
}

async function runPathlessAnalyzeAdjacentCircuitPlacementCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "Redline analyzed (image); primary_sheet=none.",
        details: {
          image_meta: { width: 762, height: 636 },
          mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
        }
      }
    ] as any,
    toolResults: unit405PlacementToolResults()
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "pathless_analyze_adjacent_circuit_create_similar",
    ok:
      first?.path === "/revit/computer-use-observe" &&
      !summary.actions.some((action) => action.path === "/revit/create-similar-from-instance") &&
      /no measured redline-to-view target/i.test(summary.assistant_message),
    expected: "pathless red mark with room/wall/exemplar context requests visual observation instead of heuristic create-similar placement",
    ...summary
  };
}

async function runPathlessAnalyzeAdjacentCircuitPlacementMatrixCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const scenarios = [
    { room: "403", side: "bottom", exemplarId: 1403, hostId: 2403, circuit: "P403/1", mark: { x: 250, y: 570, w: 44, h: 26 } },
    { room: "405", side: "left", exemplarId: 1405, hostId: 2405, circuit: "P405/1", mark: { x: 27, y: 404, w: 43, h: 24 } },
    { room: "407", side: "right", exemplarId: 1407, hostId: 2407, circuit: "P407/1", mark: { x: 705, y: 410, w: 40, h: 25 } }
  ] as const;

  const scenarioResults = await Promise.all(scenarios.map(async (scenario) => {
    const curveLengthFt = 12;
    const toolResults: ToolResult[] = [
      {
        action_id: `contents-${scenario.room}`,
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          status: "Ok",
          roomId: 1390000 + Number(scenario.room),
          roomNumber: scenario.room,
          spatialKind: "Space",
          resolvedSpatial: { id: 1390000 + Number(scenario.room), type: "Space", number: scenario.room, confidence: 0.98, matchMode: "exact" },
          elementIds: [scenario.exemplarId],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [curveLengthFt, 0, 0] },
              { start: [curveLengthFt, 0, 0], end: [curveLengthFt, curveLengthFt, 0] },
              { start: [curveLengthFt, curveLengthFt, 0], end: [0, curveLengthFt, 0] },
              { start: [0, curveLengthFt, 0], end: [0, 0, 0] }
            ]
          ]
        }
      },
      {
        action_id: `rank-${scenario.room}`,
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: scenario.exemplarId,
          candidates: [{ elementId: scenario.exemplarId, hostElementId: scenario.hostId, roomSide: scenario.side, electricalCircuit: { primaryLabel: scenario.circuit } }]
        }
      },
      {
        action_id: `wall-${scenario.room}`,
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: scenario.room,
          requestedRoomSide: scenario.side,
          walls: [
            {
              hostElementId: scenario.hostId,
              supportsPlacement: true,
              placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: scenario.hostId,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: scenario.side === "bottom" ? { x: 1, y: 0, z: 0 } : { x: 0, y: 1, z: 0 },
                curveLengthFt
              }
            }
          ]
        }
      },
      {
        action_id: `frame-${scenario.room}`,
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: `frame-${scenario.room}`,
          viewId: 1363337,
          widthPx: 762,
          heightPx: 636,
          mapping: {
            topLeftXyz: [0, curveLengthFt, 0],
            topRightXyz: [curveLengthFt, curveLengthFt, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: `placement-context-${scenario.room}`,
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: scenario.exemplarId,
          insertionPoint: { x: 1, y: 6, z: 1.5 },
          room: { number: scenario.room, name: `Live/Work Unit ${scenario.room}`, id: 1390000 + Number(scenario.room), kind: "Space" },
          placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: scenario.hostId,
            projectedPoint: [0, 0, 0],
            tangent: scenario.side === "bottom" ? [1, 0, 0] : [0, 1, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: scenario.hostId,
            chainageFt: 6,
            normalizedChainage: 0.5,
            curveLengthFt
          },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: scenario.exemplarId,
                hostElementId: scenario.hostId,
                roomNumber: scenario.room,
                roomSide: scenario.side,
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ];
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: activePowerPlanContext(),
      workbenchResults: [
        {
          index: 1,
          type: "analyze_redline",
          ok: true,
          summary: "Redline analyzed (image); primary_sheet=none.",
          details: {
            image_meta: { width: 762, height: 636 },
            mark_regions: [
              {
                index: 1,
                source: "red_markup_detect",
                x: scenario.mark.x,
                y: scenario.mark.y,
                w: scenario.mark.w,
                h: scenario.mark.h,
                area: scenario.mark.w * scenario.mark.h
              }
            ]
          }
        }
      ] as any,
      toolResults
    });
    const summary = summarizeResponse(response);
    return {
      scenario,
      summary,
      ok:
        summary.actions[0]?.path === "/revit/computer-use-observe" &&
        !summary.actions.some((action) => action.path === "/revit/create-similar-from-instance") &&
        /no measured redline-to-view target/i.test(summary.assistant_message)
    };
  }));

  return {
    name: "pathless_analyze_adjacent_circuit_create_similar_matrix",
    ok: scenarioResults.every((row) => row.ok),
    expected: "pathless red marks across bottom/left/right request visual observation instead of heuristic create-similar placement",
    actual: scenarioResults
      .map((row) => `${row.scenario.room}/${row.scenario.side}:${row.summary.actual}`)
      .join("; "),
    assistant_message: scenarioResults.map((row) => `${row.scenario.room}: ${row.summary.assistant_message}`).join("\n"),
    actions: scenarioResults.flatMap((row) =>
      row.summary.actions.map((action) => ({
        path: action.path,
        body: { scenario: `${row.scenario.room}/${row.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
}

async function runPathlessAnalyzeAdjacentCircuitPreviewApplyCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const sessionId = "readiness-pathless-adjacent-preview-apply";
  const workbenchResults = [
    {
      index: 1,
      type: "analyze_redline",
      ok: true,
      summary: "Redline analyzed (image); primary_sheet=none.",
      details: {
        image_meta: { width: 762, height: 636 },
        mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
      }
    }
  ] as any;
  const baseToolResults = unit405PlacementToolResults();
  const previewResponse = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    sessionId,
    workbenchResults,
    toolResults: baseToolResults
  });
  const previewSummary = summarizeResponse(previewResponse);
  const previewBody = previewSummary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const applyResponse = await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    sessionId,
    workbenchResults,
    toolResults: [
      ...baseToolResults,
      {
        action_id: "preview-405",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          status: "Preview",
          dryRun: true,
          placementValidation: { valid: true },
          placements: Array.isArray(previewBody?.placements) ? previewBody.placements : [{ label: "mark 1" }]
        },
        attachments: [{ local_path: "artifacts/previews/pathless-405-preview.png" }]
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(applyResponse);
  const applyBody = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  return {
    name: "pathless_analyze_adjacent_circuit_preview_applies",
    ok:
      summary.actions.some((action) => action.path === "/revit/computer-use-guard") &&
      !!applyBody &&
      applyBody.exemplarElementId === 1002 &&
      applyBody.roomNumber === "405" &&
      applyBody.roomSide === "left" &&
      applyBody.dryRun === false &&
      applyBody.includePreviewImage === false &&
      applyBody.matchElectricalCircuitFromSource === true &&
      applyBody.requireElectricalCircuitMatch === true,
    expected: "after a valid pathless adjacent-circuit preview, route immediately to the same create-similar apply request with dryRun=false",
    ...summary
  };
}

async function runPathlessAnalyzeAdjacentCircuitPostApplyVerificationCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const sessionId = "readiness-pathless-adjacent-post-apply";
  const userText = "add receptacle where indicated and circuit to same circuit as adjacent receptacle.";
  const workbenchResults = [
    {
      index: 1,
      type: "analyze_redline",
      ok: true,
      summary: "Redline analyzed (image); primary_sheet=none.",
      details: {
        image_meta: { width: 762, height: 636 },
        mark_regions: [{ index: 1, source: "red_markup_detect", x: 27, y: 404, w: 43, h: 24, area: 596 }]
      }
    }
  ] as any;
  const applyResult: ToolResult = {
    action_id: "apply-405-pathless",
    method: "POST",
    path: "/revit/create-similar-from-instance",
    status: "done",
    result_json: {
      status: "Placed",
      dryRun: false,
      elementIds: [1735601],
      exemplar: { id: 1002, name: "adjacent receptacle" },
      placements: [{ index: 0, elementId: 1735601, label: "mark 1" }]
    }
  };
  const captureResult: ToolResult = {
    action_id: "capture-405-pathless",
    method: "POST",
    path: "/revit/export-view-region",
    status: "done",
    result_json: { imagePath: "artifacts/checks/pathless-placed-405.png" }
  };
  const auditResult: ToolResult = {
    action_id: "audit-405-pathless",
    method: "POST",
    path: "/revit/audit-hosted-instance-placement",
    status: "done",
    result_json: {
      status: "Ok",
      auditedIds: [1735601],
      validIds: [1735601],
      invalidIds: [],
      offRoomIds: [],
      offWallIds: [],
      unsupportedIds: [],
      missingIds: [],
      items: [
        {
          elementId: 1735601,
          placementContext: {
            elementId: 1735601,
            insertionPoint: [0.8, 9.5, 1.5],
            room: { number: "405" },
            placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
            diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
          }
        }
      ]
    }
  };
  const baseToolResults = unit405PlacementToolResults();
  const afterApply = summarizeResponse(await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText,
    context: activePowerPlanContext(),
    sessionId,
    workbenchResults,
    toolResults: [...baseToolResults, applyResult]
  }));
  const afterCapture = summarizeResponse(await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText,
    context: activePowerPlanContext(),
    sessionId,
    workbenchResults,
    toolResults: [...baseToolResults, applyResult, captureResult]
  }));
  const afterAudit = summarizeResponse(await __testOnlyBuildRedlineExecutionBridgeAsync({
    userText,
    context: activePowerPlanContext(),
    sessionId,
    workbenchResults,
    toolResults: [...baseToolResults, applyResult, captureResult, auditResult]
  }));
  const captureAction = afterApply.actions[0];
  const captureBody = captureAction?.body as Record<string, unknown> | undefined;
  const auditAction = afterCapture.actions[0];
  const auditBody = auditAction?.body as Record<string, unknown> | undefined;
  const readbackAction = afterAudit.actions[0];
  const readbackBody = readbackAction?.body as Record<string, unknown> | undefined;
  return {
    name: "pathless_analyze_adjacent_circuit_post_apply_verification",
    ok:
      captureAction?.path === "/revit/export-view-region" &&
      (captureBody?.region as Record<string, unknown> | undefined)?.mode === "focusElements" &&
      Array.isArray((captureBody?.region as Record<string, unknown> | undefined)?.focusElementIds) &&
      ((captureBody?.region as Record<string, unknown>).focusElementIds as unknown[]).includes(1735601) &&
      auditAction?.path === "/revit/audit-hosted-instance-placement" &&
      Array.isArray(auditBody?.elementIds) &&
      (auditBody.elementIds as unknown[]).includes(1735601) &&
      auditBody.roomNumber === "405" &&
      auditBody.roomSide === "left" &&
      readbackAction?.path === "/revit/get-parameters" &&
      Array.isArray(readbackBody?.elementIds) &&
      (readbackBody.elementIds as unknown[]).includes(1002) &&
      (readbackBody.elementIds as unknown[]).includes(1735601),
    expected: "pathless adjacent-circuit apply must proceed through focused capture, hosted audit, and source/created circuit readback before completion",
    actual: `afterApply=${afterApply.actual}; afterCapture=${afterCapture.actual}; afterAudit=${afterAudit.actual}`,
    assistant_message: [afterApply.assistant_message, afterCapture.assistant_message, afterAudit.assistant_message].join("\n"),
    actions: [...afterApply.actions, ...afterCapture.actions, ...afterAudit.actions]
  };
}

function runVisibleCircuitRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to P403/1",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-1",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-1",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-1",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-1",
          viewId: 1363337,
          count: 2,
          items: [
            {
              elementId: 1556486,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              space: { number: "403", name: "Live/Work Unit 403" },
              parameters: { panel: "P403", circuitNumber: "1" }
            },
            {
              elementId: 1521375,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              space: { number: "408", name: "Live/Work Unit 408" },
              parameters: { panel: "P408", circuitNumber: "7" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "visible_inventory_panel_circuit_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "403",
    expected: "/revit/rooms detail for room 403 from visible P403/1 inventory, not no_pick_hints",
    ...summary
  };
}

function runAdjacentCircuitRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405",
          viewId: 1363337,
          count: 3,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "adjacent_circuit_visible_inventory_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from dominant visible adjacent devices when no OCR room or explicit circuit exists",
    ...summary
  };
}

function runOcrOnlyCircuitIgnoredForSameCircuitCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "ocr saw neighboring circuit label",
        details: { ocr: { text_excerpt: "P407/1" } }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405",
          viewId: 1363337,
          count: 3,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "ocr_only_circuit_ignored_for_same_circuit",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from adjacent inventory; OCR-only P407/1 must not become an explicit requested circuit",
    ...summary
  };
}

function runMarkedAdjacentDeviceBeatsNoisySummaryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.06, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-noisy-summary",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-noisy-summary",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-noisy-summary",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-noisy-summary",
          viewId: 1363337,
          count: 90,
          summary: {
            roomCounts: [
              { key: "407", count: 48 },
              { key: "405", count: 2 }
            ],
            spaceCounts: [{ key: "407", count: 48 }]
          },
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "marked_adjacent_device_beats_noisy_summary",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for marked room 405 even when visible inventory summary is dominated by adjacent room 407",
    ...summary
  };
}

function runGenericVisibleUnitLabelBeatsNoisySummaryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-label",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-label",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-label",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 5005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.35, normalizedY: 0.64, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "generic_visible_unit_label_beats_noisy_summary",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for the room named by a generic visible Unit label near the mark, even when summaries favor another room",
    ...summary
  };
}

function runGenericVisibleCircuitLabelBeatsNoisySummaryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-circuit-label",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-circuit-label",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-circuit-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-circuit-label",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 6005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "P405/1",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "generic_visible_circuit_label_beats_noisy_summary",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for the room implied by a visible circuit label near the mark, even when summaries favor another room",
    ...summary
  };
}

function runAdjacentDeviceEvidenceBeatsNoisySummaryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-adjacent-noisy-summary",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-adjacent-noisy-summary",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-adjacent-noisy-summary",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-adjacent-noisy-summary",
          viewId: 1363337,
          count: 120,
          summary: {
            roomCounts: [
              { key: "407", count: 60 },
              { key: "405", count: 2 }
            ],
            spaceCounts: [{ key: "407", count: 58 }]
          },
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "adjacent_device_evidence_beats_noisy_summary_without_explicit_circuit",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from adjacent receptacle evidence even when broad summary favors room 407",
    ...summary
  };
}

function runAlternateVisibleInventorySchemaCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405-elements",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405-elements",
          viewId: 1363337,
          count: 3,
          elements: [
            {
              id: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              image: { normalized_x: 0.06, normalized_y: 0.54 },
              panel: "P405",
              circuitNumber: "1"
            },
            {
              id: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit" },
              normalizedX: 0.93,
              normalizedY: 0.52,
              Panel: "P407",
              Circuit: "1"
            },
            {
              id: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit" },
              imagePoint: { normalizedX: 0.46, normalizedY: 0.84 },
              panel: "P405",
              circuit: "1"
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "alternate_visible_inventory_schema_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from elements/id/direct image/direct circuit visible inventory schema",
    ...summary
  };
}

function runKnownRoomGenericActiveViewResolutionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/clipboard_20260524_011111_123.png",
          ocr: { text_excerpt: "Live/Work Loft Unit 405" }
        }
      }
    ] as any
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "known_room_generic_active_view_resolution",
    ok:
      first?.path === "/revit/resolve-room-plan-view" &&
      (first.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      (first.body as Record<string, unknown> | undefined)?.preferViewNameContains === "power",
    expected: "/revit/resolve-room-plan-view for room 405 when active model view is generic L4 instead of a power/electrical plan",
    ...summary
  };
}

function runLateKnownRoomGenericFrameResolutionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "analyze_redline",
        ok: true,
        summary: "analyzed",
        details: {
          file_path: "artifacts/uploads/clipboard_20260524_001025_518.png",
          ocr: { text_excerpt: "Live/Work Loft Unit 405" }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frame_id: "frame-generic-405",
          view_id: 1363433,
          width_px: 1000,
          height_px: 800,
          mapping: {
            top_left_xyz: [0, 10, 0],
            top_right_xyz: [10, 10, 0],
            bottom_left_xyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frame_id: "inventory-generic-405",
          view_id: 1363433,
          count: 2,
          visible_elements: [
            {
              element_id: 1411041,
              category: "Spaces",
              built_in_category: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit", kind: "Space" }
            },
            {
              element_id: 1003,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Duplex Receptacle",
              type_name: "Duplex",
              room_number: "405",
              image_point: { normalized_x: 0.46, normalized_y: 0.84 },
              electrical_circuit: { primary_label: "P405/1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "late_known_room_generic_frame_resolution",
    ok:
      first?.path === "/revit/resolve-room-plan-view" &&
      (first.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      (first.body as Record<string, unknown> | undefined)?.preferViewNameContains === "power",
    expected: "/revit/resolve-room-plan-view after room 405 is known even if a generic L4 frame/inventory was already exported",
    ...summary
  };
}

function runSnakeCaseVisibleInventorySchemaCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-snake-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frame_id: "inventory-snake-405",
          view_id: 1363337,
          count: 4,
          visible_elements: [
            {
              element_id: 1411041,
              category: "Spaces",
              built_in_category: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit", kind: "Space" },
              bbox: { image: { normalized_min_x: 0.0, normalized_min_y: 0.1, normalized_max_x: 0.62, normalized_max_y: 0.9 } }
            },
            {
              element_id: 1002,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              associated_spatial: { number: "405", name: "Live/Work Loft Unit" },
              image_point: { normalized_x: 0.06, normalized_y: 0.54 },
              parameter_groups: { electrical: { panel: "P405", circuit_number: "1" } }
            },
            {
              element_id: 1003,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              room_number: "405",
              image_point: { normalized_x: 0.46, normalized_y: 0.84 },
              electrical_circuit: { primary_label: "P405/1" }
            },
            {
              element_id: 2001,
              category: "Electrical Fixtures",
              built_in_category: "OST_ElectricalFixtures",
              family_name: "Receptacle",
              type_name: "Duplex",
              room_number: "407",
              image_point: { normalized_x: 0.93, normalized_y: 0.52 },
              panel: "P407",
              circuit_number: "1"
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "snake_case_visible_inventory_schema_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from snake_case native visible inventory schema",
    ...summary
  };
}

function runVisibleRoomLabelInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405-label",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-405-label",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 9001,
              category: "Room Tags",
              builtInCategory: "OST_RoomTags",
              visibleText: "405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Room" },
              anchor: { image: { normalizedX: 0.52, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "visible_room_label_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from visible room tag/text labels when device spatial metadata is absent",
    ...summary
  };
}

function visibleSpaceElementToolResults(): ToolResult[] {
  return [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-spaces",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-spaces",
          viewId: 1363337,
          count: 5,
          items: [
            {
              id: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { number: "405", name: "Live/Work Loft Unit 405" },
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.52, normalizedY: 0.72, insideFrame: true } }
            },
            {
              id: 1411043,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { number: "407", name: "Live/Work Unit 407" },
              associatedSpatial: { number: "407", name: "Live/Work Unit 407", kind: "Space" },
              anchor: { image: { normalizedX: 0.90, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: { displayValue: "P405" }, "Circuit Number": { value: 1 } }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: { displayValue: "P405" }, "Circuit Number": { value: 1 } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.53, insideFrame: true } },
              parameters: { Panel: { displayValue: "P407" }, "Circuit Number": { value: 1 } }
            }
          ]
        }
      }
    ] as ToolResult[];
}

function runVisibleSpaceElementRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: visibleSpaceElementToolResults()
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "visible_space_element_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from visible MEP space elements plus adjacent device inventory",
    ...summary
  };
}

function runVisibleSpaceContainmentGenericPanelCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.48, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-panel",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-panel",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1223,
          mapping: {
            topLeftXyz: [-120, 50, 32.166667],
            topRightXyz: [93, 50, 32.166667],
            bottomLeftXyz: [-120, -68, 32.166667]
          }
        }
      },
      {
        action_id: "inventory-generic-panel",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-panel",
          viewId: 1363337,
          count: 5,
          items: [
            {
              id: 1411040,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 403",
              space: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              associatedSpatial: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.82, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.25, minNormalizedY: 0.58, maxNormalizedX: 0.465, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.54, normalizedY: 0.71, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.47, minNormalizedY: 0.58, maxNormalizedX: 0.61, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411042,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              associatedSpatial: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.72, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.62, minNormalizedY: 0.58, maxNormalizedX: 0.82, maxNormalizedY: 0.86 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "visible_space_containment_generic_panel_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from visible MEP space bbox containment when adjacent circuit label is generic",
    ...summary
  };
}

function runBboxOnlySpaceContainmentCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-bbox-only-space",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-bbox-only-space",
          viewId: 1363337,
          widthPx: 2200,
          heightPx: 1223,
          mapping: {
            topLeftXyz: [-120, 50, 32.166667],
            topRightXyz: [93, 50, 32.166667],
            bottomLeftXyz: [-120, -68, 32.166667]
          }
        }
      },
      {
        action_id: "inventory-bbox-only-space",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-bbox-only-space",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.06, minNormalizedY: 0.2, maxNormalizedX: 0.55, maxNormalizedY: 0.9 } }
            },
            {
              elementId: 1411042,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 407",
              space: { id: 1411042, number: "407", name: "Live/Work Unit 407", kind: "Space" },
              bbox: { image: { minNormalizedX: 0.56, minNormalizedY: 0.2, maxNormalizedX: 0.95, maxNormalizedY: 0.9 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "bbox_only_space_containment_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from bbox-only visible space containment of the adjacent device",
    ...summary
  };
}

function runSameAdjacentCircuitRoomSideMatrixCase(): RedlineRoutingReadinessCaseResult {
  const scenarios = [
    {
      room: "403",
      side: "bottom",
      mark: { x: 0.34, y: 0.86 },
      device: { x: 0.34, y: 0.82 },
      spaces: [
        { room: "403", minX: 0.18, minY: 0.56, maxX: 0.46, maxY: 0.88 },
        { room: "405", minX: 0.47, minY: 0.56, maxX: 0.64, maxY: 0.88 },
        { room: "407", minX: 0.65, minY: 0.56, maxX: 0.92, maxY: 0.88 }
      ],
      otherDevices: [
        { room: "405", x: 0.52, y: 0.82 },
        { room: "407", x: 0.86, y: 0.82 }
      ]
    },
    {
      room: "405",
      side: "left",
      mark: { x: 0.045, y: 0.54 },
      device: { x: 0.08, y: 0.54 },
      spaces: [
        { room: "403", minX: 0.08, minY: 0.08, maxX: 0.42, maxY: 0.46 },
        { room: "405", minX: 0.06, minY: 0.48, maxX: 0.55, maxY: 0.9 },
        { room: "407", minX: 0.56, minY: 0.48, maxX: 0.94, maxY: 0.9 }
      ],
      otherDevices: [
        { room: "403", x: 0.24, y: 0.32 },
        { room: "407", x: 0.91, y: 0.54 }
      ]
    },
    {
      room: "407",
      side: "right",
      mark: { x: 0.955, y: 0.55 },
      device: { x: 0.91, y: 0.55 },
      spaces: [
        { room: "403", minX: 0.08, minY: 0.08, maxX: 0.42, maxY: 0.46 },
        { room: "405", minX: 0.08, minY: 0.48, maxX: 0.54, maxY: 0.9 },
        { room: "407", minX: 0.55, minY: 0.48, maxX: 0.94, maxY: 0.9 }
      ],
      otherDevices: [
        { room: "403", x: 0.28, y: 0.32 },
        { room: "405", x: 0.1, y: 0.55 }
      ]
    }
  ];

  const results = scenarios.map((scenario, scenarioIndex) => {
    const response = __testOnlyBuildRedlineExecutionBridge({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: activePowerPlanContext(),
      workbenchResults: [
        {
          index: 1,
          type: "redline_orient",
          ok: true,
          summary: "mapped red mark",
          details: {
            mapping: {
              summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
              regions: [
                {
                  index: 1,
                  primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                  targets: [
                    {
                      kind: "viewport",
                      view_id: 1363337,
                      score: 0.95,
                      overlap_ratio: 0.3,
                      contains_center: true,
                      view_hint: { normalized_x: scenario.mark.x, normalized_y: scenario.mark.y }
                    }
                  ]
                }
              ]
            }
          }
        }
      ] as any,
      toolResults: [
        {
          action_id: `frame-matrix-${scenario.room}`,
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: `frame-matrix-${scenario.room}`,
            viewId: 1363337,
            widthPx: 2200,
            heightPx: 1223,
            mapping: {
              topLeftXyz: [-120, 50, 32.166667],
              topRightXyz: [93, 50, 32.166667],
              bottomLeftXyz: [-120, -68, 32.166667]
            }
          }
        },
        {
          action_id: `inventory-matrix-${scenario.room}`,
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: {
            frameId: `inventory-matrix-${scenario.room}`,
            viewId: 1363337,
            count: 8,
            summary: {
              roomCounts: [
                { key: scenario.room === "403" ? "405" : "403", count: 30 },
                { key: scenario.room, count: 1 }
              ]
            },
            items: [
              ...scenario.spaces.map((space, index) => ({
                elementId: 1411000 + scenarioIndex * 10 + index,
                category: "Spaces",
                builtInCategory: "OST_MEPSpaces",
                categoryToken: "OST_MEPSpaces",
                name: `Live/Work Unit ${space.room}`,
                space: { number: space.room, name: `Live/Work Unit ${space.room}`, kind: "Space" },
                bbox: {
                  image: {
                    minNormalizedX: space.minX,
                    minNormalizedY: space.minY,
                    maxNormalizedX: space.maxX,
                    maxNormalizedY: space.maxY
                  }
                }
              })),
              {
                elementId: 150000 + scenarioIndex,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: scenario.device.x, normalizedY: scenario.device.y, insideFrame: true } },
                parameters: { Panel: "L4PA", "Circuit Number": String(7 + scenarioIndex) }
              },
              ...scenario.otherDevices.map((device, index) => ({
                elementId: 151000 + scenarioIndex * 10 + index,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: device.x, normalizedY: device.y, insideFrame: true } },
                parameters: { Panel: "L4PB", "Circuit Number": String(index + 1) }
              }))
            ]
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const first = summary.actions[0];
    const body = first?.body as Record<string, unknown> | undefined;
    return {
      scenario,
      ok: first?.path === "/revit/rooms" && body?.roomNumber === scenario.room,
      summary
    };
  });

  return {
    name: "same_adjacent_circuit_room_side_matrix",
    ok: results.every((result) => result.ok),
    expected: "/revit/rooms detail for each marked room from adjacent-device/space containment across bottom/left/right wall-side variants",
    actual: results
      .map((result) => {
        const first = result.summary.actions[0];
        const body = first?.body as Record<string, unknown> | undefined;
        return `${result.scenario.room}/${result.scenario.side}:${first?.path ?? "no-action"}:${String(body?.roomNumber ?? "")}`;
      })
      .join("; "),
    assistant_message: results.map((result) => `${result.scenario.room}: ${result.summary.assistant_message}`).join("\n"),
    actions: results.flatMap((result) =>
      result.summary.actions.slice(0, 1).map((action) => ({
        path: action.path,
        body: { scenario: `${result.scenario.room}/${result.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
}

function runGenericViewPlacementDiscoveryResolveCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle in room 405 where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4", type: "FloorPlan" }
        }
      }
    },
    toolResults: [
      {
        action_id: "room-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          hostIdsBySide: { left: [2002] }
        }
      },
      {
        action_id: "rank-405",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
        }
      },
      {
        action_id: "placement-context-405",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1411041, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2002, projectedPoint: [4.7, 1.4, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2002, chainageFt: 0.2, normalizedChainage: 0.071429, curveLengthFt: 2.8 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          electricalCircuit: { primaryLabel: "P405/1" },
          suggestedPlacement: {
            createSimilar: {
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "generic_view_placement_discovery_resolve",
    ok:
      first?.path === "/revit/resolve-room-plan-view" &&
      (first.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      (first.body as Record<string, unknown> | undefined)?.preferViewNameContains === "power",
    expected: "/revit/resolve-room-plan-view before preview when room/exemplar are resolved but active placement view is generic L4",
    ...summary
  };
}

function runGenericPanelRoomRelativeCreateSimilarCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1363433, name: "L4 - Power", type: "EngineeringPlan" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363433] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363433, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363433,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.48, normalized_y: 0.84 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "frame-generic-panel",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-panel",
          viewId: 1363433,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-generic-panel",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-panel",
          viewId: 1363433,
          count: 4,
          items: [
            {
              id: 1411040,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Unit 403",
              space: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              associatedSpatial: { id: 1411040, number: "403", name: "Live/Work Unit 403", kind: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.82, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.25, minNormalizedY: 0.58, maxNormalizedX: 0.465, maxNormalizedY: 0.86 } }
            },
            {
              id: 1411041,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Live/Work Loft Unit 405",
              space: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              associatedSpatial: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
              anchor: { image: { normalizedX: 0.54, normalizedY: 0.71, insideFrame: true } },
              bbox: { image: { minNormalizedX: 0.47, minNormalizedY: 0.58, maxNormalizedX: 0.61, maxNormalizedY: 0.86 } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.72, normalizedY: 0.84, insideFrame: true } },
              parameters: { Panel: "L4PB", "Circuit Number": "9" }
            }
          ]
        }
      },
      {
        action_id: "room-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          boundaryLoops: [
            [
              { start: [4.7, 1.4, 0], end: [6.1, 1.4, 0] },
              { start: [6.1, 1.4, 0], end: [6.1, 4.2, 0] },
              { start: [6.1, 4.2, 0], end: [4.7, 4.2, 0] },
              { start: [4.7, 4.2, 0], end: [4.7, 1.4, 0] }
            ]
          ],
          hostIdsBySide: { left: [2002], right: [2007], bottom: [2005] }
        }
      },
      {
        action_id: "contents-405",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1411041,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1411041, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          boundaryLoops: [
            [
              { start: [4.7, 1.4, 0], end: [6.1, 1.4, 0] },
              { start: [6.1, 1.4, 0], end: [6.1, 4.2, 0] },
              { start: [6.1, 4.2, 0], end: [4.7, 4.2, 0] },
              { start: [4.7, 4.2, 0], end: [4.7, 1.4, 0] }
            ]
          ],
          elements: [
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [4.8, 1.6, 0] }
          ]
        }
      },
      {
        action_id: "rank-405",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "left", electricalCircuit: { panel: "L4PA", circuitNumber: "7" } }]
        }
      },
      {
        action_id: "room-wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [4.7, 1.6, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        action_id: "placement-context-405",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 4.8, y: 1.6, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1411041, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2002, projectedPoint: [4.7, 1.4, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2002, chainageFt: 0.2, normalizedChainage: 0.071429, curveLengthFt: 2.8 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          electricalCircuit: { panel: "L4PA", circuitNumber: "7", primaryLabel: "L4PA/7" },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placement = Array.isArray(body?.placements) ? body.placements[0] as Record<string, unknown> | undefined : undefined;
  return {
    name: "generic_panel_room_relative_create_similar_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      !!placement &&
      typeof placement.targetNormalizedChainage === "number",
    expected: "/revit/create-similar-from-instance preview preserves room-relative left side and source circuit for generic adjacent panel labels",
    ...summary
  };
}

function runVisibleSpaceElementCreateSimilarCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      ...visibleSpaceElementToolResults(),
      {
        action_id: "room-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          room: { id: 1411041, number: "405", name: "Live/Work Loft Unit 405", kind: "Space" },
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          hostIdsBySide: { left: [2002], right: [2007], bottom: [2005] }
        }
      },
      {
        action_id: "contents-405",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1411041,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1411041, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002, 1003],
          elements: [
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] },
            { id: 1003, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2005, point: [5, 0.5, 0] }
          ]
        }
      },
      {
        action_id: "rank-405",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "left", electricalCircuit: { primaryLabel: "P405/1" } }]
        }
      },
      {
        action_id: "room-wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        action_id: "placement-context-405",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1411041, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2002, projectedPoint: [0, 0, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2002, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          electricalCircuit: { primaryLabel: "P405/1", panel: "P405", circuitNumber: "1" },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "405",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placement = Array.isArray(body?.placements) ? body.placements[0] as Record<string, unknown> | undefined : undefined;
  return {
    name: "visible_space_element_create_similar_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      !!placement &&
      (typeof placement.targetChainageFt === "number" || typeof placement.targetNormalizedChainage === "number"),
    expected: "/revit/create-similar-from-instance preview from visible MEP space room recovery with adjacent source circuit",
    ...summary
  };
}

async function runNearestVisibleRoomLabelInferenceCase(): Promise<RedlineRoutingReadinessCaseResult> {
  const previousRoot = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "revitoperator-redline-nearest-room-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  try {
    const attachment = writeNeutralClipboardPng(root);
    const response = await __testOnlyBuildRedlineExecutionBridgeAsync({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      userAttachments: [attachment],
      context: activePowerPlanContext(),
      toolResults: [
        {
          action_id: "frame-405",
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: "frame-405",
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 800,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        },
        {
          action_id: "inventory-adjacent-labels",
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: {
            frameId: "inventory-adjacent-labels",
            viewId: 1363337,
            count: 4,
            items: [
              {
                elementId: 9003,
                category: "Room Tags",
                builtInCategory: "OST_RoomTags",
                visibleText: "403",
                taggedSpatial: { number: "403", name: "Live/Work Unit", type: "Room" },
                anchor: { image: { normalizedX: 0.48, normalizedY: 0.5, insideFrame: true } }
              },
              {
                elementId: 9005,
                category: "Room Tags",
                builtInCategory: "OST_RoomTags",
                visibleText: "405",
                taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Room" },
                anchor: { image: { normalizedX: 0.08, normalizedY: 0.5, insideFrame: true } }
              },
              {
                elementId: 9007,
                category: "Room Tags",
                builtInCategory: "OST_RoomTags",
                visibleText: "407",
                taggedSpatial: { number: "407", name: "Live/Work Unit", type: "Room" },
                anchor: { image: { normalizedX: 0.92, normalizedY: 0.5, insideFrame: true } }
              },
              {
                elementId: 1002,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: 0.07, normalizedY: 0.55, insideFrame: true } },
                parameters: { Panel: "P405", "Circuit Number": "1" }
              }
            ]
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const first = summary.actions[0];
    return {
      name: "nearest_visible_room_label_inference",
      ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
      expected: "/revit/rooms detail for room 405 from the visible label/device nearest the red mark when adjacent units are also visible",
      ...summary
    };
  } finally {
    if (previousRoot === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = previousRoot;
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  }
}

function runCompactedAdjacentInventoryRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-405",
          viewId: 1363337,
          count: 3,
          itemsSampled: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
              parameterGroups: { electrical: { panel: "P405", circuitNumber: "1" } }
            },
            {
              elementId: 1003,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
              parameters: { panel: "P405", circuitNumber: "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
              parameterGroups: { electrical: { panel: "P407", circuitNumber: "1" } }
            }
          ],
          itemsOmitted: 0
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "compacted_adjacent_inventory_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 from compacted visible inventory itemsSampled evidence",
    ...summary
  };
}

function runPrioritizedCompactedInventoryRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const clutter = Array.from({ length: 28 }, (_, i) => ({
    elementId: 5000 + i,
    category: i % 2 === 0 ? "Walls" : "Generic Annotations",
    builtInCategory: i % 2 === 0 ? "OST_Walls" : "OST_GenericAnnotation",
    name: `Early non-device visible item ${i}`,
    anchor: { image: { normalizedX: 0.1 + (i % 7) * 0.08, normalizedY: 0.1 + (i % 5) * 0.08, insideFrame: true } }
  }));
  const visibleInventory = compactVisibleElementsResult({
    frameId: "inventory-405",
    viewId: 1363337,
    count: clutter.length + 3,
    items: [
      ...clutter,
      {
        elementId: 1002,
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        name: "Duplex Receptacle",
        associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.06, normalizedY: 0.54, insideFrame: true } },
        electricalCircuit: { primaryLabel: "P405/1" },
        host: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
        orientation: { facing: { x: 1, y: 0, z: 0 }, planAzimuthRadians: 0 }
      },
      {
        elementId: 1003,
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        name: "Duplex Receptacle",
        associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.46, normalizedY: 0.84, insideFrame: true } },
        parameters: { Panel: "P405", "Circuit Number": "1" }
      },
      {
        elementId: 2001,
        category: "Electrical Fixtures",
        builtInCategory: "OST_ElectricalFixtures",
        name: "Duplex Receptacle",
        associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
        anchor: { image: { normalizedX: 0.93, normalizedY: 0.52, insideFrame: true } },
        parameterGroups: { electrical: { panel: "P407", circuitNumber: "1" } }
      }
    ]
  }, { maxItems: 4, maxCountEntries: 4 });

  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: visibleInventory
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "prioritized_compacted_inventory_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for room 405 even when compacted visible inventory must sample electrical items after early clutter",
    ...summary
  };
}

function runCompactedInventorySummaryRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-405",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-405",
          viewId: 1363337,
          count: 80,
          itemsSampled: [
            {
              elementId: 9001,
              category: "Walls",
              builtInCategory: "OST_Walls",
              name: "Wall projection",
              anchor: { image: { normalizedX: 0.05, normalizedY: 0.5, insideFrame: true } }
            },
            {
              elementId: 9002,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              name: "Room tag leader",
              anchor: { image: { normalizedX: 0.5, normalizedY: 0.5, insideFrame: true } }
            }
          ],
          itemsOmitted: 78,
          summary: {
            categoryCounts: [
              { key: "OST_Walls", count: 20 },
              { key: "OST_GenericAnnotation", count: 16 }
            ],
            roomCounts: [
              { key: "405", count: 12 },
              { key: "407", count: 3 }
            ],
            spaceCounts: [
              { key: "405", count: 10 },
              { key: "407", count: 2 }
            ]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "compacted_inventory_summary_room_inference",
    ok: first?.path === "/revit/rooms" && (first.body as Record<string, unknown> | undefined)?.roomNumber === "405",
    expected: "/revit/rooms detail for dominant room 405 from compacted visible inventory summary when sampled items lack room anchors",
    ...summary
  };
}

function runRichInventoryRetryBeforeNoPickCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-electrical-only",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-electrical-only",
          viewId: 1363337,
          count: 1,
          items: [
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle"
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  const categories = Array.isArray(body?.categories) ? body.categories : [];
  return {
    name: "richer_inventory_retry_before_no_pick",
    ok:
      action?.path === "/revit/export-visible-elements" &&
      categories.includes("OST_RoomTags") &&
      categories.includes("OST_MEPSpaces") &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/export-visible-elements richer spatial inventory retry before no_pick_hints when first inventory lacks room/space context",
    ...summary
  };
}

function runUnlabeledSpatialInventoryRetryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-unlabeled-spaces",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-unlabeled-spaces",
          viewId: 1363337,
          count: 3,
          items: [
            {
              elementId: 4001,
              category: "Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              name: "Space"
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle"
            }
          ],
          summary: {
            spaceCounts: [{ key: "", count: 3 }]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  const categories = Array.isArray(body?.categories) ? body.categories : [];
  return {
    name: "unlabeled_spatial_inventory_retry",
    ok:
      action?.path === "/revit/export-visible-elements" &&
      categories.includes("OST_RoomTags") &&
      categories.includes("OST_MEPSpaces") &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/export-visible-elements richer retry when room/space categories are present but expose no usable room identifiers",
    ...summary
  };
}

function runRichInventoryAdjacentRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: [
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-rich",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          _compacted: true,
          frameId: "inventory-rich",
          viewId: 1363337,
          count: 5,
          itemsSampled: [
            {
              elementId: 4005,
              category: "MEP Spaces",
              builtInCategory: "OST_MEPSpaces",
              space: { number: "405", name: "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.43, normalizedY: 0.52, insideFrame: true } },
              bbox: { image: { minX: 0.08, minY: 0.14, maxX: 0.86, maxY: 0.91 } }
            },
            {
              elementId: 5005,
              category: "Space Tags",
              builtInCategory: "OST_MEPSpaceTags",
              visibleText: "Live/Work Loft Unit 405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              parameters: { Panel: "P405", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.07, normalizedY: 0.52, insideFrame: true } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.52, insideFrame: true } }
            }
          ],
          summary: {
            spaceCounts: [
              { key: "405", count: 3 },
              { key: "407", count: 1 }
            ]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  return {
    name: "rich_inventory_adjacent_room_inference",
    ok:
      action?.path === "/revit/rooms" &&
      (action.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/rooms detail for room 405 from rich spatial inventory when prompt omits explicit room/circuit",
    ...summary
  };
}

function runSheetPlacedViewAdjacentRoomInferenceCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "frame-placed-view",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-placed-view",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 800,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "inventory-placed-view",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-placed-view",
          viewId: 1363337,
          count: 4,
          items: [
            {
              elementId: 4005,
              category: "MEP Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              space: { number: "405", name: "Live/Work Loft Unit" },
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.43, normalizedY: 0.52, insideFrame: true } },
              bbox: { image: { minX: 0.08, minY: 0.14, maxX: 0.86, maxY: 0.91 } }
            },
            {
              elementId: 5005,
              category: "Space Tags",
              builtInCategory: "OST_MEPSpaceTags",
              visibleText: "Live/Work Loft Unit 405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.45, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              parameters: { Panel: "L4PA", "Circuit Number": "7" },
              anchor: { image: { normalizedX: 0.07, normalizedY: 0.52, insideFrame: true } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "L4PB", "Circuit Number": "9" },
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.52, insideFrame: true } }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  return {
    name: "sheet_placed_view_adjacent_room_inference",
    ok:
      action?.path === "/revit/rooms" &&
      (action.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      (action.body as Record<string, unknown> | undefined)?.viewId === 1363337 &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/rooms detail for room 405 on placed model view 1363337 from sheet-hosted visible inventory",
    ...summary
  };
}

function runSheetPlacedViewSameAdjacentCircuitMatrixCase(): RedlineRoutingReadinessCaseResult {
  const scenarios = [
    {
      room: "403",
      side: "bottom",
      mark: { x: 0.34, y: 0.86 },
      device: { x: 0.34, y: 0.82 },
      spaces: [
        { room: "403", minX: 0.18, minY: 0.56, maxX: 0.46, maxY: 0.88 },
        { room: "405", minX: 0.47, minY: 0.56, maxX: 0.64, maxY: 0.88 },
        { room: "407", minX: 0.65, minY: 0.56, maxX: 0.92, maxY: 0.88 }
      ],
      otherDevices: [
        { room: "405", x: 0.52, y: 0.82 },
        { room: "407", x: 0.86, y: 0.82 }
      ]
    },
    {
      room: "405",
      side: "left",
      mark: { x: 0.045, y: 0.54 },
      device: { x: 0.08, y: 0.54 },
      spaces: [
        { room: "403", minX: 0.08, minY: 0.08, maxX: 0.42, maxY: 0.46 },
        { room: "405", minX: 0.06, minY: 0.48, maxX: 0.55, maxY: 0.9 },
        { room: "407", minX: 0.56, minY: 0.48, maxX: 0.94, maxY: 0.9 }
      ],
      otherDevices: [
        { room: "403", x: 0.24, y: 0.32 },
        { room: "407", x: 0.91, y: 0.54 }
      ]
    },
    {
      room: "407",
      side: "right",
      mark: { x: 0.955, y: 0.55 },
      device: { x: 0.91, y: 0.55 },
      spaces: [
        { room: "403", minX: 0.08, minY: 0.08, maxX: 0.42, maxY: 0.46 },
        { room: "405", minX: 0.08, minY: 0.48, maxX: 0.54, maxY: 0.9 },
        { room: "407", minX: 0.55, minY: 0.48, maxX: 0.94, maxY: 0.9 }
      ],
      otherDevices: [
        { room: "403", x: 0.28, y: 0.32 },
        { room: "405", x: 0.1, y: 0.55 }
      ]
    }
  ];

  const results = scenarios.map((scenario, scenarioIndex) => {
    const response = __testOnlyBuildRedlineExecutionBridge({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
          }
        }
      },
      workbenchResults: [
        {
          index: 1,
          type: "redline_orient",
          ok: true,
          summary: "mapped red mark to placed model view",
          details: {
            mapping: {
              summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
              regions: [
                {
                  index: 1,
                  primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                  targets: [
                    {
                      kind: "viewport",
                      view_id: 1363337,
                      score: 0.95,
                      overlap_ratio: 0.3,
                      contains_center: true,
                      view_hint: { normalized_x: scenario.mark.x, normalized_y: scenario.mark.y }
                    }
                  ]
                }
              ]
            }
          }
        }
      ] as any,
      toolResults: [
        {
          action_id: `sheet-detail-matrix-${scenario.room}`,
          method: "POST",
          path: "/revit/sheets",
          status: "done",
          result_json: {
            status: "Ok",
            sheetNumber: "E104",
            viewId: 1391195,
            sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
            viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
            placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
          }
        },
        {
          action_id: `frame-sheet-matrix-${scenario.room}`,
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: `frame-sheet-matrix-${scenario.room}`,
            viewId: 1363337,
            widthPx: 2200,
            heightPx: 1223,
            mapping: {
              topLeftXyz: [-120, 50, 32.166667],
              topRightXyz: [93, 50, 32.166667],
              bottomLeftXyz: [-120, -68, 32.166667]
            }
          }
        },
        {
          action_id: `inventory-sheet-matrix-${scenario.room}`,
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: {
            frameId: `inventory-sheet-matrix-${scenario.room}`,
            viewId: 1363337,
            count: 8,
            summary: {
              roomCounts: [
                { key: scenario.room === "403" ? "405" : "403", count: 30 },
                { key: scenario.room, count: 1 }
              ]
            },
            items: [
              ...scenario.spaces.map((space, index) => ({
                elementId: 1412000 + scenarioIndex * 10 + index,
                category: "Spaces",
                builtInCategory: "OST_MEPSpaces",
                categoryToken: "OST_MEPSpaces",
                name: `Live/Work Unit ${space.room}`,
                space: { number: space.room, name: `Live/Work Unit ${space.room}`, kind: "Space" },
                bbox: {
                  image: {
                    minNormalizedX: space.minX,
                    minNormalizedY: space.minY,
                    maxNormalizedX: space.maxX,
                    maxNormalizedY: space.maxY
                  }
                }
              })),
              {
                elementId: 160000 + scenarioIndex,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: scenario.device.x, normalizedY: scenario.device.y, insideFrame: true } },
                parameters: { Panel: "L4PA", "Circuit Number": String(7 + scenarioIndex) }
              },
              ...scenario.otherDevices.map((device, index) => ({
                elementId: 161000 + scenarioIndex * 10 + index,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: device.x, normalizedY: device.y, insideFrame: true } },
                parameters: { Panel: "L4PB", "Circuit Number": String(index + 1) }
              }))
            ]
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const first = summary.actions[0];
    const body = first?.body as Record<string, unknown> | undefined;
    return {
      scenario,
      ok: first?.path === "/revit/rooms" && body?.roomNumber === scenario.room && body?.viewId === 1363337,
      summary
    };
  });

  return {
    name: "sheet_placed_view_same_adjacent_circuit_matrix",
    ok: results.every((result) => result.ok),
    expected: "/revit/rooms detail on placed model view 1363337 for bottom/left/right same-adjacent-circuit redlines from an active sheet",
    actual: results
      .map((result) => {
        const first = result.summary.actions[0];
        const body = first?.body as Record<string, unknown> | undefined;
        return `${result.scenario.room}/${result.scenario.side}:${first?.path ?? "no-action"}:${String(body?.roomNumber ?? "")}:${String(body?.viewId ?? "")}`;
      })
      .join("; "),
    assistant_message: results.map((result) => `${result.scenario.room}: ${result.summary.assistant_message}`).join("\n"),
    actions: results.flatMap((result) =>
      result.summary.actions.slice(0, 1).map((action) => ({
        path: action.path,
        body: { scenario: `${result.scenario.room}/${result.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
}

function runSheetPlacedViewSameAdjacentCircuitFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark to placed model view",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "sheet-detail-e104-full-preview",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-full-preview",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-full-preview",
          viewId: 1363337,
          count: 5,
          summary: {
            roomCounts: [
              { key: "403", count: 22 },
              { key: "405", count: 1 },
              { key: "407", count: 18 }
            ]
          },
          items: [
            {
              elementId: 4005,
              category: "MEP Spaces",
              builtInCategory: "OST_MEPSpaces",
              categoryToken: "OST_MEPSpaces",
              space: { number: "405", name: "Live/Work Loft Unit" },
              bbox: { image: { minNormalizedX: 0.06, minNormalizedY: 0.48, maxNormalizedX: 0.55, maxNormalizedY: 0.9 } }
            },
            {
              elementId: 5005,
              category: "Space Tags",
              builtInCategory: "OST_MEPSpaceTags",
              visibleText: "Live/Work Loft Unit 405",
              taggedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.35, normalizedY: 0.64, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } }
            }
          ]
        }
      },
      ...unit405PlacementToolResults()
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  return {
    name: "sheet_placed_view_same_adjacent_circuit_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1,
    expected: "/revit/create-similar-from-instance preview from active sheet + visible room/device context without explicit room or circuit text",
    ...summary
  };
}

function runGenericVisibleCircuitLabelFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    workbenchResults: [
      {
        index: 1,
        type: "redline_orient",
        ok: true,
        summary: "mapped red mark to placed model view",
        details: {
          mapping: {
            summary: { region_count: 1, viewport_regions: 1, titleblock_regions: 0, sheet_regions: 0, unique_view_ids: [1363337] },
            regions: [
              {
                index: 1,
                primary_target: { kind: "viewport", view_id: 1363337, score: 0.95 },
                targets: [
                  {
                    kind: "viewport",
                    view_id: 1363337,
                    score: 0.95,
                    overlap_ratio: 0.3,
                    contains_center: true,
                    view_hint: { normalized_x: 0.045, normalized_y: 0.54 }
                  }
                ]
              }
            ]
          }
        }
      }
    ] as any,
    toolResults: [
      {
        action_id: "sheet-detail-e104-generic-circuit-preview",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-generic-circuit-preview",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-circuit-preview",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 6005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "P405/1",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } }
            }
          ]
        }
      },
      ...unit405PlacementToolResults()
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  return {
    name: "generic_visible_circuit_label_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1,
    expected: "/revit/create-similar-from-instance preview from active sheet + generic visible P405/1 label near the mark without explicit room or circuit text",
    ...summary
  };
}

function runGenericVisibleCircuitLabelNoPickFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-generic-circuit-no-pick",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-generic-circuit-no-pick",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-circuit-no-pick",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 6005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "P405/1",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } }
            }
          ]
        }
      },
      ...unit405PlacementToolResults()
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  const placement = placements[0] as Record<string, unknown> | undefined;
  const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
  return {
    name: "generic_visible_circuit_label_no_pick_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1 &&
      targetChainage !== null &&
      Math.abs(targetChainage - 2) > 0.25 &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/create-similar-from-instance preview from native visible circuit/device anchors even when redline pick hints are absent, without falling back to generic chainage",
    ...summary
  };
}

function runVisibleUnitLabelNoPickAdjacentCircuitFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-unit-label-no-pick",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-unit-label-no-pick",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-unit-label-no-pick",
          viewId: 1363337,
          count: 4,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 7005,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "405", name: "Live/Work Loft Unit", type: "Space" },
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.54, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.54, insideFrame: true } }
            }
          ]
        }
      },
      ...unit405PlacementToolResults()
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  const placement = placements[0] as Record<string, unknown> | undefined;
  const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
  return {
    name: "visible_unit_label_no_pick_adjacent_circuit_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1 &&
      targetChainage !== null &&
      Math.abs(targetChainage - 2) > 0.25 &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/create-similar-from-instance preview from native visible unit label plus adjacent same-room device when redline pick hints and explicit circuit text are absent",
    ...summary
  };
}

function runGenericUnitLabelNoPickUnlabeledDeviceFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-label-unlabeled-device",
          viewId: 1363337,
          count: 6,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 7403,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Unit 403",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.42, insideFrame: true } }
            },
            {
              elementId: 7405,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 7407,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Unit 407",
              anchor: { image: { normalizedX: 0.92, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 1505,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2707,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit 407", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        action_id: "contents-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390405,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390405, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1505],
          elements: [
            { id: 1505, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2505, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        action_id: "rank-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1505,
          candidates: [
            {
              elementId: 1505,
              hostElementId: 2505,
              roomSide: "left",
              electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" }
            }
          ]
        }
      },
      {
        action_id: "wall-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2505,
              supportsPlacement: true,
              placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2505,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-label-unlabeled-device",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context-generic-label-unlabeled-device",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1505,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390405, kind: "Space" },
          placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2505, projectedPoint: [0, 0, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2505, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1505,
                hostElementId: 2505,
                roomNumber: "405",
                roomSide: "left",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  const placement = placements[0] as Record<string, unknown> | undefined;
  const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
  return {
    name: "generic_unit_label_no_pick_unlabeled_device_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1505 &&
      body.hostElementId === 2505 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1 &&
      targetChainage !== null &&
      Math.abs(targetChainage - 2) > 0.25 &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/create-similar-from-instance preview from generic Unit label anchors plus an unlabeled adjacent device with a generic source circuit",
    ...summary
  };
}

function runSplitUnitLabelNoPickActiveSheetFullPreviewCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-split-unit-label-no-pick",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-split-unit-label-no-pick",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-split-unit-label-no-pick",
          viewId: 1363337,
          count: 6,
          summary: {
            roomCounts: [
              { key: "407", count: 44 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 7605,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              parameters: { "Text String": "Live/Work Loft Unit" },
              anchor: { image: { normalizedX: 0.47, normalizedY: 0.49, insideFrame: true } }
            },
            {
              elementId: 7606,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              parameters: { "Text String": "405" },
              anchor: { image: { normalizedX: 0.47, normalizedY: 0.62, insideFrame: true } }
            },
            {
              elementId: 1002,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "P405", "Circuit Number": "1" }
            },
            {
              elementId: 2001,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit", type: "Space" },
              parameters: { Panel: "P407", "Circuit Number": "1" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.55, insideFrame: true } }
            }
          ]
        }
      },
      ...unit405PlacementToolResults()
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  const placement = placements[0] as Record<string, unknown> | undefined;
  const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
  return {
    name: "split_unit_label_no_pick_active_sheet_full_preview",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      body.exemplarElementId === 1002 &&
      body.hostElementId === 2002 &&
      body.roomNumber === "405" &&
      body.roomSide === "left" &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true &&
      body.dryRun === true &&
      placements.length === 1 &&
      targetChainage !== null &&
      Math.abs(targetChainage - 2) > 0.25 &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/create-similar-from-instance preview from active sheet when a generic Unit label is split across Text String parameters and redline pick hints are absent",
    ...summary
  };
}

function runGenericUnitLabelNoPickUnlabeledDeviceCompletionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-label-unlabeled-device-complete",
          viewId: 1363337,
          count: 6,
          summary: {
            roomCounts: [
              { key: "407", count: 50 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 7405,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 1505,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2707,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit 407", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        action_id: "contents-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390405,
          roomNumber: "405",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390405, type: "Space", number: "405", confidence: 0.98, matchMode: "exact" },
          elementIds: [1505]
        }
      },
      {
        action_id: "rank-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1505,
          candidates: [
            {
              elementId: 1505,
              hostElementId: 2505,
              roomSide: "left",
              electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" }
            }
          ]
        }
      },
      {
        action_id: "wall-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2505,
              supportsPlacement: true,
              placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2505,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-label-unlabeled-device-complete",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1505,
          insertionPoint: { x: 0.5, y: 5, z: 1.5 },
          room: { number: "405", name: "Live/Work Loft Unit 405", id: 1390405, kind: "Space" },
          placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2505, projectedPoint: [0, 0, 0], tangent: [0, 1, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2505, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1505,
                hostElementId: 2505,
                roomNumber: "405",
                roomSide: "left",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      },
      {
        action_id: "apply-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735905],
          placements: [
            {
              index: 0,
              elementId: 1735905,
              label: "mark 1"
            }
          ]
        }
      },
      {
        action_id: "capture-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/export-view-region",
        status: "done",
        result_json: { imagePath: "artifacts/checks/unit-405-generic-label-unlabeled-device-complete.png" }
      },
      {
        action_id: "audit-generic-label-unlabeled-device-complete",
        method: "POST",
        path: "/revit/audit-hosted-instance-placement",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735905],
          validIds: [1735905],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735905,
              electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" },
              placementContext: {
                elementId: 1735905,
                insertionPoint: [8.5, 0.5, 1.5],
                room: { number: "405" },
                placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" }
              }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  return {
    name: "generic_unit_label_no_pick_unlabeled_device_completion",
    ok:
      summary.actual === "no actions" &&
      /Placed and verified receptacle 1735905/i.test(summary.assistant_message) &&
      /1735905=L4PA\/7/i.test(summary.assistant_message) &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "complete no-pick same-circuit placement from generic Unit label anchors plus an unlabeled adjacent device with generic source circuit evidence",
    ...summary
  };
}

function runGenericUnitLabelNoPickRoomContentsFailureRecoveryCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-generic-label-room-contents-fail",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-generic-label-room-contents-fail",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-generic-label-room-contents-fail",
          viewId: 1363337,
          count: 5,
          summary: {
            roomCounts: [
              { key: "407", count: 40 },
              { key: "405", count: 1 }
            ]
          },
          items: [
            {
              elementId: 7405,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Loft Unit 405",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.56, insideFrame: true } }
            },
            {
              elementId: 1505,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              anchor: { image: { normalizedX: 0.08, normalizedY: 0.56, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            },
            {
              elementId: 2707,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "407", name: "Live/Work Unit 407", type: "Space" },
              anchor: { image: { normalizedX: 0.91, normalizedY: 0.55, insideFrame: true } },
              parameters: { Panel: "P407", "Circuit Number": "1" }
            }
          ]
        }
      },
      {
        action_id: "rooms-generic-label-room-contents-fail",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: { roomNumber: "405", id: 1390405, name: "Live/Work Loft Unit 405", spatialKind: "Space" }
      },
      {
        action_id: "contents-generic-label-room-contents-fail-a",
        method: "POST",
        path: "/revit/room-contents",
        status: "failed",
        error: "native room-contents unavailable"
      },
      {
        action_id: "contents-generic-label-room-contents-fail-b",
        method: "POST",
        path: "/revit/room-contents",
        status: "failed",
        error: "native room-contents unavailable"
      },
      {
        action_id: "wall-generic-label-room-contents-fail",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 2505,
              supportsPlacement: true,
              placementHost: { id: 2505, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2505,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 0, y: 1, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame-generic-label-room-contents-fail",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-generic-label-room-contents-fail",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  const body = first?.body as Record<string, unknown> | undefined;
  return {
    name: "generic_unit_label_no_pick_room_contents_failure_recovery",
    ok:
      first?.path === "/revit/rank-similar-devices-on-wall" &&
      body?.roomNumber === "405" &&
      body?.roomSide === "left" &&
      !!body?.targetPointXyz &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "/revit/rank-similar-devices-on-wall after generic Unit-label room inference when native room-contents is unavailable",
    ...summary
  };
}

function runVisibleUnitLabelNoPickAdjacentCircuitFullPreviewMatrixCase(): RedlineRoutingReadinessCaseResult {
  const scenarios = [
    { room: "403", side: "bottom", exemplarId: 1503, hostId: 2503, unitLabel: "Live/Work Unit 403", circuit: "L4PA/7", mark: { x: 0.34, y: 0.86 }, otherRoom: "405" },
    { room: "405", side: "left", exemplarId: 1505, hostId: 2505, unitLabel: "Live/Work Loft Unit 405", circuit: "P405/1", mark: { x: 0.08, y: 0.54 }, otherRoom: "407" },
    { room: "407", side: "right", exemplarId: 1507, hostId: 2507, unitLabel: "Live/Work Unit 407", circuit: "L4PB/22", mark: { x: 0.91, y: 0.55 }, otherRoom: "405" }
  ] as const;

  const results = scenarios.map((scenario) => {
    const [panel, circuitNumber] = scenario.circuit.split("/");
    const response = __testOnlyBuildRedlineExecutionBridge({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
          }
        }
      },
      toolResults: [
        {
          action_id: `sheet-detail-e104-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/sheets",
          status: "done",
          result_json: {
            status: "Ok",
            sheetNumber: "E104",
            viewId: 1391195,
            sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
            viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
            placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
          }
        },
        {
          action_id: `inventory-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: {
            frameId: `inventory-unit-${scenario.room}-no-pick-matrix`,
            viewId: 1363337,
            count: 5,
            summary: {
              roomCounts: [
                { key: scenario.otherRoom, count: 50 },
                { key: scenario.room, count: 1 }
              ]
            },
            items: [
              {
                elementId: 7000 + Number(scenario.room),
                category: "Generic Annotations",
                builtInCategory: "OST_GenericAnnotation",
                textValue: scenario.unitLabel,
                anchor: { image: { normalizedX: 0.48, normalizedY: 0.55, insideFrame: true } }
              },
              {
                elementId: scenario.exemplarId,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                associatedSpatial: { number: scenario.room, name: scenario.unitLabel, type: "Space" },
                anchor: { image: { normalizedX: scenario.mark.x, normalizedY: scenario.mark.y, insideFrame: true } },
                parameters: { Panel: panel, "Circuit Number": circuitNumber }
              },
              {
                elementId: 2700 + Number(scenario.otherRoom),
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                associatedSpatial: { number: scenario.otherRoom, name: `Live/Work Unit ${scenario.otherRoom}`, type: "Space" },
                parameters: { Panel: `P${scenario.otherRoom}`, "Circuit Number": "1" },
                anchor: { image: { normalizedX: scenario.side === "right" ? 0.08 : 0.91, normalizedY: 0.55, insideFrame: true } }
              }
            ]
          }
        },
        {
          action_id: `contents-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390000 + Number(scenario.room),
            roomNumber: scenario.room,
            spatialKind: "Space",
            resolvedSpatial: { id: 1390000 + Number(scenario.room), type: "Space", number: scenario.room, confidence: 0.98, matchMode: "exact" },
            elementIds: [scenario.exemplarId],
            elements: [
              { id: scenario.exemplarId, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: scenario.hostId, point: [0.5, 5, 0] }
            ]
          }
        },
        {
          action_id: `rank-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/rank-similar-devices-on-wall",
          status: "done",
          result_json: {
            recommendedElementId: scenario.exemplarId,
            candidates: [
              {
                elementId: scenario.exemplarId,
                hostElementId: scenario.hostId,
                roomSide: scenario.side,
                electricalCircuit: { primaryLabel: scenario.circuit, panel, circuitNumber }
              }
            ]
          }
        },
        {
          action_id: `wall-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/resolve-room-wall",
          status: "done",
          result_json: {
            status: "Ok",
            roomNumber: scenario.room,
            requestedRoomSide: scenario.side,
            walls: [
              {
                hostElementId: scenario.hostId,
                supportsPlacement: true,
                placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
                hostContext: {
                  hostElementId: scenario.hostId,
                  projectedPoint: { x: 0, y: 0, z: 0 },
                  tangent: { x: scenario.side === "bottom" ? 1 : 0, y: scenario.side === "bottom" ? 0 : 1, z: 0 },
                  curveLengthFt: 10
                }
              }
            ]
          }
        },
        {
          action_id: `frame-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: `frame-unit-${scenario.room}-no-pick-matrix`,
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        },
        {
          action_id: `placement-context-unit-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/get-placement-context",
          status: "done",
          result_json: {
            status: "Ok",
            elementId: scenario.exemplarId,
            insertionPoint: { x: 0.5, y: 5, z: 1.5 },
            room: { number: scenario.room, name: scenario.unitLabel, id: 1390000 + Number(scenario.room), kind: "Space" },
            placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
            wallPlacement: { hostElementId: scenario.hostId, projectedPoint: [0, 0, 0], tangent: scenario.side === "bottom" ? [1, 0, 0] : [0, 1, 0] },
            hostLocalFrame: { basis: "WallCurve", hostElementId: scenario.hostId, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
            diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
            suggestedPlacement: {
              createSimilar: {
                action: "/revit/create-similar-from-instance",
                body: {
                  exemplarElementId: scenario.exemplarId,
                  hostElementId: scenario.hostId,
                  roomNumber: scenario.room,
                  roomSide: scenario.side,
                  dryRun: true,
                  includePreviewImage: true
                }
              }
            }
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
    const placements = Array.isArray(body?.placements) ? body.placements : [];
    const placement = placements[0] as Record<string, unknown> | undefined;
    const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
    return {
      scenario,
      summary,
      body,
      targetChainage,
      ok:
        summary.actions[0]?.path === "/revit/computer-use-guard" &&
        !!body &&
        body.exemplarElementId === scenario.exemplarId &&
        body.hostElementId === scenario.hostId &&
        body.roomNumber === scenario.room &&
        body.roomSide === scenario.side &&
        body.matchElectricalCircuitFromSource === true &&
        body.requireElectricalCircuitMatch === true &&
        body.dryRun === true &&
        placements.length === 1 &&
        targetChainage !== null &&
        Math.abs(targetChainage - 2) > 0.25 &&
        !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message)
    };
  });

  return {
    name: "visible_unit_label_no_pick_adjacent_circuit_full_preview_matrix",
    ok: results.every((result) => result.ok),
    expected: "/revit/create-similar-from-instance preview from no-pick visible unit labels plus adjacent same-room devices, including generic source circuit labels",
    actual: results
      .map((result) => `${result.scenario.room}/${result.scenario.side}/${result.scenario.circuit}:${result.summary.actual}:${String(result.body?.roomNumber ?? "")}:${String(result.body?.roomSide ?? "")}:${String(result.targetChainage ?? "")}`)
      .join("; "),
    assistant_message: results.map((result) => `${result.scenario.room}: ${result.summary.assistant_message}`).join("\n"),
    actions: results.flatMap((result) =>
      result.summary.actions.map((action) => ({
        path: action.path,
        body: { scenario: `${result.scenario.room}/${result.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
}

function runGenericVisibleCircuitLabelNoPickFullPreviewMatrixCase(): RedlineRoutingReadinessCaseResult {
  const scenarios = [
    { room: "403", side: "bottom", exemplarId: 1403, hostId: 2403, circuit: "P403/1", mark: { x: 0.34, y: 0.86 }, otherRoom: "405" },
    { room: "405", side: "left", exemplarId: 1405, hostId: 2405, circuit: "P405/1", mark: { x: 0.08, y: 0.54 }, otherRoom: "407" },
    { room: "407", side: "right", exemplarId: 1407, hostId: 2407, circuit: "P407/1", mark: { x: 0.91, y: 0.55 }, otherRoom: "405" }
  ] as const;

  const results = scenarios.map((scenario) => {
    const [panel, circuitNumber] = scenario.circuit.split("/");
    const response = __testOnlyBuildRedlineExecutionBridge({
      userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
      context: {
        revit: {
          document: {
            activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
          }
        }
      },
      toolResults: [
        {
          action_id: `sheet-detail-e104-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/sheets",
          status: "done",
          result_json: {
            status: "Ok",
            sheetNumber: "E104",
            viewId: 1391195,
            sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
            viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
            placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
          }
        },
        {
          action_id: `inventory-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/export-visible-elements",
          status: "done",
          result_json: {
            frameId: `inventory-${scenario.room}-no-pick-matrix`,
            viewId: 1363337,
            count: 5,
            summary: {
              roomCounts: [
                { key: scenario.otherRoom, count: 50 },
                { key: scenario.room, count: 1 }
              ]
            },
            items: [
              {
                elementId: 6000 + Number(scenario.room),
                category: "Generic Annotations",
                builtInCategory: "OST_GenericAnnotation",
                textValue: scenario.circuit,
                anchor: { image: { normalizedX: scenario.mark.x, normalizedY: scenario.mark.y, insideFrame: true } }
              },
              {
                elementId: scenario.exemplarId,
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                anchor: { image: { normalizedX: scenario.mark.x, normalizedY: scenario.mark.y, insideFrame: true } },
                parameters: { Panel: panel, "Circuit Number": circuitNumber }
              },
              {
                elementId: 2600 + Number(scenario.otherRoom),
                category: "Electrical Fixtures",
                builtInCategory: "OST_ElectricalFixtures",
                name: "Duplex Receptacle",
                associatedSpatial: { number: scenario.otherRoom, name: `Live/Work Unit ${scenario.otherRoom}`, type: "Space" },
                parameters: { Panel: `P${scenario.otherRoom}`, "Circuit Number": "1" },
                anchor: { image: { normalizedX: scenario.side === "right" ? 0.08 : 0.91, normalizedY: 0.55, insideFrame: true } }
              }
            ]
          }
        },
        {
          action_id: `contents-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390000 + Number(scenario.room),
            roomNumber: scenario.room,
            spatialKind: "Space",
            resolvedSpatial: { id: 1390000 + Number(scenario.room), type: "Space", number: scenario.room, confidence: 0.98, matchMode: "exact" },
            elementIds: [scenario.exemplarId],
            elements: [
              { id: scenario.exemplarId, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: scenario.hostId, point: [0.5, 5, 0] }
            ]
          }
        },
        {
          action_id: `rank-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/rank-similar-devices-on-wall",
          status: "done",
          result_json: {
            recommendedElementId: scenario.exemplarId,
            candidates: [
              {
                elementId: scenario.exemplarId,
                hostElementId: scenario.hostId,
                roomSide: scenario.side,
                electricalCircuit: { primaryLabel: scenario.circuit, panel, circuitNumber }
              }
            ]
          }
        },
        {
          action_id: `wall-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/resolve-room-wall",
          status: "done",
          result_json: {
            status: "Ok",
            roomNumber: scenario.room,
            requestedRoomSide: scenario.side,
            walls: [
              {
                hostElementId: scenario.hostId,
                supportsPlacement: true,
                placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
                hostContext: {
                  hostElementId: scenario.hostId,
                  projectedPoint: { x: 0, y: 0, z: 0 },
                  tangent: { x: scenario.side === "bottom" ? 1 : 0, y: scenario.side === "bottom" ? 0 : 1, z: 0 },
                  curveLengthFt: 10
                }
              }
            ]
          }
        },
        {
          action_id: `frame-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: `frame-${scenario.room}-no-pick-matrix`,
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        },
        {
          action_id: `placement-context-${scenario.room}-no-pick-matrix`,
          method: "POST",
          path: "/revit/get-placement-context",
          status: "done",
          result_json: {
            status: "Ok",
            elementId: scenario.exemplarId,
            insertionPoint: { x: 0.5, y: 5, z: 1.5 },
            room: { number: scenario.room, name: `Live/Work Unit ${scenario.room}`, id: 1390000 + Number(scenario.room), kind: "Space" },
            placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
            wallPlacement: { hostElementId: scenario.hostId, projectedPoint: [0, 0, 0], tangent: scenario.side === "bottom" ? [1, 0, 0] : [0, 1, 0] },
            hostLocalFrame: { basis: "WallCurve", hostElementId: scenario.hostId, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
            diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
            suggestedPlacement: {
              createSimilar: {
                action: "/revit/create-similar-from-instance",
                body: {
                  exemplarElementId: scenario.exemplarId,
                  hostElementId: scenario.hostId,
                  roomNumber: scenario.room,
                  roomSide: scenario.side,
                  dryRun: true,
                  includePreviewImage: true
                }
              }
            }
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
    const placements = Array.isArray(body?.placements) ? body.placements : [];
    const placement = placements[0] as Record<string, unknown> | undefined;
    const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
    return {
      scenario,
      summary,
      body,
      targetChainage,
      ok:
        summary.actions[0]?.path === "/revit/computer-use-guard" &&
        !!body &&
        body.exemplarElementId === scenario.exemplarId &&
        body.hostElementId === scenario.hostId &&
        body.roomNumber === scenario.room &&
        body.roomSide === scenario.side &&
        body.matchElectricalCircuitFromSource === true &&
        body.requireElectricalCircuitMatch === true &&
        body.dryRun === true &&
        placements.length === 1 &&
        targetChainage !== null &&
        Math.abs(targetChainage - 2) > 0.25 &&
        !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message)
    };
  });

  return {
    name: "generic_visible_circuit_label_no_pick_full_preview_matrix",
    ok: results.every((result) => result.ok),
    expected: "/revit/create-similar-from-instance preview from no-pick native visible circuit/device context across 403/405/407 room-side variants",
    actual: results
      .map((result) => `${result.scenario.room}/${result.scenario.side}:${result.summary.actual}:${String(result.body?.roomNumber ?? "")}:${String(result.body?.roomSide ?? "")}:${String(result.targetChainage ?? "")}`)
      .join("; "),
    assistant_message: results.map((result) => `${result.scenario.room}: ${result.summary.assistant_message}`).join("\n"),
    actions: results.flatMap((result) =>
      result.summary.actions.map((action) => ({
        path: action.path,
        body: { scenario: `${result.scenario.room}/${result.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
}

function runVisibleUnitLabelNoPickGenericSourceCompletionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: {
      revit: {
        document: {
          activeView: { id: 1391195, name: "E104 - POWER PLAN L4", type: "DrawingSheet" }
        }
      }
    },
    toolResults: [
      {
        action_id: "sheet-detail-e104-unit-403-complete",
        method: "POST",
        path: "/revit/sheets",
        status: "done",
        result_json: {
          status: "Ok",
          sheetNumber: "E104",
          viewId: 1391195,
          sheetOutline: { minU: 0, minV: 0, maxU: 10, maxV: 5 },
          viewportGeometry: [{ viewportId: 1483922, viewId: 1363337, rotation: "None", box: { minU: 0, minV: 0, maxU: 10, maxV: 5 } }],
          placedViews: [{ viewId: 1363337, name: "L4 - Power", viewType: "FloorPlan" }]
        }
      },
      {
        action_id: "inventory-unit-403-complete",
        method: "POST",
        path: "/revit/export-visible-elements",
        status: "done",
        result_json: {
          frameId: "inventory-unit-403-complete",
          viewId: 1363337,
          count: 4,
          summary: { roomCounts: [{ key: "405", count: 50 }, { key: "403", count: 1 }] },
          items: [
            {
              elementId: 7403,
              category: "Generic Annotations",
              builtInCategory: "OST_GenericAnnotation",
              textValue: "Live/Work Unit 403",
              anchor: { image: { normalizedX: 0.48, normalizedY: 0.55, insideFrame: true } }
            },
            {
              elementId: 1503,
              category: "Electrical Fixtures",
              builtInCategory: "OST_ElectricalFixtures",
              name: "Duplex Receptacle",
              associatedSpatial: { number: "403", name: "Live/Work Unit 403", type: "Space" },
              anchor: { image: { normalizedX: 0.34, normalizedY: 0.86, insideFrame: true } },
              parameters: { Panel: "L4PA", "Circuit Number": "7" }
            }
          ]
        }
      },
      {
        action_id: "contents-unit-403-complete",
        method: "POST",
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390403,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390403, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1503]
        }
      },
      {
        action_id: "rank-unit-403-complete",
        method: "POST",
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1503,
          candidates: [
            {
              elementId: 1503,
              hostElementId: 2503,
              roomSide: "bottom",
              electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" }
            }
          ]
        }
      },
      {
        action_id: "wall-unit-403-complete",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          requestedRoomSide: "bottom",
          walls: [
            {
              hostElementId: 2503,
              supportsPlacement: true,
              placementHost: { id: 2503, category: "Walls", builtInCategory: "OST_Walls" },
              hostContext: {
                hostElementId: 2503,
                projectedPoint: { x: 0, y: 0, z: 0 },
                tangent: { x: 1, y: 0, z: 0 },
                curveLengthFt: 10
              }
            }
          ]
        }
      },
      {
        action_id: "frame-unit-403-complete",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-unit-403-complete",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        action_id: "placement-context-unit-403-complete",
        method: "POST",
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1503,
          insertionPoint: { x: 5, y: 0.5, z: 1.5 },
          room: { number: "403", name: "Live/Work Unit 403", id: 1390403, kind: "Space" },
          placementHost: { id: 2503, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: { hostElementId: 2503, projectedPoint: [0, 0, 0], tangent: [1, 0, 0] },
          hostLocalFrame: { basis: "WallCurve", hostElementId: 2503, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1503,
                hostElementId: 2503,
                roomNumber: "403",
                roomSide: "bottom",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      },
      {
        action_id: "apply-unit-403-complete",
        method: "POST",
        path: "/revit/create-similar-from-instance",
        status: "done",
        result_json: {
          status: "Placed",
          dryRun: false,
          elementIds: [1735901],
          placements: [
            {
              index: 0,
              elementId: 1735901,
              label: "mark 1"
            }
          ]
        }
      },
      {
        action_id: "capture-unit-403-complete",
        method: "POST",
        path: "/revit/export-view-region",
        status: "done",
        result_json: { imagePath: "artifacts/checks/unit-403-generic-source-complete.png" }
      },
      {
        action_id: "audit-unit-403-complete",
        method: "POST",
        path: "/revit/audit-hosted-instance-placement",
        status: "done",
        result_json: {
          status: "Ok",
          auditedIds: [1735901],
          validIds: [1735901],
          invalidIds: [],
          offRoomIds: [],
          offWallIds: [],
          unsupportedIds: [],
          missingIds: [],
          items: [
            {
              elementId: 1735901,
              electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" },
              placementContext: {
                elementId: 1735901,
                insertionPoint: [8.5, 0.5, 1.5],
                room: { number: "403" },
                placementHost: { id: 2503, category: "Walls", builtInCategory: "OST_Walls" },
                diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
                electricalCircuit: { primaryLabel: "L4PA/7", panel: "L4PA", circuitNumber: "7" }
              }
            }
          ]
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  return {
    name: "visible_unit_label_no_pick_generic_source_completion",
    ok:
      summary.actual === "no actions" &&
      /Placed and verified receptacle 1735901/i.test(summary.assistant_message) &&
      /1735901=L4PA\/7/i.test(summary.assistant_message) &&
      !/no_pick_hints|did not recover usable pick locations/i.test(summary.assistant_message),
    expected: "complete no-pick visible-unit same-circuit placement when ranked adjacent source circuit is generic and create-similar apply omits source echo",
    ...summary
  };
}

function runRoomWallExemplarFallbackCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    targetViewId: 1391195,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "405",
      spatial_side: "left",
      spatial_side_source: "left"
    } as any,
    viewportHints: [{ view_id: 1391195, normalized_x: 0.25, normalized_y: 0.6, score: 0.96 }],
    toolResults: [
      {
        action_id: "rooms-405",
        method: "POST",
        path: "/revit/rooms",
        status: "done",
        result_json: { roomNumber: "405", id: 1390985, name: "Live/Work Loft Unit" }
      },
      {
        action_id: "contents-405-a",
        method: "POST",
        path: "/revit/room-contents",
        status: "failed",
        error: "native room-contents unavailable"
      },
      {
        action_id: "contents-405-b",
        method: "POST",
        path: "/revit/room-contents",
        status: "failed",
        error: "native room-contents unavailable"
      },
      {
        action_id: "wall-405",
        method: "POST",
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          roomNumber: "405",
          requestedRoomSide: "left",
          walls: [
            {
              hostElementId: 1362765,
              supportsPlacement: true,
              wallPlacement: {
                hostElementId: 1362765,
                projectedPoint: [-60, -8, 33.66],
                tangent: [0, 1, 0]
              }
            }
          ]
        }
      },
      {
        action_id: "frame-405",
        method: "POST",
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-405",
          viewId: 1391195,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  const targetPoint = first?.body && typeof first.body === "object" ? (first.body as Record<string, unknown>).targetPointXyz : null;
  return {
    name: "room_wall_exemplar_fallback_after_room_contents_failure",
    ok:
      first?.path === "/revit/rank-similar-devices-on-wall" &&
      (first.body as Record<string, unknown> | undefined)?.roomNumber === "405" &&
      (first.body as Record<string, unknown> | undefined)?.roomSide === "left" &&
      !!targetPoint,
    expected: "/revit/rank-similar-devices-on-wall with mapped targetPointXyz after room wall resolution when room-contents is unavailable",
    ...summary
  };
}

function runNearestSameCircuitExemplarCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "add receptacle in room 403 where indicated and circuit to P403/1",
    targetViewId: 1363337,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "403",
      spatial_side: null,
      spatial_side_source: null
    } as any,
    viewportHints: [{ view_id: 1363337, normalized_x: 0.02, normalized_y: 0.5, score: 0.95 }],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1001, 1002],
          boundaryLoops: [
            [
              { start: [0, 0, 0], end: [10, 0, 0] },
              { start: [10, 0, 0], end: [10, 10, 0] },
              { start: [10, 10, 0], end: [0, 10, 0] },
              { start: [0, 10, 0], end: [0, 0, 0] }
            ]
          ],
          elements: [
            { id: 1001, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2001, point: [8.5, 5, 0] },
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [0.5, 5, 0] }
          ]
        }
      },
      {
        path: "/revit/get-parameters",
        status: "done",
        result_json: {
          items: [
            { id: 1001, category: "Electrical Fixtures", name: "Duplex Receptacle", parameters: { Panel: "P403", "Circuit Number": "1" } },
            { id: 1002, category: "Electrical Fixtures", name: "Duplex Receptacle", parameters: { Panel: "P403", "Circuit Number": "1" } }
          ]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          requestedRoomSide: "left",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 5, 0],
          wallTangent: [0, 1, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const first = summary.actions[0];
  return {
    name: "nearest_same_circuit_exemplar_selection",
    ok: first?.path === "/revit/get-placement-context" && (first.body as Record<string, unknown> | undefined)?.elementId === 1002,
    expected: "/revit/get-placement-context uses the nearest room-scoped P403/1 exemplar, not the first matching circuit row",
    ...summary
  };
}

function runCopyTwicePlacementIntentCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildSpatialRedlineRefinementBridge({
    userText: "pick the existing bottom-wall Unit 403 receptacle whose tag text is P403/1 as source and copy it twice with same host and parameters",
    targetViewId: 1363337,
    targetProfile: {
      categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
      pick_preference: "modelGeometry",
      scope_label: "spatial electrical-device",
      resolve_only: true,
      parameter_names: ["Panel", "Circuit Number"],
      spatial_terms: ["directional"],
      region_padding_ft: 0.08,
      room_number: "403",
      spatial_side: "bottom",
      spatial_side_source: "bottom"
    } as any,
    viewportHints: [],
    toolResults: [
      {
        path: "/revit/room-contents",
        status: "done",
        result_json: {
          roomId: 1390984,
          roomNumber: "403",
          spatialKind: "Space",
          resolvedSpatial: { id: 1390984, type: "Space", number: "403", confidence: 0.98, matchMode: "exact" },
          elementIds: [1002],
          elements: [
            { id: 1002, category: "Electrical Fixtures", builtInCategory: "OST_ElectricalFixtures", hostId: 2002, point: [5, 0.5, 0] }
          ]
        }
      },
      {
        path: "/revit/rank-similar-devices-on-wall",
        status: "done",
        result_json: {
          recommendedElementId: 1002,
          candidates: [{ elementId: 1002, hostElementId: 2002, roomSide: "bottom", electricalCircuit: { primaryLabel: "P403/1" } }]
        }
      },
      {
        path: "/revit/resolve-room-wall",
        status: "done",
        result_json: {
          status: "Ok",
          roomNumber: "403",
          requestedRoomSide: "bottom",
          hostElementId: 2002,
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallProjectedPoint: [0, 0, 0],
          wallTangent: [1, 0, 0],
          diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } }
        }
      },
      {
        path: "/revit/export-view-frame",
        status: "done",
        result_json: {
          frameId: "frame-403-copy",
          viewId: 1363337,
          widthPx: 1000,
          heightPx: 1000,
          mapping: {
            topLeftXyz: [0, 10, 0],
            topRightXyz: [10, 10, 0],
            bottomLeftXyz: [0, 0, 0]
          }
        }
      },
      {
        path: "/revit/get-placement-context",
        status: "done",
        result_json: {
          status: "Ok",
          elementId: 1002,
          insertionPoint: { x: 5, y: 0.5, z: 1.5 },
          room: { number: "403", name: "Live/Work Unit 403", id: 1390984, kind: "Space" },
          placementHost: { id: 2002, category: "Walls", builtInCategory: "OST_Walls" },
          wallPlacement: {
            hostElementId: 2002,
            projectedPoint: [0, 0, 0],
            tangent: [1, 0, 0]
          },
          hostLocalFrame: {
            basis: "WallCurve",
            hostElementId: 2002,
            chainageFt: 5,
            normalizedChainage: 0.5,
            curveLengthFt: 10
          },
          diagnostics: {
            hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" }
          },
          suggestedPlacement: {
            createSimilar: {
              action: "/revit/create-similar-from-instance",
              body: {
                exemplarElementId: 1002,
                hostElementId: 2002,
                roomNumber: "403",
                roomSide: "bottom",
                dryRun: true,
                includePreviewImage: true
              }
            }
          }
        }
      }
    ] as ToolResult[]
  });
  const summary = summarizeResponse(response);
  const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
  const placements = Array.isArray(body?.placements) ? body.placements : [];
  return {
    name: "copy_twice_create_similar_intent",
    ok:
      summary.actions[0]?.path === "/revit/computer-use-guard" &&
      !!body &&
      placements.length === 2 &&
      body.matchElectricalCircuitFromSource === true &&
      body.requireElectricalCircuitMatch === true,
    expected: "/revit/create-similar-from-instance previews two copied receptacles and preserves source circuit for copy-twice wording",
    ...summary
  };
}

function runRankedAdjacentSidePreservationCase(): RedlineRoutingReadinessCaseResult {
  const scenarios = [
    { room: "403", side: "bottom", misleadingSide: "left", exemplarId: 1001, hostId: 2001, circuit: "P403/1", hint: { x: 0.18, y: 0.72 } },
    { room: "405", side: "left", misleadingSide: "bottom", exemplarId: 1002, hostId: 2002, circuit: "P405/1", hint: { x: 0.48, y: 0.84 } },
    { room: "407", side: "right", misleadingSide: "bottom", exemplarId: 1003, hostId: 2003, circuit: "P407/1", hint: { x: 0.82, y: 0.62 } }
  ] as const;
  const scenarioResults = scenarios.map((scenario) => {
    const response = __testOnlyBuildSpatialRedlineRefinementBridge({
      userText: `add receptacle in room ${scenario.room} where indicated and circuit to same circuit as adjacent receptacle`,
      targetViewId: 1363337,
      targetProfile: {
        categories: ["OST_ElectricalFixtures", "OST_ElectricalDevices"],
        pick_preference: "modelGeometry",
        scope_label: "spatial electrical-device",
        resolve_only: true,
        parameter_names: ["Panel", "Circuit Number"],
        spatial_terms: ["zone"],
        region_padding_ft: 0.08,
        room_number: scenario.room,
        spatial_side: scenario.misleadingSide,
        spatial_side_source: scenario.misleadingSide
      } as any,
      viewportHints: [{ view_id: 1363337, normalized_x: scenario.hint.x, normalized_y: scenario.hint.y, score: 0.95 }],
      toolResults: [
        {
          action_id: `contents-${scenario.room}`,
          method: "POST",
          path: "/revit/room-contents",
          status: "done",
          result_json: {
            roomId: 1390000 + Number(scenario.room),
            roomNumber: scenario.room,
            spatialKind: "Space",
            resolvedSpatial: { id: 1390000 + Number(scenario.room), type: "Space", number: scenario.room, confidence: 0.98, matchMode: "exact" },
            elementIds: [scenario.exemplarId]
          }
        },
        {
          action_id: `rank-${scenario.room}`,
          method: "POST",
          path: "/revit/rank-similar-devices-on-wall",
          status: "done",
          result_json: {
            recommendedElementId: scenario.exemplarId,
            candidates: [{ elementId: scenario.exemplarId, hostElementId: scenario.hostId, roomSide: scenario.side, electricalCircuit: { primaryLabel: scenario.circuit } }]
          }
        },
        {
          action_id: `wall-${scenario.room}`,
          method: "POST",
          path: "/revit/resolve-room-wall",
          status: "done",
          result_json: {
            status: "Ok",
            roomNumber: scenario.room,
            requestedRoomSide: scenario.side,
            walls: [
              {
                hostElementId: scenario.hostId,
                supportsPlacement: true,
                placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
                hostContext: {
                  hostElementId: scenario.hostId,
                  projectedPoint: { x: 0, y: 0, z: 0 },
                  tangent: { x: 0, y: 1, z: 0 },
                  curveLengthFt: 10
                }
              }
            ]
          }
        },
        {
          action_id: `frame-${scenario.room}`,
          method: "POST",
          path: "/revit/export-view-frame",
          status: "done",
          result_json: {
            frameId: `frame-${scenario.room}`,
            viewId: 1363337,
            widthPx: 1000,
            heightPx: 1000,
            mapping: {
              topLeftXyz: [0, 10, 0],
              topRightXyz: [10, 10, 0],
              bottomLeftXyz: [0, 0, 0]
            }
          }
        },
        {
          action_id: `placement-context-${scenario.room}`,
          method: "POST",
          path: "/revit/get-placement-context",
          status: "done",
          result_json: {
            status: "Ok",
            elementId: scenario.exemplarId,
            insertionPoint: { x: 0.5, y: 5, z: 1.5 },
            room: { number: scenario.room, name: `Live/Work Unit ${scenario.room}`, id: 1390000 + Number(scenario.room), kind: "Space" },
            placementHost: { id: scenario.hostId, category: "Walls", builtInCategory: "OST_Walls" },
            wallPlacement: { hostElementId: scenario.hostId, projectedPoint: [0, 0, 0], tangent: [0, 1, 0] },
            hostLocalFrame: { basis: "WallCurve", hostElementId: scenario.hostId, chainageFt: 5, normalizedChainage: 0.5, curveLengthFt: 10 },
            diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true, reason: "same_room_wall" } },
            suggestedPlacement: {
              createSimilar: {
                action: "/revit/create-similar-from-instance",
                body: {
                  exemplarElementId: scenario.exemplarId,
                  hostElementId: scenario.hostId,
                  roomNumber: scenario.room,
                  dryRun: true,
                  includePreviewImage: true
                }
              }
            }
          }
        }
      ] as ToolResult[]
    });
    const summary = summarizeResponse(response);
    const body = summary.actions.find((action) => action.path === "/revit/create-similar-from-instance")?.body as Record<string, unknown> | undefined;
    const placement = Array.isArray(body?.placements) ? body.placements[0] as Record<string, unknown> | undefined : undefined;
    const targetChainage = typeof placement?.targetChainageFt === "number" ? placement.targetChainageFt : null;
    return {
      scenario,
      summary,
      body,
      targetChainage,
      ok:
        !!body &&
        body.exemplarElementId === scenario.exemplarId &&
        body.roomNumber === scenario.room &&
        body.roomSide === scenario.side &&
        body.matchElectricalCircuitFromSource === true &&
        body.requireElectricalCircuitMatch === true &&
        targetChainage !== null &&
        targetChainage > 0.5 &&
        targetChainage < 9.5 &&
        targetChainage !== 5
    };
  });
  const summary = {
    actual: scenarioResults
      .map((row) => `${row.scenario.room}/${row.scenario.side}:${row.summary.actual}:${String(row.body?.roomSide ?? "none")}`)
      .join("; "),
    assistant_message: scenarioResults.map((row) => `${row.scenario.room}: ${row.summary.assistant_message}`).join("\n"),
    actions: scenarioResults.flatMap((row) =>
      row.summary.actions.map((action) => ({
        path: action.path,
        body: { scenario: `${row.scenario.room}/${row.scenario.side}`, ...(action.body as Record<string, unknown> | undefined) }
      }))
    )
  };
  return {
    name: "ranked_adjacent_side_preserved_to_placement",
    ok: scenarioResults.every((row) => row.ok),
    expected: "/revit/create-similar-from-instance lets ranked same-room adjacent-device side override image-global side across room/side variants, preserves circuit, and uses an interior non-overlap fallback chainage",
    ...summary
  };
}

function runRawImageMarkDoesNotBecomeLinkHostPointCase(): RedlineRoutingReadinessCaseResult {
  const plan = __testOnlyBuildSpatialPlacementPreviewPlan({
    userText: "add receptacle where indicated and circuit to P405/1",
    spatialViewId: 1363337,
    viewportHints: [
      {
        view_id: 1363337,
        normalized_x: 0.14,
        normalized_y: 0.737,
        score: 0.72,
        source: "raw_image_mark",
        frame_aligned: false
      }
    ],
    frame: {
      frame_id: "full-view-frame",
      width_px: 1000,
      height_px: 1000,
      top_left_xyz: [-30, 40, -467.883333],
      top_right_xyz: [30, 40, -467.883333],
      bottom_left_xyz: [-30, -40, -467.883333]
    },
    placementContext: {
      element_id: 1555720,
      host_element_id: 1362762,
      create_similar_body: {
        exemplarElementId: 1555720,
        hostElementId: 1362762,
        roomNumber: "405",
        roomSide: "left",
        dryRun: true,
        includePreviewImage: true
      },
      insertion_point: [-19.760417, -13.671875, 32.166667],
      wall_projected_point: [-19.760417, -13.671875, 32.166667],
      wall_tangent: [0, -1, 0],
      placement_host_category: "RVT Links",
      placement_host_built_in_category: "OST_RvtLinks",
      room_number: "405",
      requested_room_side: "left",
      supported_host: true,
      host_chainage_ft: 13.671875,
      host_normalized_chainage: 0.515108,
      host_curve_length_ft: 26.541667
    },
    imageMarkHint: {
      normalized_x: 0.14,
      normalized_y: 0.737,
      side: "left",
      source: "raw_image_mark",
      score: 0.72,
      image_width: 762,
      image_height: 635
    }
  });
  const body = plan?.body as Record<string, unknown> | undefined;
  const placement = Array.isArray(body?.placements) ? (body.placements[0] as Record<string, unknown> | undefined) : undefined;
  const normalized = typeof placement?.targetNormalizedChainage === "number" ? placement.targetNormalizedChainage : null;
  const pointXyz = Array.isArray(placement?.pointXyz) ? placement.pointXyz as unknown[] : null;
  const pointY = typeof pointXyz?.[1] === "number" ? pointXyz[1] : null;
  const ok =
    plan?.path === "/revit/create-similar-from-instance" &&
    !!placement &&
    (normalized === null || (normalized > 0.2 && normalized < 0.7)) &&
    (pointY === null || Math.abs(pointY - -10.671875) < 0.001);
  return {
    name: "raw_image_mark_does_not_become_link_host_point_xyz",
    ok,
    expected: "raw cropped/screenshot hints must not become authoritative raw-image chainage; link-host fallback may use bounded host-local heuristic points",
    actual: plan?.path ?? "no plan",
    assistant_message: "",
    actions: plan ? [{ path: plan.path, body: plan.body }] : []
  };
}

function sameCircuitPlacementVerificationResults(opts?: {
  includeSourceCircuit?: boolean;
  createdCircuit?: string;
  sourceCircuit?: string;
  omitSourceExemplar?: boolean;
  includeRankedSourceId?: boolean;
  includeRankedSourceCircuit?: boolean;
}): ToolResult[] {
  const createdCircuit = opts?.createdCircuit ?? "P405/1";
  const [createdPanel, createdCircuitNumber] = createdCircuit.split("/");
  const sourceCircuit = opts?.sourceCircuit ?? "P405/1";
  const [sourcePanel, sourceCircuitNumber] = sourceCircuit.split("/");
  return [
    ...(opts?.includeRankedSourceCircuit || opts?.includeRankedSourceId
      ? [
          {
            action_id: "rank-source-405",
            method: "POST" as const,
            path: "/revit/rank-similar-devices-on-wall",
            status: "done" as const,
            result_json: {
              recommendedElementId: 1556486,
              candidates: [
                {
                  elementId: 1556486,
                  hostElementId: 1362765,
                  hostPlacementSupported: true,
                  roomSide: "left",
                  ...(opts?.includeRankedSourceCircuit
                    ? { electricalCircuit: { primaryLabel: sourceCircuit, panel: sourcePanel, circuitNumber: sourceCircuitNumber } }
                    : {})
                }
              ]
            }
          }
        ]
      : []),
    {
      action_id: "apply-405",
      method: "POST",
      path: "/revit/create-similar-from-instance",
      status: "done",
      result_json: {
        status: "Placed",
        dryRun: false,
        elementIds: [1735601],
        ...(opts?.omitSourceExemplar
          ? {}
          : {
              exemplar: {
                id: 1556486,
                name: "adjacent receptacle",
                ...(opts?.includeSourceCircuit
                  ? { electricalCircuit: { primaryLabel: sourceCircuit, panel: sourcePanel, circuitNumber: sourceCircuitNumber } }
                  : {})
              }
            }),
        placements: [
          {
            index: 0,
            elementId: 1735601,
            label: "mark 1",
            electricalCircuit: {
              primaryLabel: createdCircuit,
              panel: createdPanel,
              circuitNumber: createdCircuitNumber
            }
          }
        ]
      }
    },
    {
      action_id: "capture-405",
      method: "POST",
      path: "/revit/export-view-region",
      status: "done",
      result_json: { imagePath: "artifacts/checks/placed-405.png" }
    },
    {
      action_id: "audit-405",
      method: "POST",
      path: "/revit/audit-hosted-instance-placement",
      status: "done",
      result_json: {
        status: "Ok",
        auditedIds: [1735601],
        validIds: [1735601],
        invalidIds: [],
        offRoomIds: [],
        offWallIds: [],
        unsupportedIds: [],
        missingIds: [],
        items: [
          {
            elementId: 1735601,
            electricalCircuit: {
              primaryLabel: createdCircuit,
              panel: createdPanel,
              circuitNumber: createdCircuitNumber
            },
            placementContext: {
              elementId: 1735601,
              insertionPoint: [-61.2, -14.3, 32.166667],
              room: { number: "405" },
              placementHost: { id: 1362765, category: "RVT Links", builtInCategory: "OST_RvtLinks" },
              diagnostics: { hostPlacementSupport: { supported: true, sourceHostSupported: true } },
              electricalCircuit: {
                primaryLabel: createdCircuit,
                panel: createdPanel,
                circuitNumber: createdCircuitNumber
              }
            }
          }
        ]
      }
    }
  ];
}

function runSameCircuitSourceReadbackRequiredCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({ includeSourceCircuit: false })
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  return {
    name: "same_circuit_requires_source_readback",
    ok:
      action?.path === "/revit/get-parameters" &&
      Array.isArray(body?.elementIds) &&
      (body.elementIds as unknown[]).includes(1556486) &&
      (body.elementIds as unknown[]).includes(1735601),
    expected: "/revit/get-parameters for source + created ids before completing same-circuit placement",
    ...summary
  };
}

function runSameCircuitRankedSourceNoEchoCompletionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({
      omitSourceExemplar: true,
      includeRankedSourceCircuit: true
    })
  });
  const summary = summarizeResponse(response);
  return {
    name: "same_circuit_ranked_source_no_echo_completion",
    ok:
      summary.actual === "no actions" &&
      /Placed and verified receptacle 1735601/i.test(summary.assistant_message) &&
      /1735601=P405\/1/i.test(summary.assistant_message),
    expected: "complete same-circuit placement from ranked adjacent circuit evidence when apply result omits source/exemplar id",
    ...summary
  };
}

function runSameCircuitGenericSourceCompletionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({
      includeSourceCircuit: true,
      sourceCircuit: "L4PA/7",
      createdCircuit: "L4PA/7"
    })
  });
  const summary = summarizeResponse(response);
  return {
    name: "same_circuit_generic_source_completion",
    ok:
      summary.actual === "no actions" &&
      /Placed and verified receptacle 1735601/i.test(summary.assistant_message) &&
      /1735601=L4PA\/7/i.test(summary.assistant_message),
    expected: "complete same-circuit placement when adjacent source circuit is a generic panel/circuit label rather than room-derived P405/1",
    ...summary
  };
}

function runSameCircuitRankedSourceNoEchoReadbackCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle.",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({
      omitSourceExemplar: true,
      includeRankedSourceId: true
    })
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  return {
    name: "same_circuit_ranked_source_no_echo_requires_readback",
    ok:
      action?.path === "/revit/get-parameters" &&
      Array.isArray(body?.elementIds) &&
      (body.elementIds as unknown[]).includes(1556486) &&
      (body.elementIds as unknown[]).includes(1735601),
    expected: "/revit/get-parameters uses ranked adjacent source id when create-similar apply omits source/exemplar echo",
    ...summary
  };
}

function runSameCircuitMismatchCorrectionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({ includeSourceCircuit: true, createdCircuit: "P407/1" })
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  return {
    name: "same_circuit_mismatch_routes_to_assignment",
    ok:
      action?.path === "/revit/assign-electrical-circuit" &&
      Array.isArray(body?.elementIds) &&
      (body.elementIds as unknown[]).includes(1735601) &&
      body?.sourceElementId === 1556486,
    expected: "/revit/assign-electrical-circuit with sourceElementId when created circuit differs from adjacent exemplar",
    ...summary
  };
}

function runSameCircuitGenericSourceMismatchCorrectionCase(): RedlineRoutingReadinessCaseResult {
  const response = __testOnlyBuildRedlineExecutionBridge({
    userText: "add receptacle where indicated and circuit to same circuit as adjacent receptacle in room 405",
    context: activePowerPlanContext(),
    toolResults: sameCircuitPlacementVerificationResults({
      includeSourceCircuit: true,
      sourceCircuit: "L4PA/7",
      createdCircuit: "P405/1"
    })
  });
  const summary = summarizeResponse(response);
  const action = summary.actions[0];
  const body = action?.body as Record<string, unknown> | undefined;
  return {
    name: "same_circuit_generic_source_mismatch_routes_to_assignment",
    ok:
      action?.path === "/revit/assign-electrical-circuit" &&
      Array.isArray(body?.elementIds) &&
      (body.elementIds as unknown[]).includes(1735601) &&
      body?.sourceElementId === 1556486 &&
      /L4PA\/7/i.test(summary.assistant_message),
    expected: "/revit/assign-electrical-circuit copies the actual adjacent source circuit when it is generic L4PA/7",
    ...summary
  };
}

export async function runRedlineRoutingReadiness(): Promise<RedlineRoutingReadinessResult> {
  const cases = [
    await runFilenameNeutralClipboardCase(),
    await runScreenshotMarkSyntheticHintCase(),
    await runPathlessAnalyzeMarkSideCase(),
    await runPathlessAnalyzeAdjacentCircuitPlacementCase(),
    await runPathlessAnalyzeAdjacentCircuitPlacementMatrixCase(),
    await runPathlessAnalyzeAdjacentCircuitPreviewApplyCase(),
    await runPathlessAnalyzeAdjacentCircuitPostApplyVerificationCase(),
    runVisibleCircuitRoomInferenceCase(),
    runAdjacentCircuitRoomInferenceCase(),
    runOcrOnlyCircuitIgnoredForSameCircuitCase(),
    runMarkedAdjacentDeviceBeatsNoisySummaryCase(),
    runGenericVisibleUnitLabelBeatsNoisySummaryCase(),
    runGenericVisibleCircuitLabelBeatsNoisySummaryCase(),
    runAdjacentDeviceEvidenceBeatsNoisySummaryCase(),
    runAlternateVisibleInventorySchemaCase(),
    runKnownRoomGenericActiveViewResolutionCase(),
    runLateKnownRoomGenericFrameResolutionCase(),
    runSnakeCaseVisibleInventorySchemaCase(),
    runVisibleRoomLabelInferenceCase(),
    runVisibleSpaceElementRoomInferenceCase(),
    runVisibleSpaceContainmentGenericPanelCase(),
    runBboxOnlySpaceContainmentCase(),
    runSameAdjacentCircuitRoomSideMatrixCase(),
    runGenericViewPlacementDiscoveryResolveCase(),
    runGenericPanelRoomRelativeCreateSimilarCase(),
    runVisibleSpaceElementCreateSimilarCase(),
    await runNearestVisibleRoomLabelInferenceCase(),
    runCompactedAdjacentInventoryRoomInferenceCase(),
    runPrioritizedCompactedInventoryRoomInferenceCase(),
    runCompactedInventorySummaryRoomInferenceCase(),
    runRichInventoryRetryBeforeNoPickCase(),
    runUnlabeledSpatialInventoryRetryCase(),
    runRichInventoryAdjacentRoomInferenceCase(),
    runSheetPlacedViewAdjacentRoomInferenceCase(),
    runSheetPlacedViewSameAdjacentCircuitMatrixCase(),
    runSheetPlacedViewSameAdjacentCircuitFullPreviewCase(),
    runGenericVisibleCircuitLabelFullPreviewCase(),
    runGenericVisibleCircuitLabelNoPickFullPreviewCase(),
    runVisibleUnitLabelNoPickAdjacentCircuitFullPreviewCase(),
    runGenericUnitLabelNoPickUnlabeledDeviceFullPreviewCase(),
    runSplitUnitLabelNoPickActiveSheetFullPreviewCase(),
    runGenericUnitLabelNoPickUnlabeledDeviceCompletionCase(),
    runGenericUnitLabelNoPickRoomContentsFailureRecoveryCase(),
    runVisibleUnitLabelNoPickAdjacentCircuitFullPreviewMatrixCase(),
    runGenericVisibleCircuitLabelNoPickFullPreviewMatrixCase(),
    runVisibleUnitLabelNoPickGenericSourceCompletionCase(),
    runRoomWallExemplarFallbackCase(),
    runNearestSameCircuitExemplarCase(),
    runCopyTwicePlacementIntentCase(),
    runRankedAdjacentSidePreservationCase(),
    runRawImageMarkDoesNotBecomeLinkHostPointCase(),
    runSameCircuitSourceReadbackRequiredCase(),
    runSameCircuitRankedSourceNoEchoReadbackCase(),
    runSameCircuitRankedSourceNoEchoCompletionCase(),
    runSameCircuitGenericSourceCompletionCase(),
    runSameCircuitMismatchCorrectionCase(),
    runSameCircuitGenericSourceMismatchCorrectionCase()
  ];
  return {
    ok: cases.every((row) => row.ok),
    cases
  };
}
