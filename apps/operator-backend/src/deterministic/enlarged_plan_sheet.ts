import fs from "node:fs";
import path from "node:path";
import { OPERATOR_BACKEND_CONTRACT_VERSION, type ChatRequest, type ChatResponse } from "../contracts.js";
import { appendEvent, appendNotification } from "../memory/sqlite_store.js";
import { getOrCreateOperatorToken } from "../operator_token.js";
import { getWriteGrantToken } from "../operator_write_grant.js";
import { assertExactDevelopmentLaboratoryNativeTransport } from "../brains/native_revit_transport.js";

type EnlargedPlanRequest = {
  unitNumber: string;
  sheetNumber: string;
  kinds: string[];
  levelToken: string;
  scale: number;
  cropPaddingFeet: number;
  annotationCropMarginFeet: number;
};

type CreatedView = {
  kind: string;
  viewId: number;
  name: string;
  cropped: boolean;
};

function normalizeText(value: string): string {
  return `${value || ""}`.replace(/\s+/g, " ").trim();
}

function parseScaleDenominator(text: string, fallback = 48): number {
  const explicit =
    text.match(/\bscale\s*(?:=|is|at)?\s*1\s*[:/]\s*(\d{1,4})\b/i)?.[1] ||
    text.match(/\b1\s*[:/]\s*(\d{1,4})\b/i)?.[1];
  const parsed = Number.parseInt(`${explicit || ""}`, 10);
  return Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000 ? parsed : fallback;
}

export function parseDeterministicEnlargedPlanRequest(userText: string): EnlargedPlanRequest | null {
  const text = normalizeText(userText);
  if (!/\benlarged\s+plans?\b/i.test(text) && !/\benlarged\s+(?:power|lighting|floor|ceiling|mechanical|plumbing)/i.test(text)) return null;
  if (!/\b(create|make|place|placing|placed|sheet)\b/i.test(text)) return null;

  const unitNumber =
    text.match(/\bunit\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/i)?.[1] ||
    text.match(/\broom\s+([A-Za-z]?\d{2,5}[A-Za-z]?)\b/i)?.[1] ||
    "";
  const sheetNumber =
    text.match(/\bsheet\s+([A-Z]{1,4}\d{1,4}(?:[.\-]\d{1,4})?)\b/i)?.[1] ||
    text.match(/\bon\s+([A-Z]{1,4}\d{1,4}(?:[.\-]\d{1,4})?)\b/i)?.[1] ||
    "";
  if (!unitNumber || !sheetNumber) return null;

  const kinds: string[] = [];
  if (/\bpower\b/i.test(text)) kinds.push("POWER");
  if (/\blighting\b/i.test(text)) kinds.push("LIGHTING");
  if (/\bmechanical\b/i.test(text)) kinds.push("MECHANICAL");
  if (/\bplumbing\b/i.test(text)) kinds.push("PLUMBING");
  if (kinds.length === 0) kinds.push("POWER", "LIGHTING");

  const explicitLevel = text.match(/\b(?:level|lvl|l)\s*([0-9]{1,2})\b/i)?.[1];
  const unitDigits = unitNumber.match(/\d+/)?.[0] || "";
  const inferredLevel = explicitLevel || (unitDigits.length >= 3 ? unitDigits.slice(0, 1) : "");

  return {
    unitNumber: unitNumber.toUpperCase(),
    sheetNumber: sheetNumber.toUpperCase(),
    kinds: [...new Set(kinds)],
    levelToken: inferredLevel ? `L${inferredLevel}` : "",
    scale: parseScaleDenominator(text, 48),
    cropPaddingFeet: 0.25,
    annotationCropMarginFeet: 0.12
  };
}

