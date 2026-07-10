import path from "node:path";
import { evaluateRedlineTagLiveAdapterReadiness } from "../redline/tag_live_adapter_contract.js";

type JsonMap = Record<string, unknown>;

const DEFAULT_LINKED_HOST_RECEPTACLE_ROOM_SIDE = "right";

export type RevitDemoDiscoveryInput = {
  bridgeUrl: string;
  context: unknown;
  sheetsBody: unknown;
  viewsBody: unknown;
  receptacleFindBody: unknown;
  receptacleQuantifyBody: unknown;
  mechanicalEquipmentQuantifyBody?: unknown;
  userProfile?: string;
  generatedAt?: string;
};

export type RevitDemoDiscoveryPayload = {
  _discovery: JsonMap;
  tasks: JsonMap;
};

function asObject(value: unknown): JsonMap {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonMap : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstNumber(...values: unknown[]): number | null {
  for (const value of values) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return null;
}

function pickFloorPlanView(views: unknown[]): JsonMap {
  const candidates = views.map(asObject);
  return (
    candidates.find((view) => /power|electrical|lighting/i.test(String(view.name ?? ""))) ??
    candidates.find((view) => /floorplan|engineeringplan|ceilingplan/i.test(String(view.type ?? ""))) ??
    candidates[0] ??
    {}
  );
}

function rowLevelMatchesView(row: JsonMap, targetView: JsonMap): boolean {
  const rowLevel = String(row.level ?? "").trim().toLowerCase();
  const viewName = String(targetView.name ?? "").trim().toLowerCase();
  return Boolean(rowLevel && viewName && (rowLevel === viewName || viewName.includes(rowLevel) || rowLevel.includes(viewName)));
}

function pickFallbackElementId(rows: JsonMap[], targetView: JsonMap): number | null {
  const preferred = rows.find((row) => String(row.source ?? "host").toLowerCase() === "host" && rowLevelMatchesView(row, targetView));
  const host = preferred ?? rows.find((row) => String(row.source ?? "host").toLowerCase() === "host") ?? rows[0];
  return firstNumber(host?.id);
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text) return text;
  }
  return "";
}

function circuitLabelFromContext(context: JsonMap): string {
  const circuit = asObject(context.electricalCircuit);
  return firstString(circuit.primaryLabel, asArray(circuit.labels)[0]);
}

function visibleElementRows(visibleElements: unknown): JsonMap[] {
  const root = asObject(visibleElements);
  const candidates = [
    ...asArray(root.elements),
    ...asArray(root.items),
    ...asArray(root.visibleElements),
    ...asArray(root.rows)
  ].map(asObject);
  return candidates.length > 0 ? candidates : [];
}

function pointFromVisibleElement(row: JsonMap): JsonMap {
  return asObject(row.point ?? row.center ?? asObject(row.anchor).model ?? asObject(row.geometry).point);
}

function taggedElementIdFromVisibleTag(row: JsonMap): number | null {
  const taggedSpatial = asObject(row.taggedSpatial ?? row.tagged_spatial);
  const taggedElement = asObject(row.taggedElement ?? row.tagged_element);
  const tagTarget = asObject(row.tagTarget ?? row.tag_target);
  return firstNumber(
    row.taggedElementId,
    row.tagged_element_id,
    row.taggedElementID,
    row.tagged_element,
    taggedElement.id,
    taggedElement.elementId,
    taggedElement.element_id,
    taggedSpatial.id,
    taggedSpatial.elementId,
    taggedSpatial.element_id,
    tagTarget.id,
    tagTarget.elementId,
    tagTarget.element_id
  );
}

function pickExistingTagMoveCandidate(visibleElements: unknown, fallbackViewId: number | null): JsonMap {
  return visibleElementRows(visibleElements).find((row) => {
    const id = firstNumber(row.id, row.elementId);
    const category = firstString(row.category, row.categoryName, row.builtInCategory, row.categoryToken);
    const visibleText = firstString(row.visibleText, row.tagText, row.text, row.label, row.name);
    const ownerViewId = firstNumber(row.ownerViewId, row.viewId) ?? fallbackViewId;
    const point = pointFromVisibleElement(row);
    return Boolean(
      id &&
      ownerViewId &&
      visibleText &&
      /tag/i.test(category) &&
      Number.isFinite(Number(point.x)) &&
      Number.isFinite(Number(point.y))
    );
  }) ?? {};
}

