import crypto from "node:crypto";

type JsonObject = Record<string, unknown>;

export type ExistingConditionsEvaluatorChangeReceipt = {
  native_diff_readback: true;
  changed_element_keys: string[];
  out_of_scope_changed_element_keys: string[];
  receipt_sha256: string;
};

type Bounds = {
  min: { x: number; y: number; z: number };
  max: { x: number; y: number; z: number };
};

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function number(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const input = value as JsonObject;
    return Object.fromEntries(Object.keys(input).sort().map((key) => [key, stable(input[key])]));
  }
  return value;
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}

function unorderedArray(value: unknown): unknown[] | null {
  if (!Array.isArray(value)) return null;
  return [...value].map(stable).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function normalizedElectricalCircuit(value: unknown): unknown {
  const circuit = object(value);
  if (Object.keys(circuit).length === 0) return null;
  // primaryLabel is a presentation convenience selected from labels. Multi-system
  // equipment can enumerate those systems in a different order between reads.
  const { primaryLabel: _primaryLabel, ...deterministicCircuit } = circuit;
  return {
    ...deterministicCircuit,
    ...(Array.isArray(circuit.labels) ? { labels: unorderedArray(circuit.labels) } : {}),
    ...(Array.isArray(circuit.normalizedLabels) ? { normalizedLabels: unorderedArray(circuit.normalizedLabels) } : {}),
    ...(Array.isArray(circuit.systemIds) ? { systemIds: unorderedArray(circuit.systemIds) } : {}),
    ...(Array.isArray(circuit.powerSystemIds) ? { powerSystemIds: unorderedArray(circuit.powerSystemIds) } : {})
  };
}

function normalizedConnectorsSummary(value: unknown): unknown {
  const summary = object(value);
  if (Object.keys(summary).length === 0) return null;
  // The native exporter intentionally bounds sampleConnectors. Connector iteration order
  // is not stable, so two identical models can expose different members of that sample.
  // Compare the complete aggregate fields below instead of treating the sample as evidence.
  const { sampleConnectors: _sampleConnectors, ...deterministicSummary } = summary;
  return {
    ...deterministicSummary,
    ...(Array.isArray(summary.shapes) ? { shapes: unorderedArray(summary.shapes) } : {}),
    ...(Array.isArray(summary.domains) ? { domains: unorderedArray(summary.domains) } : {}),
    ...(Array.isArray(summary.connectedElementScopedIds) ? { connectedElementScopedIds: unorderedArray(summary.connectedElementScopedIds) } : {})
  };
}

function normalizedSystem(value: unknown, fallbackName: unknown): unknown {
  const system = object(value);
  if (Object.keys(system).length === 0) return fallbackName ?? null;
  return {
    ...system,
    ...(Array.isArray(system.candidates) ? { candidates: unorderedArray(system.candidates) } : {}),
    ...(Array.isArray(system.connectedElementScopedIds) ? { connectedElementScopedIds: unorderedArray(system.connectedElementScopedIds) } : {})
  };
}

function normalizedParameters(item: JsonObject): unknown {
  const parameters = object(item.parameters);
  if (Object.keys(parameters).length === 0) return null;
  const category = categoryToken(item);
  if (category !== "ost_ductcurves" && category !== "ost_pipecurves") return parameters;
  // Revit recalculates flow display values across a connected curve network when an
  // in-scope branch is added. Those read-only values are not edits to the surrounding
  // curves. Terminal/fixture design-flow parameters remain fingerprinted normally.
  const { cfm: _cfm, airflow: _airflow, flow: _flow, ...deterministicParameters } = parameters;
  return deterministicParameters;
}

function exportObject(value: unknown): JsonObject {
  const root = object(value);
  return Object.keys(object(root.result)).length > 0 ? object(root.result) : root;
}

function completeItems(value: unknown, label: string): JsonObject[] {
  const exported = exportObject(value);
  if (exported.truncated === true) throw new Error(`${label}_visible_inventory_is_truncated`);
  if (!Array.isArray(exported.items)) throw new Error(`${label}_visible_inventory_has_no_items`);
  const declaredCount = number(exported.count);
  if (declaredCount !== null && declaredCount !== exported.items.length) {
    throw new Error(`${label}_visible_inventory_count_mismatch`);
  }
  return exported.items.map(object);
}

function elementKey(item: JsonObject): string {
  const candidates = [item.sourceScopedId, item.uniqueId, item.elementId, item.id];
  const selected = candidates.map((value) => String(value ?? "").trim()).find(Boolean);
  if (!selected) throw new Error("visible_inventory_item_has_no_stable_key");
  return selected;
}

function categoryToken(item: JsonObject): string {
  return String(item.builtInCategory ?? item.categoryToken ?? item.category ?? "").trim().toLowerCase();
}

function modelPoint(value: unknown): { x: number; y: number; z: number } | null {
  const candidate = object(value);
  const x = number(candidate.x);
  const y = number(candidate.y);
  const z = number(candidate.z);
  return x === null || y === null || z === null ? null : { x, y, z };
}

function points(item: JsonObject): Array<{ x: number; y: number; z: number }> {
  const geometry = object(item.geometry);
  const bboxModel = object(item.bboxModel);
  const bbox = object(item.bbox);
  return [
    modelPoint(item.point),
    modelPoint(item.center),
    modelPoint(item.bboxCenter),
    modelPoint(object(geometry.point).model),
    modelPoint(object(geometry.start).model),
    modelPoint(object(geometry.end).model),
    modelPoint(bboxModel.min),
    modelPoint(bboxModel.max),
    modelPoint(object(bbox.model).min),
    modelPoint(object(bbox.model).max)
  ].filter((value): value is { x: number; y: number; z: number } => value !== null);
}

function inside(point: { x: number; y: number; z: number }, bounds: Bounds): boolean {
  return point.x >= bounds.min.x && point.x <= bounds.max.x &&
    point.y >= bounds.min.y && point.y <= bounds.max.y &&
    point.z >= bounds.min.z && point.z <= bounds.max.z;
}

function isInScope(item: JsonObject, bounds: Bounds, allowedCategories: Set<string>): boolean {
  if (!allowedCategories.has(categoryToken(item))) return false;
  return points(item).some((point) => inside(point, bounds));
}

function fingerprint(item: JsonObject): string {
  return digest({
    category: item.builtInCategory ?? item.categoryToken ?? item.category ?? null,
    family: item.familyName ?? null,
    type: item.typeName ?? null,
    level: item.levelName ?? null,
    host: item.hostResolvedScopedId ?? item.hostScopedId ?? item.hostId ?? null,
    system: normalizedSystem(item.system, item.systemName),
    electricalCircuit: normalizedElectricalCircuit(item.electricalCircuit),
    point: item.point ?? null,
    bboxModel: item.bboxModel ?? null,
    geometry: item.geometry ?? null,
    orientation: item.orientation ?? null,
    parameters: normalizedParameters(item),
    connectorsSummary: normalizedConnectorsSummary(item.connectorsSummary)
  });
}

function parseScope(agentPackage: unknown): { bounds: Bounds; allowedCategories: Set<string> } {
  const root = object(agentPackage);
  const scope = object(root.scope);
  const rawBounds = object(scope.model_bounds_ft);
  const min = modelPoint(rawBounds.min);
  const max = modelPoint(rawBounds.max);
  if (!min || !max || min.x > max.x || min.y > max.y || min.z > max.z) {
    throw new Error("agent_package_has_invalid_model_bounds");
  }
  if (!Array.isArray(root.allowed_categories) || root.allowed_categories.length === 0) {
    throw new Error("agent_package_has_no_allowed_categories");
  }
  const allowedCategories = new Set(root.allowed_categories.map((value) => String(value).trim().toLowerCase()).filter(Boolean));
  return { bounds: { min, max }, allowedCategories };
}

export function createExistingConditionsEvaluatorChangeReceipt(
  beforeVisible: unknown,
  afterVisible: unknown,
  agentPackage: unknown
): ExistingConditionsEvaluatorChangeReceipt {
  const beforeExport = exportObject(beforeVisible);
  const afterExport = exportObject(afterVisible);
  const beforeViewId = String(beforeExport.viewId ?? "").trim();
  const afterViewId = String(afterExport.viewId ?? "").trim();
  if (!beforeViewId || beforeViewId !== afterViewId) throw new Error("visible_inventory_view_mismatch");

  const before = completeItems(beforeVisible, "before");
  const after = completeItems(afterVisible, "after");
  const { bounds, allowedCategories } = parseScope(agentPackage);
  const beforeByKey = new Map(before.map((item) => [elementKey(item), item]));
  const afterByKey = new Map(after.map((item) => [elementKey(item), item]));
  const allKeys = [...new Set([...beforeByKey.keys(), ...afterByKey.keys()])].sort();
  const changed: string[] = [];
  const outOfScope: string[] = [];

  for (const key of allKeys) {
    const prior = beforeByKey.get(key);
    const next = afterByKey.get(key);
    if (prior && next && fingerprint(prior) === fingerprint(next)) continue;
    changed.push(key);
    if (!((prior && isInScope(prior, bounds, allowedCategories)) || (next && isInScope(next, bounds, allowedCategories)))) {
      outOfScope.push(key);
    }
  }

  const payload = {
    native_diff_readback: true as const,
    changed_element_keys: changed,
    out_of_scope_changed_element_keys: outOfScope
  };
  return { ...payload, receipt_sha256: digest(payload) };
}
