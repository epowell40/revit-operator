import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findRepoRoot } from "./audit_tool_registry.js";

type Probe = { name: string; method: "GET" | "POST"; path: string; body?: unknown; validate: (value: unknown) => boolean };
type Receipt = { name: string; method: string; path: string; duration_ms: number; http_status: number | null; transport_ok: boolean; useful: boolean; error: string | null; response: unknown };

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayAt(value: unknown, key: string): unknown[] {
  const candidate = record(value)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function numberAt(value: unknown, ...keys: string[]): number | null {
  const source = record(value);
  for (const key of keys) if (typeof source[key] === "number") return source[key] as number;
  return null;
}

function truncate(value: unknown, maxChars = 120_000): unknown {
  const text = JSON.stringify(value);
  if (text.length <= maxChars) return value;
  return { truncated: true, original_chars: text.length, preview: text.slice(0, maxChars) };
}

function statusAccepted(value: unknown): boolean {
  const status = record(value).status;
  return typeof status === "string" && !/error|fail/i.test(status);
}

function hasObjectOrArray(value: unknown, ...keys: string[]): boolean {
  const source = record(value);
  return keys.some(key => Array.isArray(source[key]) || Object.keys(record(source[key])).length > 0);
}

async function invoke(baseUrl: string, token: string, probe: Probe): Promise<Receipt> {
  const started = performance.now();
  try {
    const response = await fetch(`${baseUrl}${probe.path}`, {
      method: probe.method,
      headers: { "content-type": "application/json", "x-operator-token": token },
      ...(probe.method === "POST" ? { body: JSON.stringify(probe.body ?? {}) } : {}),
      signal: AbortSignal.timeout(15_000)
    });
    const text = await response.text();
    let value: unknown = text;
    try { value = text ? JSON.parse(text) : null; } catch { /* retain text */ }
    return {
      name: probe.name,
      method: probe.method,
      path: probe.path,
      duration_ms: Math.round(performance.now() - started),
      http_status: response.status,
      transport_ok: response.ok,
      useful: response.ok && probe.validate(value),
      error: response.ok ? null : String(record(value).error ?? `HTTP ${response.status}`),
      response: truncate(value)
    };
  } catch (error) {
    return {
      name: probe.name,
      method: probe.method,
      path: probe.path,
      duration_ms: Math.round(performance.now() - started),
      http_status: null,
      transport_ok: false,
      useful: false,
      error: error instanceof Error ? error.message : String(error),
      response: null
    };
  }
}

function renderMarkdown(report: { generated_at: string; bridge_url: string; circuit_open: boolean; receipts: Receipt[] }): string {
  const lines = [
    "# Live Revit read-only tool probes",
    "",
    `Generated: ${report.generated_at}`,
    `Bridge: ${report.bridge_url}`,
    `Circuit open: ${report.circuit_open}`,
    "",
    "| Probe | Path | HTTP | ms | Transport | Useful | Error |",
    "|---|---|---:|---:|---|---|---|"
  ];
  for (const receipt of report.receipts) {
    lines.push(`| ${receipt.name} | ${receipt.method} ${receipt.path} | ${receipt.http_status ?? "-"} | ${receipt.duration_ms} | ${receipt.transport_ok} | ${receipt.useful} | ${(receipt.error ?? "").replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "`useful=true` only means the bounded probe returned the expected structural evidence in this open model. It is not write-safety or general workflow proof.", "");
  return lines.join("\n");
}

async function runCli(): Promise<void> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error("LOCALAPPDATA is unavailable; cannot discover the live bridge.");
  const baseUrl = fs.readFileSync(path.join(localAppData, "RevitOperator", "bridge_url.txt"), "utf8").trim().replace(/\/+$/, "");
  const token = fs.readFileSync(path.join(localAppData, "RevitOperator", "Workspace", "operator_token.txt"), "utf8").trim();
  const probes: Probe[] = [
    { name: "ping", method: "GET", path: "/revit/ping", validate: value => String(record(value).status).toLowerCase() === "ok" },
    { name: "capabilities GET", method: "GET", path: "/revit/capabilities", validate: value => arrayAt(value, "tools").length > 150 },
    { name: "capabilities", method: "POST", path: "/revit/capabilities", body: {}, validate: value => arrayAt(value, "tools").length > 150 },
    { name: "context", method: "GET", path: "/revit/context", validate: value => Object.keys(record(value)).length > 0 },
    { name: "views GET", method: "GET", path: "/revit/views", validate: value => Array.isArray(value) || hasObjectOrArray(value, "items", "views") },
    { name: "tool registry", method: "GET", path: "/revit/tool-registry", validate: value => arrayAt(value, "tools").length > 150 },
    { name: "native capabilities", method: "GET", path: "/revit/native-capabilities", validate: value => Object.keys(record(value)).length > 1 },
    { name: "native API policy", method: "GET", path: "/revit/native-api-policy", validate: value => Object.keys(record(value)).length > 1 },
    { name: "write grant status", method: "GET", path: "/revit/write-grant-status", validate: value => Object.keys(record(value)).length > 0 },
    { name: "tool search", method: "POST", path: "/revit/tool-search", body: { query: "count sheets", max: 5 }, validate: value => Array.isArray(record(value).matches) },
    { name: "tool documentation", method: "POST", path: "/revit/tool-doc", body: { method: "POST", path: "/revit/sheets" }, validate: value => record(value).path === "/revit/sheets" && Object.keys(record(record(value).request_schema)).length > 0 },
    { name: "tool examples", method: "POST", path: "/revit/tool-examples", body: { method: "POST", path: "/revit/schedules" }, validate: value => record(value).path === "/revit/schedules" && Array.isArray(record(value).examples) },
    { name: "native API catalog", method: "POST", path: "/revit/native-api-catalog", body: { namespacePrefix: "Autodesk.Revit.DB", query: "FilteredElementCollector", limit: 10 }, validate: value => hasObjectOrArray(value, "items", "summary") },
    { name: "bridge self-test", method: "POST", path: "/revit/self-test", body: { include_export_image: false, include_rooms: true }, validate: value => statusAccepted(value) && Array.isArray(record(value).checks) },
    { name: "view count", method: "POST", path: "/revit/views", body: { action: "count" }, validate: value => numberAt(value, "count", "total", "totalMatches") !== null },
    { name: "sheet count", method: "POST", path: "/revit/sheets", body: { action: "count" }, validate: value => numberAt(value, "count", "total", "totalMatches") !== null },
    { name: "sheet list sample", method: "POST", path: "/revit/sheets", body: { action: "list", limit: 500 }, validate: value => Array.isArray(record(value).items) },
    { name: "schedule list", method: "POST", path: "/revit/schedules", body: { action: "list", query: "", max: 10 }, validate: value => Array.isArray(record(value).items) },
    { name: "mechanical equipment query", method: "POST", path: "/revit/query", body: { category: "OST_MechanicalEquipment", limit: 5 }, validate: value => Array.isArray(value) },
    { name: "cross-category parameters", method: "POST", path: "/revit/get-parameters", body: { categories: ["OST_MechanicalEquipment", "OST_ElectricalEquipment", "OST_SpecialityEquipment"], includeStringParameters: true, offset: 0, limit: 10 }, validate: value => Array.isArray(record(value).items) },
    { name: "state snapshot", method: "POST", path: "/revit/state-snapshot", body: { include_all_views_index: false, include_warnings_detail: false, include_element_bboxes: false, max_items: 20 }, validate: value => Object.keys(record(value)).length > 2 },
    { name: "linked room boundaries", method: "POST", path: "/revit/linked-room-boundaries", body: { maxRooms: 2, includeBoundarySegmentMetadata: false }, validate: value => Array.isArray(record(value).rooms) },
    { name: "room list", method: "POST", path: "/revit/rooms", body: { action: "list", max: 5 }, validate: value => Array.isArray(value) || Array.isArray(record(value).rooms) },
    { name: "door quantity", method: "POST", path: "/revit/quantify", body: { intent: "count", categories: ["OST_Doors"] }, validate: value => typeof record(record(value).summary).total === "number" },
    { name: "door type list", method: "POST", path: "/revit/list-element-types", body: { category: "OST_Doors", limit: 10 }, validate: value => Array.isArray(value) || Array.isArray(record(value).items) || Array.isArray(record(value).types) },
    { name: "print set list", method: "POST", path: "/revit/print-sets", body: { action: "list", max: 10 }, validate: value => Array.isArray(record(value).items) },
    { name: "revision list", method: "POST", path: "/revit/revisions", body: { max: 10 }, validate: value => Array.isArray(record(value).items) },
    { name: "duplicate mechanical marks", method: "POST", path: "/revit/find-duplicate-marks", body: { categoryName: "OST_MechanicalEquipment", parameterName: "Mark", maxGroups: 20 }, validate: value => statusAccepted(value) && Array.isArray(record(value).groups) },
    { name: "text note search", method: "POST", path: "/revit/find-text-notes", body: { textContains: "MEP", max: 10 }, validate: value => record(value).ok === true && Array.isArray(record(value).items) },
    { name: "locate mechanical equipment", method: "POST", path: "/revit/locate-elements", body: { categories: ["OST_MechanicalEquipment"], limit: 10 }, validate: value => statusAccepted(value) || hasObjectOrArray(value, "items", "elements", "locations") },
    { name: "DESIG shock-arrestor search", method: "POST", path: "/revit/find-elements-by-parameter", body: { categories: ["OST_MechanicalEquipment", "OST_ElectricalEquipment", "OST_SpecialityEquipment"], parameterName: "DESIG", op: "contains", value: "SA", limit: 500 }, validate: value => Array.isArray(record(value).elements) },
    { name: "all-model DESIG shock-arrestor search", method: "POST", path: "/revit/get-parameters", body: { allModelInstances: true, names: ["DESIG"], includeStringParameters: true, valueContains: "SA", offset: 0, limit: 500 }, validate: value => Array.isArray(record(value).items) },
    { name: "model health", method: "POST", path: "/revit/model-health", body: { maxUnplacedViews: 25 }, validate: value => Object.keys(record(record(value).stats)).length > 0 },
    { name: "active view capture", method: "POST", path: "/revit/export-image", body: {}, validate: value => typeof record(value).path === "string" || typeof record(value).filePath === "string" },
    { name: "native API search", method: "POST", path: "/revit/native-api-search", body: { query: "FilteredElementCollector GetElementCount", max: 5 }, validate: value => arrayAt(value, "items").length > 0 }
  ];

  const receipts: Receipt[] = [];
  let circuitOpen = false;
  for (const probe of probes) {
    const receipt = await invoke(baseUrl, token, probe);
    receipts.push(receipt);
    if (receipt.http_status === null || receipt.http_status === 408 || receipt.http_status === 409 || receipt.http_status === 503) {
      circuitOpen = true;
      break;
    }
  }

  const runAdditional = async (probe: Probe): Promise<void> => {
    if (circuitOpen) return;
    const receipt = await invoke(baseUrl, token, probe);
    receipts.push(receipt);
    if (receipt.http_status === null || receipt.http_status === 408 || receipt.http_status === 409 || receipt.http_status === 503) circuitOpen = true;
  };

  if (!circuitOpen) {
    const context = record(receipts.find(item => item.name === "context")?.response);
    const activeView = record(record(context.document).activeView);
    const viewId = numberAt(activeView, "id", "viewId") ?? numberAt(context, "activeViewId", "viewId");
    const viewName = typeof activeView.name === "string" ? activeView.name : "";
    if (viewId !== null) await runAdditional({ name: "find elements in active view", method: "POST", path: "/revit/find-elements", body: { viewId, categories: ["OST_MechanicalEquipment"], limit: 20 }, validate: value => statusAccepted(value) && Array.isArray(record(value).elementIds) });
    if (viewName) await runAdditional({ name: "resolve active view", method: "POST", path: "/revit/resolve", body: { type: "view", query: viewName }, validate: value => numberAt(value, "id", "viewId") !== null });
  }

  if (!circuitOpen) {
    const mechanical = receipts.find(item => item.name === "mechanical equipment query")?.response;
    const mechanicalItems = Array.isArray(mechanical) ? mechanical : arrayAt(mechanical, "items");
    const firstMechanical = record(mechanicalItems.find(item => /AHU/i.test(String(record(item).name ?? ""))) ?? mechanicalItems[0]);
    const elementId = numberAt(firstMechanical, "id", "elementId", "element_id");
    if (elementId !== null) {
      await runAdditional({ name: "element summary", method: "POST", path: "/revit/get-element-summary", body: { elementIds: [elementId] }, validate: value => Array.isArray(value) || Array.isArray(record(value).items) });
      await runAdditional({ name: "placement context", method: "POST", path: "/revit/get-placement-context", body: { elementId, hostCategories: ["OST_Walls"], hostSearchRadiusFt: 10 }, validate: value => statusAccepted(value) || numberAt(value, "elementId") !== null });
      await runAdditional({ name: "hosted placement audit", method: "POST", path: "/revit/audit-hosted-instance-placement", body: { elementIds: [elementId], hostCategories: ["OST_Walls"], hostSearchRadiusFt: 10, maxNearbyHosts: 3 }, validate: value => statusAccepted(value) && Array.isArray(record(value).auditedIds) });
      await runAdditional({ name: "MEP connector read", method: "POST", path: "/revit/get-connectors", body: { elementIds: [elementId], includeAllRefs: true, includeCoordinateSystem: true }, validate: value => Array.isArray(record(value).results) });
      await runAdditional({ name: "connected network trace", method: "POST", path: "/revit/trace-connected-network", body: { startElementId: elementId, inferSystemFromStart: true, maxElements: 100, includeSystemAudit: true }, validate: value => statusAccepted(value) && Array.isArray(record(value).elementIdsOrdered) });
    }
  }

  if (!circuitOpen) {
    const sheetList = record(receipts.find(item => item.name === "sheet list sample")?.response);
    const sheetItems = arrayAt(sheetList, "items");
    const sheet = record(sheetItems.find(item => !String(record(item).sheetNumber ?? "").startsWith("*")) ?? sheetItems[0]);
    const sheetNumber = String(sheet.number ?? sheet.sheetNumber ?? "").trim();
    if (sheetNumber) {
      await runAdditional({ name: "titleblock info", method: "POST", path: "/revit/get-titleblock-info", body: { sheetNumber }, validate: value => record(value).ok === true && numberAt(value, "sheetId") !== null });
      await runAdditional({ name: "titleblock date candidates", method: "POST", path: "/revit/titleblock-date-candidates", body: { sheetNumber, maxCandidates: 10 }, validate: value => record(value).ok === true && Array.isArray(record(value).candidates) });
      await runAdditional({ name: "titleblock label map", method: "POST", path: "/revit/titleblock-label-map", body: { sheetNumber, includeParameters: true, includeHeuristics: true }, validate: value => Array.isArray(record(value).mappings) && Object.keys(record(record(value).parameter_groups)).length > 0 });
      await runAdditional({ name: "verify sheet number parameter", method: "POST", path: "/revit/verify-parameter-on-sheet", body: { sheetNumber, parameterName: "Sheet Number", includeCapture: false }, validate: value => record(value).ok === true || statusAccepted(value) });
    }
  }

  if (!circuitOpen) {
    const roomPayload = receipts.find(item => item.name === "room list")?.response;
    const rooms = Array.isArray(roomPayload) ? roomPayload : arrayAt(roomPayload, "rooms");
    const room = record(rooms[0]);
    const roomNumber = typeof room.number === "string" ? room.number.trim() : "";
    if (roomNumber) {
      const spatialProbe: Probe = {
        name: "room spatial context",
        method: "POST",
        path: "/revit/spatial-context",
        body: { roomNumber, categories: ["OST_ElectricalFixtures", "OST_MechanicalEquipment"], limit: 100 },
        validate: value => {
          const roomValue = record(value).room;
          const hasRoom = Array.isArray(roomValue) ? roomValue.length > 0 : Object.keys(record(roomValue)).length > 0;
          return typeof record(value).schema === "string" && hasRoom;
        }
      };
      const spatialReceipt = await invoke(baseUrl, token, spatialProbe);
      receipts.push(spatialReceipt);
      if (spatialReceipt.http_status === null || spatialReceipt.http_status === 408 || spatialReceipt.http_status === 409 || spatialReceipt.http_status === 503) circuitOpen = true;
      await runAdditional({ name: "room contents", method: "POST", path: "/revit/room-contents", body: { roomNumber, categories: ["OST_MechanicalEquipment", "OST_ElectricalFixtures"], mode: "roomAware" }, validate: value => statusAccepted(value) && Array.isArray(record(value).elementIds) });
      const levelName = typeof room.level === "string" ? room.level.trim() : "";
      if (levelName) await runAdditional({ name: "zone data", method: "POST", path: "/revit/query-zone-data", body: { levelName }, validate: value => Array.isArray(value) });
      await runAdditional({ name: "resolve room plan", method: "POST", path: "/revit/resolve-room-plan-view", body: { roomNumber, maxCandidates: 10 }, validate: value => numberAt(value, "bestViewId", "viewId", "id") !== null });
      await runAdditional({ name: "resolve room wall", method: "POST", path: "/revit/resolve-room-wall", body: { roomNumber, side: "south", maxWalls: 3, includeSegments: true }, validate: value => statusAccepted(value) && Array.isArray(record(value).walls) });
      await runAdditional({ name: "ducts by room scope", method: "POST", path: "/revit/ducts-by-spatial-scope", body: { roomNumber, verticalScope: "room+plenum", includeCategories: ["Ducts", "Duct Fittings", "Air Terminals"], roomMode: "auto", limit: 200 }, validate: value => statusAccepted(value) && Array.isArray(record(value).elementIds) });
      const plenumTopLevelName = /FSED/i.test(levelName) ? "ROOF LEVEL FSED" : levelName;
      if (plenumTopLevelName) await runAdditional({ name: "room MEP intersection", method: "POST", path: "/revit/room_mep_intersect", body: { roomNumber, plenumTopLevelName, categories: ["OST_DuctCurves", "OST_DuctFitting", "OST_DuctTerminal"], intersectMode: "centerline", verticalTolerance: 0.05 }, validate: value => statusAccepted(value) && Array.isArray(record(value).elementIds) });
      await runAdditional({ name: "MEP routing context", method: "POST", path: "/revit/resolve-mep-routing-context", body: { roomNumber, levelName: typeof room.level === "string" ? room.level : undefined, systemKind: "duct", routingMode: "auto", ceilingOffsetFt: 1, dryRun: true }, validate: value => statusAccepted(value) && Object.keys(record(record(value).recommendedElevation)).length > 0 });
    }
  }

  const report = {
    version: "revit-operator.live-read-probes.v1",
    generated_at: new Date().toISOString(),
    bridge_url: baseUrl,
    circuit_open: circuitOpen,
    summary: {
      attempted: receipts.length,
      transport_ok: receipts.filter(item => item.transport_ok).length,
      useful: receipts.filter(item => item.useful).length,
      failed: receipts.filter(item => !item.transport_ok).length
    },
    receipts
  };
  const repoRoot = findRepoRoot(process.cwd());
  const outputArgIndex = process.argv.indexOf("--output-dir");
  const outputDir = path.resolve(outputArgIndex >= 0 && process.argv[outputArgIndex + 1] ? process.argv[outputArgIndex + 1]! : path.join(repoRoot, "local-work", "tool-registry-audit"));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "live_read_probe_receipts.json"), `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(path.join(outputDir, "live_read_probe_receipts.md"), renderMarkdown(report));
  console.log(renderMarkdown(report));
  console.log(`Artifacts: ${outputDir}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runCli().catch(error => {
    console.error(error instanceof Error ? error.stack ?? error.message : String(error));
    process.exitCode = 1;
  });
}