function existingTagMoveLiveReviewPlan(args: {
  tagId: number;
  ownerViewId: number;
  category: string;
  visibleText: string;
  taggedElementId?: number;
  point: JsonMap;
}): JsonMap {
  return evaluateRedlineTagLiveAdapterReadiness(
    {
      operation: "move",
      target: "tag",
      viewId: args.ownerViewId,
      tagId: args.tagId,
      taggedElementId: args.taggedElementId,
      displayValue: args.visibleText,
      moveVector: { x: 0.5, y: 0, z: 0 }
    },
    {
      tags: [
        {
          tagId: args.tagId,
          viewId: args.ownerViewId,
          category: args.category,
          taggedElementId: args.taggedElementId,
          displayValue: args.visibleText,
          headPosition: {
            x: Number(args.point.x),
            y: Number(args.point.y),
            z: Number(args.point.z ?? 0)
          }
        }
      ]
    },
    {
      viewId: args.ownerViewId,
      tagId: args.tagId,
      taggedElementId: args.taggedElementId,
      expectedCategory: args.category,
      expectedTagText: args.visibleText,
      beforeHeadPosition: {
        x: Number(args.point.x),
        y: Number(args.point.y),
        z: Number(args.point.z ?? 0)
      }
    }
  ) as unknown as JsonMap;
}

export function enrichExistingTagMoveFromVisibleElements(payload: RevitDemoDiscoveryPayload, visibleElements: unknown): RevitDemoDiscoveryPayload {
  const tasks = payload.tasks as Record<string, { request?: JsonMap }>;
  const targetView = asObject(payload._discovery.candidateTargetView);
  const fallbackViewId = firstNumber(targetView.id, targetView.viewId);
  const candidate = pickExistingTagMoveCandidate(visibleElements, fallbackViewId);
  const tagId = firstNumber(candidate.id, candidate.elementId);
  const ownerViewId = firstNumber(candidate.ownerViewId, candidate.viewId) ?? fallbackViewId;
  const category = firstString(candidate.category, candidate.categoryName, candidate.builtInCategory, candidate.categoryToken);
  const visibleText = firstString(candidate.visibleText, candidate.tagText, candidate.text, candidate.label, candidate.name);
  const taggedElementId = taggedElementIdFromVisibleTag(candidate);
  const point = pointFromVisibleElement(candidate);
  if (!tagId || !ownerViewId || !category || !visibleText || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) {
    payload._discovery.candidateExistingTagMove = {
      status: "missing",
      reason: "No visible tag candidate with id, category, visible text, owner view, and model point was found."
    };
    return payload;
  }

  payload._discovery.candidateExistingTagMove = {
    status: "ready",
    tagId,
    ownerViewId,
    category,
    visibleText,
    ...(taggedElementId ? { taggedElementId } : {}),
    point: {
      x: Number(point.x),
      y: Number(point.y),
      z: Number(point.z ?? 0)
    }
  };
  payload._discovery.candidateExistingTagMoveLiveReview = existingTagMoveLiveReviewPlan({
    tagId,
    ownerViewId,
    category,
    visibleText,
    taggedElementId: taggedElementId ?? undefined,
    point
  });
  tasks.demo_redline_move_tag = {
    request: {
      viewId: ownerViewId,
      imageSize: 1800,
      targetKind: "tag",
      toleranceFt: 0.05,
      tag: {
        existingTagIds: [tagId],
        ...(taggedElementId ? { elementIds: [taggedElementId] } : {}),
        readbackRequired: true
      },
      existingTarget: {
        moveExisting: true,
        elementIds: [tagId],
        expectedCategory: category,
        expectedTagText: visibleText,
        ...(taggedElementId ? { taggedElementIds: [taggedElementId] } : {}),
        readbackRequired: true
      },
      move: {
        vectorX: 0.5,
        vectorY: 0,
        vectorZ: 0
      },
      visualVerify: true,
      revertAfterVerify: true
    }
  };
  return payload;
}

