import path from "node:path";

type JsonMap = Record<string, unknown>;

export type RevitDemoDiscoveryInput = {
  bridgeUrl: string;
  context: unknown;
  sheetsBody: unknown;
  viewsBody: unknown;
  receptacleFindBody: unknown;
  receptacleQuantifyBody: unknown;
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

export function buildRevitDemoDiscoveryPayload(input: RevitDemoDiscoveryInput): RevitDemoDiscoveryPayload {
  const sheets = asArray(asObject(input.sheetsBody).items).map(asObject);
  const sheetNumbers = sheets.map((sheet) => String(sheet.sheetNumber ?? "")).filter(Boolean).slice(0, 2);
  const views = asArray(input.viewsBody);
  const targetView = pickFloorPlanView(views);
  const foundIds = asArray(asObject(input.receptacleFindBody).elementIds).map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0);
  const quantifiedRows = asArray(asObject(input.receptacleQuantifyBody).rows).map(asObject);
  const exemplarId = foundIds[0] ?? firstNumber(quantifiedRows[0]?.id);
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
        receptacleRows: quantifiedRows.length
      },
      candidateSheets: sheets.slice(0, 10),
      candidateTargetView: targetView,
      candidateReceptacles: quantifiedRows.slice(0, 10),
      rawWarnings: {
        sheets: asObject(input.sheetsBody).warnings ?? asObject(input.sheetsBody).note ?? null,
        receptacles: asObject(input.receptacleQuantifyBody).warnings ?? null
      }
    },
    tasks: {
      demo_sheet_export: {
        request: {
          sheetNumbers,
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
          elementIds: exemplarId ? [exemplarId] : [],
          parameterName: "Comments",
          value: "DEMO VERIFIED",
          confirm: true
        }
      },
      demo_redline_receptacles: {
        request: {
          viewId: targetViewId,
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
      }
    }
  };
}