function readDiscoveredBridgeUrl(): string {
  const localAppData = (process.env.LOCALAPPDATA ?? "").trim();
  if (!localAppData) return "";
  try {
    const value = fs.readFileSync(path.join(localAppData, "RevitOperator", "bridge_url.txt"), "utf8").trim();
    return value.replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function bridgeUrl(): string {
  return (process.env.REVIT_BRIDGE_URL || process.env.OPERATOR_REVIT_BRIDGE_URL || readDiscoveredBridgeUrl() || "http://localhost:5000").trim().replace(/\/+$/, "");
}

async function bridgeJson(method: "GET" | "POST", pathname: string, body?: unknown): Promise<any> {
  assertExactDevelopmentLaboratoryNativeTransport(process.env, "Deterministic enlarged-plan raw Revit transport");
  const headers: Record<string, string> = { "x-operator-token": getOrCreateOperatorToken() };
  if (body !== undefined) headers["content-type"] = "application/json";
  const writeGrant = getWriteGrantToken();
  if (writeGrant && method !== "GET") headers["x-operator-write-grant"] = writeGrant;

  const response = await fetch(`${bridgeUrl()}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) throw new Error((json && (json.error || json.message)) || text || `${method} ${pathname} failed with HTTP ${response.status}`);
  const status = `${json?.status || ""}`.trim().toLowerCase();
  if (json?.error || status === "failed" || status === "notfound") throw new Error(json.error || json.message || `${method} ${pathname} failed.`);
  return json;
}

function normalizeSheetNameStyle(name: string): string {
  return normalizeText(name).toUpperCase();
}

function nextSheetNumberCandidate(requestedSheetNumber: string, existingNumbers: Set<string>): string {
  const requested = normalizeText(requestedSheetNumber).toUpperCase();
  const match = requested.match(/^([A-Z]+)(\d+)$/i);
  if (!match) return existingNumbers.has(requested) ? "" : requested;
  const prefix = match[1]!.toUpperCase();
  const width = match[2]!.length;
  let index = Number.parseInt(match[2]!, 10);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const candidate = `${prefix}${String(index).padStart(width, "0")}`;
    if (!existingNumbers.has(candidate)) return candidate;
    index += 1;
  }
  return "";
}

async function sheetDetail(sheetNumber: string): Promise<any> {
  return await bridgeJson("POST", "/revit/sheets", {
    action: "detail",
    sheetNumber,
    includePlacedViews: true,
    includeViewportGeometry: true,
    includeSheetOutline: true,
    includeTitleBlocks: true
  });
}

async function ensureSheet(parsed: EnlargedPlanRequest, events: string[]): Promise<{ sheetDetail: any; sheetId: number }> {
  const prefix = (parsed.sheetNumber.match(/^[A-Z]+/i)?.[0] || parsed.sheetNumber.slice(0, 1)).toUpperCase();
  const list = await bridgeJson("POST", "/revit/sheets", { action: "list", sheetNumberPrefix: prefix, all: true });
  const items = Array.isArray(list.items) ? list.items : [];
  const existingNumbers = new Set<string>(
    items.map((item: any) => `${item?.sheetNumber || item?.number || ""}`.trim().toUpperCase()).filter((entry: string) => !!entry)
  );
  const number = nextSheetNumberCandidate(parsed.sheetNumber, existingNumbers);
  if (!number) throw new Error(`Could not find an available sheet number starting from ${parsed.sheetNumber}.`);
  if (number !== parsed.sheetNumber) events.push(`Using ${number} because ${parsed.sheetNumber} already exists.`);

  const created = await bridgeJson("POST", "/revit/create-sheet", {
    number,
    name: normalizeSheetNameStyle(`ENLARGED PLANS - UNIT ${parsed.unitNumber}`),
    titleBlockId: -1
  });
  const sheetId = Number.parseInt(`${created.id ?? created.sheetId ?? created.viewId ?? 0}`, 10) || 0;
  if (sheetId <= 0) throw new Error(`Created ${number}, but the bridge did not return a valid sheet id.`);
  parsed.sheetNumber = `${created.number || number}`.trim().toUpperCase();
  events.push(`Created sheet ${parsed.sheetNumber} - ${created.name || ""}.`.trim());

  const detail = await sheetDetail(parsed.sheetNumber);
  const detailId = Number.parseInt(`${detail.sheetId ?? detail.sheetElementId ?? detail.viewId ?? detail.id ?? 0}`, 10) || 0;
  if (detailId <= 0) throw new Error(`Could not resolve newly-created sheet ${parsed.sheetNumber}.`);
  return { sheetDetail: detail, sheetId: detailId };
}

function findViewByExactName(views: any[], name: string): any | null {
  const target = normalizeText(name).toLowerCase();
  return views.find((view) => `${view?.type || ""}`.toLowerCase() !== "drawingsheet" && normalizeText(`${view?.name || ""}`).toLowerCase() === target) || null;
}

function viewNameTokensScore(view: any, tokens: string[]): number {
  const name = `${view?.name || ""}`;
  const upper = name.toUpperCase();
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (upper.includes(token.toUpperCase())) score += 10;
    else return -1;
  }
  if (/ENLARGED/i.test(name)) score -= 5;
  if (/DEPENDENT/i.test(name)) score -= 2;
  return score;
}

function findSourcePlanView(views: any[], kind: string, levelToken: string): any | null {
  const candidates = views.filter((view) => {
    const type = `${view?.type || ""}`.toLowerCase();
    return view?.id && type !== "drawingsheet" && type !== "projectbrowser" && type !== "systembrowser";
  });
  const exactNames = [levelToken ? `${levelToken} - ${kind}` : "", levelToken ? `${kind} PLAN ${levelToken}` : "", levelToken ? `${levelToken} ${kind}` : "", `${kind} PLAN`].filter(Boolean);
  for (const exact of exactNames) {
    const matched = findViewByExactName(candidates, exact);
    if (matched) return matched;
  }
  const required = [kind, levelToken].filter(Boolean);
  return candidates
    .map((view) => ({ view, score: viewNameTokensScore(view, required) }))
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => b.score - a.score || `${a.view.name}`.localeCompare(`${b.view.name}`))[0]?.view || null;
}

async function listViews(): Promise<any[]> {
  const result = await bridgeJson("GET", "/revit/views");
  return Array.isArray(result) ? result : Array.isArray(result?.items) ? result.items : [];
}

function cropBoxPoint(obj: any, fallbackZ = 0): { x: number; y: number; z: number } {
  return {
    x: Number.isFinite(Number(obj?.x)) ? Number(obj.x) : 0,
    y: Number.isFinite(Number(obj?.y)) ? Number(obj.y) : 0,
    z: Number.isFinite(Number(obj?.z)) ? Number(obj.z) : fallbackZ
  };
}

async function cropViewToRoom(viewId: number, parsed: EnlargedPlanRequest, kind: string, events: string[]): Promise<boolean> {
  try {
    const resolvedRoom = await bridgeJson("POST", "/revit/resolve-room-plan-view", {
      roomNumber: parsed.unitNumber,
      preferViewNameContains: `${kind} ${parsed.levelToken}`.trim(),
      maxCandidates: 5
    });
    const min = resolvedRoom?.roomBbox?.minXyz;
    const max = resolvedRoom?.roomBbox?.maxXyz;
    if (!Array.isArray(min) || !Array.isArray(max) || min.length < 2 || max.length < 2) {
      events.push(`Crop skipped for ${kind}: room ${parsed.unitNumber} did not return a bounding box.`);
      return false;
    }
    const current = await bridgeJson("POST", "/revit/visibility", { action: "get", viewId });
    const currentMin = cropBoxPoint(current?.cropBox?.min, Number(min[2]) || 0);
    const currentMax = cropBoxPoint(current?.cropBox?.max, Number(max[2]) || currentMin.z);
    const pad = Math.max(0, Number(parsed.cropPaddingFeet) || 0);
    await bridgeJson("POST", "/revit/visibility", {
      action: "set_crop_box",
      viewId,
      boxMin: { x: Math.min(Number(min[0]), Number(max[0])) - pad, y: Math.min(Number(min[1]), Number(max[1])) - pad, z: currentMin.z },
      boxMax: { x: Math.max(Number(min[0]), Number(max[0])) + pad, y: Math.max(Number(min[1]), Number(max[1])) + pad, z: currentMax.z },
      annotationCropActive: true,
      annotationCropMarginFeet: parsed.annotationCropMarginFeet
    });
    return true;
  } catch (error) {
    events.push(`Crop skipped for ${kind}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function getSheetDrawingBounds(sheetDetailValue: any): any {
  const outline = sheetDetailValue?.sheetOutline || {};
  const minU = Number.isFinite(Number(outline.minU)) ? Number(outline.minU) : 0;
  const minV = Number.isFinite(Number(outline.minV)) ? Number(outline.minV) : 0;
  const maxU = Number.isFinite(Number(outline.maxU)) ? Number(outline.maxU) : 3.5;
  const maxV = Number.isFinite(Number(outline.maxV)) ? Number(outline.maxV) : 2.5;
  const width = Math.max(0.1, maxU - minU);
  const height = Math.max(0.1, maxV - minV);
  return { minU: minU + width * 0.03, minV: minV + height * 0.05, maxU: maxU - width * 0.18, maxV: maxV - height * 0.06 };
}

function placementPoints(sheetDetailValue: any, count: number): Array<{ x: number; y: number }> {
  const b = getSheetDrawingBounds(sheetDetailValue);
  const width = Math.max(0.1, b.maxU - b.minU);
  const height = Math.max(0.1, b.maxV - b.minV);
  if (count <= 1) return [{ x: b.minU + width * 0.42, y: b.minV + height * 0.55 }];
  return [
    { x: b.minU + width * 0.28, y: b.minV + height * 0.58 },
    { x: b.minU + width * 0.72, y: b.minV + height * 0.58 },
    { x: b.minU + width * 0.28, y: b.minV + height * 0.30 },
    { x: b.minU + width * 0.72, y: b.minV + height * 0.30 }
  ].slice(0, count);
}

function viewportGeometryForView(sheetDetailValue: any, viewId: number): any | null {
  return (Array.isArray(sheetDetailValue?.viewportGeometry) ? sheetDetailValue.viewportGeometry : []).find((entry: any) => Number(entry?.viewId) === Number(viewId)) || null;
}

function viewportSize(box: any): { width: number; height: number } {
  return { width: Math.max(0, Number(box?.maxU) - Number(box?.minU)), height: Math.max(0, Number(box?.maxV) - Number(box?.minV)) };
}

function reflowPlacements(sheetDetailValue: any, sheetId: number, views: CreatedView[]): any[] | null {
  if (views.length !== 2) return null;
  const bounds = getSheetDrawingBounds(sheetDetailValue);
  const sheetWidth = Math.max(0.1, bounds.maxU - bounds.minU);
  const sheetHeight = Math.max(0.1, bounds.maxV - bounds.minV);
  const gap = Math.max(0.06, Math.min(0.12, sheetWidth * 0.035));
  const sizes = views.map((entry) => viewportSize(viewportGeometryForView(sheetDetailValue, entry.viewId)?.box));
  if (sizes.some((size) => size.width <= 0 || size.height <= 0)) return null;
  const totalWidth = sizes[0]!.width + sizes[1]!.width + gap;
  if (totalWidth > sheetWidth || Math.max(sizes[0]!.height, sizes[1]!.height) > sheetHeight) return null;
  const startX = bounds.minU + (sheetWidth - totalWidth) / 2;
  const centerY = bounds.minV + sheetHeight * 0.56;
  return [
    { sheetId, viewId: views[0]!.viewId, x: startX + sizes[0]!.width / 2, y: centerY, moveIfAlreadyPlaced: true, lockViewport: false },
    { sheetId, viewId: views[1]!.viewId, x: startX + sizes[0]!.width + gap + sizes[1]!.width / 2, y: centerY, moveIfAlreadyPlaced: true, lockViewport: false }
  ];
}

function placedViewNames(detail: any): string {
  return (Array.isArray(detail?.placedViews) ? detail.placedViews : []).map((view: any) => normalizeText(`${view?.name || ""}`)).filter(Boolean).join(", ");
}

export async function maybeRunDeterministicEnlargedPlanSheet(req: ChatRequest): Promise<ChatResponse | null> {
  const parsed = parseDeterministicEnlargedPlanRequest(req.user_text || "");
  if (!parsed) return null;
  if (!getWriteGrantToken()) {
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: "This enlarged-plan sheet workflow is deterministic, but it needs an active write grant. In the Operator pane, set Writes to 'Allow this session' or YOLO, then retry.",
      actions: []
    };
  }

  const events: string[] = [];
  try {
    appendNotification(req.session_id, "deterministic.enlarged_plan.start", `Creating enlarged plans for unit ${parsed.unitNumber} on ${parsed.sheetNumber}.`, {
      sheet_number: parsed.sheetNumber,
      unit_number: parsed.unitNumber
    });
  } catch {
    // ignore
  }

  try {
    const ensured = await ensureSheet(parsed, events);
    let views = await listViews();
    const createdOrResolved: CreatedView[] = [];
    for (const kind of parsed.kinds) {
      const targetName = `${kind} ENLARGED PLAN - UNIT ${parsed.unitNumber}`;
      let target = findViewByExactName(views, targetName);
      if (!target) {
        const source = findSourcePlanView(views, kind, parsed.levelToken);
        if (!source) throw new Error(`Could not resolve a source ${kind.toLowerCase()} plan view${parsed.levelToken ? ` for ${parsed.levelToken}` : ""}.`);
        const duplicated = await bridgeJson("POST", "/revit/duplicate-view", { viewId: source.id, newName: targetName, withDetailing: true });
        target = { id: Number(duplicated.viewId ?? duplicated.id ?? 0), name: duplicated.name || targetName, type: source.type || "" };
        events.push(`Duplicated ${source.name} -> ${target.name}.`);
        views = await listViews();
        target = findViewByExactName(views, target.name) || target;
      } else {
        events.push(`Reused existing view ${target.name}.`);
      }

      const viewId = Number.parseInt(`${target.id ?? 0}`, 10) || 0;
      if (viewId <= 0) throw new Error(`Resolved ${targetName} but did not get a valid view id.`);
      await bridgeJson("POST", "/revit/visibility", { action: "set_scale", viewId, scale: parsed.scale });
      const cropped = await cropViewToRoom(viewId, parsed, kind, events);
      createdOrResolved.push({ kind, viewId, name: target.name || targetName, cropped });
    }

    const points = placementPoints(ensured.sheetDetail, createdOrResolved.length);
    const placements = createdOrResolved.map((entry, index) => ({
      sheetId: ensured.sheetId,
      viewId: entry.viewId,
      x: points[index]?.x,
      y: points[index]?.y,
      moveIfAlreadyPlaced: true,
      lockViewport: false,
      placementType: "Viewport"
    }));
    const dryRun = await bridgeJson("POST", "/revit/place-views", { dryRun: true, behavior: "allOrNothing", placements });
    const dryFailures = (Array.isArray(dryRun.results) ? dryRun.results : []).filter((entry: any) => !entry?.ok);
    if (dryFailures.length > 0) throw new Error(`Placement dry run failed: ${dryFailures.map((entry: any) => entry.error || `item ${entry.index}`).join("; ")}`);

    const placed = await bridgeJson("POST", "/revit/place-views", { dryRun: false, behavior: "allOrNothing", placements });
    const placeFailures = (Array.isArray(placed.results) ? placed.results : []).filter((entry: any) => !entry?.ok);
    if (placeFailures.length > 0) throw new Error(`Placement failed: ${placeFailures.map((entry: any) => entry.error || `item ${entry.index}`).join("; ")}`);

    let verify = await sheetDetail(parsed.sheetNumber);
    const reflow = reflowPlacements(verify, ensured.sheetId, createdOrResolved);
    if (reflow) {
      await bridgeJson("POST", "/revit/place-views", { dryRun: false, behavior: "allOrNothing", placements: reflow });
      verify = await sheetDetail(parsed.sheetNumber);
      events.push("Ran left/right viewport reflow QC.");
    }
    await bridgeJson("POST", "/revit/activate-view", { viewId: ensured.sheetId, zoomToFit: true });

    for (const text of events) {
      try {
        appendEvent(req.session_id, "assistant", "deterministic.enlarged_plan", { text });
      } catch {
        // ignore
      }
    }

    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message:
        `Done — created ${parsed.sheetNumber} - ${verify.sheetName || "ENLARGED PLANS"} and placed ${createdOrResolved.map((entry) => entry.name).join(" and ")}. ` +
        `Verified ${verify.placedViewCount ?? createdOrResolved.length} placed view${Number(verify.placedViewCount) === 1 ? "" : "s"}${placedViewNames(verify) ? ` (${placedViewNames(verify)})` : ""}.`,
      actions: []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      appendNotification(req.session_id, "deterministic.enlarged_plan.failed", message, { sheet_number: parsed.sheetNumber, unit_number: parsed.unitNumber });
    } catch {
      // ignore
    }
    return {
      version: OPERATOR_BACKEND_CONTRACT_VERSION,
      assistant_message: `Deterministic enlarged-plan workflow failed: ${message}`,
      actions: []
    };
  }
}