export function enrichReceptacleRedlineFromPlacementContext(payload: RevitDemoDiscoveryPayload, placementContext: unknown): RevitDemoDiscoveryPayload {
  const context = asObject(placementContext);
  if (String(context.status ?? "").trim().toLowerCase() === "notfound") return payload;
  const tasks = payload.tasks as Record<string, { request?: JsonMap }>;
  const request = asObject(tasks.demo_redline_receptacles?.request);
  const placements = asArray(request.placements).map(asObject);
  const placement = placements[0];
  if (!placement) return payload;

  const room = asObject(context.room);
  const host = asObject(context.placementHost ?? context.host);
  const hostCategory = String(host.category ?? "").trim().toLowerCase();
  const sourceHostSupport = asObject(asObject(context.diagnostics).hostPlacementSupport);
  const linkedHostSupported =
    hostCategory === "rvt links" ||
    String(sourceHostSupport.reason ?? "").trim().toLowerCase() === "source_link_host_supported";
  const roomNumber = firstString(room.number, placement.roomNumber, request.roomNumber);
  const hostElementId = firstNumber(host.id, placement.hostElementId, request.hostElementId);
  const exemplarElementId = firstNumber(placement.exemplarElementId);
  if (!linkedHostSupported || !roomNumber || !hostElementId || !exemplarElementId) return payload;

  const expectedCircuitLabel = circuitLabelFromContext(context);
  placement.hostElementId = hostElementId;
  placement.referenceElementId = exemplarElementId;
  placement.roomNumber = roomNumber;
  placement.roomSide = firstString(placement.roomSide, request.roomSide, DEFAULT_LINKED_HOST_RECEPTACLE_ROOM_SIDE);
  placement.matchOrientationFromSource = true;
  placement.orientationSourceElementId = exemplarElementId;
  placement.matchElectricalCircuitFromSource = true;
  if (expectedCircuitLabel) placement.expectedCircuitLabel = expectedCircuitLabel;

  payload._discovery.redlineReceptaclePlacementContext = {
    source: "/revit/get-placement-context",
    elementId: exemplarElementId,
    roomNumber,
    hostElementId,
    hostCategory: host.category ?? null,
    roomSideDefaulted: placement.roomSide === DEFAULT_LINKED_HOST_RECEPTACLE_ROOM_SIDE,
    expectedCircuitLabel: expectedCircuitLabel || null,
    note: "Linked-host receptacle placement needs roomNumber + roomSide so create-similar can resolve a linked face reference instead of an unhosted XYZ point."
  };
  return payload;
}

export function buildRevitDemoDiscoveryPayload(input: RevitDemoDiscoveryInput): RevitDemoDiscoveryPayload {
  const sheets = asArray(asObject(input.sheetsBody).items).map(asObject);
  const sheetNumbers = sheets.map((sheet) => String(sheet.sheetNumber ?? "")).filter(Boolean).slice(0, 2);
  const sheetViewIds = sheets
    .map((sheet) => firstNumber(sheet.viewId, sheet.id))
    .filter((id): id is number => id !== null)
    .slice(0, 2);
  const views = asArray(input.viewsBody);
  const targetView = pickFloorPlanView(views);
  const foundIds = asArray(asObject(input.receptacleFindBody).elementIds).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  const quantifiedRows = asArray(asObject(input.receptacleQuantifyBody).rows).map(asObject);
  const mechanicalRows = asArray(asObject(input.mechanicalEquipmentQuantifyBody).rows).map(asObject);
  const exemplarId = foundIds[0] ?? firstNumber(quantifiedRows[0]?.id);
  const fallbackEditableId = exemplarId ?? pickFallbackElementId(mechanicalRows, targetView);
  const targetViewId = firstNumber(targetView.id);

  return {
    _discovery: {
      generatedAt: input.generatedAt ?? new Date().toISOString(),
      bridgeUrl: input.bridgeUrl,
      context: input.context,
      note: "Local-only benchmark override skeleton. Review sheet numbers, output folder, editable element ids, target view, exemplar, and redline placement before live runs.",
      candidateCounts: {
        sheets: sheets.length,
        views: views.length,
        receptacleFindIds: foundIds.length,
        receptacleRows: quantifiedRows.length,
        mechanicalEquipmentRows: mechanicalRows.length
      },
      candidateSheets: sheets.slice(0, 10),
      candidateTargetView: targetView,
      candidateReceptacles: quantifiedRows.slice(0, 10),
      candidateMechanicalEquipment: mechanicalRows.slice(0, 10),
      fallbackEditableElementId: fallbackEditableId,
      rawWarnings: {
        sheets: asObject(input.sheetsBody).warnings ?? asObject(input.sheetsBody).note ?? null,
        receptacles: asObject(input.receptacleQuantifyBody).warnings ?? null,
        mechanicalEquipment: asObject(input.mechanicalEquipmentQuantifyBody).warnings ?? null
      }
    },
    tasks: {
      demo_sheet_export: {
        request: {
          sheetNumbers,
          viewIds: sheetViewIds,
          outputFolder: path.join(input.userProfile ?? "C:\\Users\\User", "Desktop", "Operator Demo"),
          baseFileName: "AEC_Demo_Selected_Sheets.pdf",
          combine: true,
          overwrite: true
        }
      },
      demo_takeoff_receptacles: {
        request: {
          intent: "count_and_list",
          scope: "host",
          categories: ["OST_ElectricalFixtures"],
          filters: { keywords_include: ["receptacle"] },
          group_by: ["Type", "Level", "Room"],
          room_resolution: true
        }
      },
      demo_takeoff_lighting: {
        request: {
          intent: "count_and_list",
          scope: "host",
          categories: ["OST_LightingFixtures"],
          group_by: ["Category", "Type", "Level", "Room"],
          room_resolution: true
        }
      },
      demo_takeoff_mechanical_equipment: {
        request: {
          intent: "count_and_list",
          scope: "host",
          categories: ["OST_MechanicalEquipment"],
          filters: { keywords_include_any: ["VAV", "terminal", "box"] },
          group_by: ["Category", "Type", "Level", "Room", "Space"],
          room_resolution: true
        }
      },
      demo_parameter_edit: {
        request: {
          elementIds: fallbackEditableId ? [fallbackEditableId] : [],
          parameterName: "Comments",
          value: "DEMO VERIFIED",
          readbackRequired: true,
          revertAfterVerify: true,
          confirm: true
        }
      },
      demo_redline_receptacles: {
        request: {
          viewId: targetViewId,
          cleanupCreatedElements: true,
          placements: [
            {
              label: "R-DEM-01",
              exemplarElementId: exemplarId,
              targetChainageFt: 8,
              parameterOverrides: {
                Mark: "R-DEM-01",
                Comments: "DEMO REDLINE",
                Panel: "LP-1",
                "Circuit Number": "12"
              }
            }
          ],
          audit: { requireVisibleInView: true }
        }
      },
      demo_redline_mep_route: {
        request: {
          kind: "duct",
          viewId: targetViewId,
          visualViewId: targetViewId,
          roomNumber: "",
          levelName: "",
          systemType: "Supply Air",
          ductSize: "12x10",
          routingMode: "polyline",
          connectSegments: true,
          verify: true,
          apply: true,
          visualVerify: true,
          cleanupCreatedElements: true,
          imageSize: 2200,
          focusPaddingFt: 8,
          toleranceFt: 1,
          redlinePath: "artifacts/uploads/marked-duct-route.pdf",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 }
          ],
          reviewNote: "Replace placeholder points with ordered model-space route points in the target view before live runs."
        }
      },
      demo_redline_mep_pipe_route: {
        request: {
          kind: "pipe",
          viewId: targetViewId,
          visualViewId: targetViewId,
          roomNumber: "",
          levelName: "",
          systemType: "Domestic Cold Water",
          pipeSize: "2\"",
          routingMode: "polyline",
          connectSegments: true,
          verify: true,
          apply: true,
          visualVerify: true,
          cleanupCreatedElements: true,
          imageSize: 2200,
          focusPaddingFt: 8,
          toleranceFt: 1,
          redlinePath: "artifacts/uploads/marked-pipe-route.pdf",
          points: [
            { x: 0, y: 0 },
            { x: 10, y: 0 },
            { x: 10, y: 8 }
          ],
          reviewNote: "Replace placeholder points with ordered model-space pipe route points in the target view before live runs."
        }
      },
      demo_documentation_primitives: {
        request: {
          schedule: {
            name: "Operator Demo Door Schedule",
            category: "OST_Doors",
            fields: ["Family and Type", "Count"]
          },
        configureSchedule: {
          replaceFilters: false,
          replaceSortGroup: false,
          sortGroup: [
            {
              field: "Family and Type",
              ascending: true,
              showHeader: true
            }
          ],
          showGrandTotals: false
        },
          sheet: {
            number: "OP-DEMO",
            name: "Operator Demo Documentation",
            titleBlockId: -1
          },
          createView: {
            action: "create_drafting",
            name: "Operator Demo Drafting View",
            scale: 100
          },
          viewTemplate: {
            name: "Operator Demo View Template"
          },
          placeView: {
            x: 1.5,
            y: 1.0
          },
          visibility: {
            action: "set_detail_level",
            detailLevel: "Fine"
          },
          templateVisibility: {
            action: "set_detail_level",
            detailLevel: "Fine"
          },
          detailCurves: {
            lineStyleCreate: {
              name: "Operator Demo Annotation Lines",
              lineWeight: 3,
              r: 220,
              g: 0,
              b: 0
            },
            curves: [
              {
                kind: "line",
                a: { x: 0, y: 0, z: 0 },
                b: { x: 3, y: 0, z: 0 }
              }
            ]
          },
          textNote: {
            x: 1,
            y: 1,
            text: "Operator demo annotation"
          },
          tag: {
            viewId: targetViewId,
            elementIds: fallbackEditableId ? [fallbackEditableId] : [],
            onlyUntagged: false,
            addLeader: false
          },
          cleanupCreatedElements: true
        }
      },
      demo_model_edit_primitives: {
        request: {
          createFamilyInstance: {
            familyName: "",
            symbolName: "Generic Annotation",
            levelName: "",
            x: 0,
            y: 0,
            z: 0
          },
          move: {
            mode: "vector",
            vectorX: 1,
            vectorY: 0,
            vectorZ: 0,
            behavior: "allOrNothing"
          },
          linkRevit: {
            sourcePath: "benchmark/fixtures/revit/link-source.rvt",
            pin: true
          },
          visualViewId: targetViewId
        }
      }
    }
  };
}
