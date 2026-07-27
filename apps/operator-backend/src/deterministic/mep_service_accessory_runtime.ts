import type { ActionCall, ChatRequest, ChatResponse, ToolResult } from "../contracts.js";
import { OPERATOR_BACKEND_CONTRACT_VERSION } from "../contracts.js";

export const MEP_SERVICE_ACCESSORY_WORKFLOW_ID = "mep.service_accessory_preflight" as const;
export const MEP_SERVICE_ACCESSORY_TASK_SCHEMA = "revit-operator.mep-service-accessory-task.v1" as const;

export type MepServiceAccessoryTask = {
  schema: typeof MEP_SERVICE_ACCESSORY_TASK_SCHEMA;
  operation: "place_service_accessory";
  accessory: { text: string; identity_terms: string[] };
  target: { text: string; identity_terms: string[] };
  room_number: string;
  service: {
    text: string;
    kind: "pipe" | "duct";
    system_classifications: string[];
  };
  mutation: { kind: "create"; requested: true };
  execution: { max_primary_actions: 3; requires_visual_verification: true };
  evidence: { user_text: string };
};

type State = {
  task: MepServiceAccessoryTask;
  stage: 0 | 1 | 2 | 3;
  candidate_ids: number[];
  target?: Record<string, unknown>;
  connector?: Record<string, unknown>;
  expires_at: number;
};

const states = new Map<string, State>();
const TTL_MS = 5 * 60_000;

function compact(value: string): string {
  return value.replace(/\s+/g, " ").replace(/[\s,;:.!?]+$/g, "").trim();
}

function stripArticle(value: string): string {
  return compact(value).replace(/^(?:a|an|the|one|new)\s+/i, "").trim();
}

function uniqueTerms(values: string[]): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of values) {
    const term = compact(raw).toLocaleLowerCase();
    if (term.length < 2 || term.length > 128 || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }
  return terms.slice(0, 8);
}

function targetIdentityTerms(target: string): string[] {
  const values = [target];
  if (/\b(?:toilet|water\s*closet|commode|wc)\b/i.test(target)) values.push("toilet", "water closet", "wc");
  if (/\b(?:sink|lav(?:atory)?)\b/i.test(target)) values.push("sink", "lavatory");
  if (/\burinal\b/i.test(target)) values.push("urinal");
  if (/\bshower\b/i.test(target)) values.push("shower");
  if (/\b(?:ahu|air[- ]handling\s+unit|air\s+handler)\b/i.test(target)) values.push("ahu", "air handling unit", "air handler");
  if (/\b(?:diffuser|air\s*terminal|grille|register)\b/i.test(target)) values.push("diffuser", "air terminal", "grille", "register");
  return uniqueTerms(values);
}

function systemClassifications(service: string): string[] {
  if (/\b(?:domestic\s+)?cold\s+water\b|\bDCW\b|\bCWS\b/i.test(service)) return ["DomesticColdWater"];
  if (/\b(?:domestic\s+)?hot\s+water\b|\bDHW\b|\bHWS\b/i.test(service)) return ["DomesticHotWater"];
  if (/\bdomestic\s+water\b/i.test(service)) return ["DomesticColdWater", "DomesticHotWater"];
  if (/\bsanitary\b/i.test(service)) return ["Sanitary"];
  if (/\bvent\b/i.test(service)) return ["Vent"];
  if (/\bsupply\s+air\b/i.test(service)) return ["SupplyAir"];
  if (/\breturn\s+air\b/i.test(service)) return ["ReturnAir"];
  if (/\bexhaust\s+air\b/i.test(service)) return ["ExhaustAir"];
  return [];
}

export function parseMepServiceAccessoryTask(userText: string): MepServiceAccessoryTask | null {
  const authoritativeText = userText.trim();
  const text = compact(authoritativeText);
  if (!text || authoritativeText.length > 4000) return null;
  const mutationCheck = text.replace(/\b(?:do\s+not|don't|dont|without)\s+(?:add|install|place|provide|insert|create)\b/gi, "");
  const match = /\b(?:add|install|place|provide|insert|create)\s+(.{2,128}?)\s+(?:to|on|onto|in)\s+(?:the\s+)?(.{2,160}?\b(?:piping|pipe|ductwork|duct))\s+(?:serving|that\s+serves?|which\s+serves?)\s+(?:the\s+)?(.{2,128}?)\s+(?:in|within|at)\s+(?:room|space)\s+([A-Za-z0-9][A-Za-z0-9._-]{0,31})\b/i.exec(mutationCheck);
  if (!match) return null;
  const accessory = stripArticle(match[1] ?? "");
  const service = stripArticle(match[2] ?? "");
  const target = stripArticle(match[3] ?? "");
  const roomNumber = compact(match[4] ?? "");
  if (!accessory || !service || !target || !roomNumber) return null;
  const kind = /\bduct(?:work)?\b/i.test(service) ? "duct" : /\bpip(?:e|ing)\b/i.test(service) ? "pipe" : null;
  if (!kind) return null;
  const targetTerms = targetIdentityTerms(target);
  if (targetTerms.length === 0) return null;
  return {
    schema: MEP_SERVICE_ACCESSORY_TASK_SCHEMA,
    operation: "place_service_accessory",
    accessory: { text: accessory, identity_terms: uniqueTerms([accessory]) },
    target: { text: target, identity_terms: targetTerms },
    room_number: roomNumber,
    service: { text: service, kind, system_classifications: systemClassifications(service) },
    mutation: { kind: "create", requested: true },
    execution: { max_primary_actions: 3, requires_visual_verification: true },
    evidence: { user_text: authoritativeText }
  };
}

function response(message: string, actions: ActionCall[] = [], status?: NonNullable<ChatResponse["aec_query_receipt"]>["status"]): ChatResponse {
  return {
    version: OPERATOR_BACKEND_CONTRACT_VERSION,
    assistant_message: message,
    actions,
    ...(status ? {
      aec_query_receipt: {
        schema: "revit-operator.aec-query-receipt.v1" as const,
        terminal: true as const,
        status,
        workflow_id: MEP_SERVICE_ACCESSORY_WORKFLOW_ID,
        bounded: true as const,
        broadened: false as const
      }
    } : {})
  };
}

function action(action_id: string, path: string, body: Record<string, unknown>): ActionCall {
  return { action_id, method: "POST", path, body };
}

function resultFor(req: ChatRequest, actionId: string): ToolResult | undefined {
  return req.tool_results?.find(result => result.action_id === actionId);
}

function payload(result: ToolResult | undefined): Record<string, unknown> | null {
  const value = result?.result_json;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function rows(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter(item => item && typeof item === "object" && !Array.isArray(item)) as Array<Record<string, unknown>> : [];
}

function elementIdsFromFind(value: Record<string, unknown> | null): number[] {
  const candidates = [
    ...(Array.isArray(value?.elementIds) ? value.elementIds : []),
    ...rows(value?.elements).map(item => item.id ?? item.elementId),
    ...rows(value?.items).map(item => item.elementId ?? item.id)
  ];
  return [...new Set(candidates.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 500);
}

function valueText(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function targetLabel(task: MepServiceAccessoryTask, target?: Record<string, unknown>): string {
  const id = Number(target?.elementId ?? target?.id);
  const family = valueText(target?.familyName);
  const type = valueText(target?.typeName) || valueText(target?.name);
  const identity = [family, type && type !== family ? type : ""].filter(Boolean).join(" / ");
  return `${task.target.text}${identity ? ` (${identity})` : ""}${Number.isSafeInteger(id) && id > 0 ? `, element ${id}` : ""}`;
}

function normalizedToken(value: unknown): string {
  return `${value ?? ""}`.replace(/[^a-z0-9]+/gi, "").toLocaleLowerCase();
}

function connectorMatchesService(connector: Record<string, unknown>, task: MepServiceAccessoryTask): boolean {
  const expected = task.service.system_classifications.map(normalizedToken).filter(Boolean);
  const actual = normalizedToken(connector.systemClassification);
  if (expected.length > 0) return expected.includes(actual);
  const domain = normalizedToken(connector.domain);
  return task.service.kind === "pipe" ? /pip/.test(domain) : /hvac|duct/.test(domain);
}

function connectorIsPhysicallyConnected(connector: Record<string, unknown>): boolean {
  return connector.isPhysicallyConnected === true || Number(connector.physicalConnectionCount) > 0 || rows(connector.physicalConnectedTo).length > 0;
}

function connectorClassificationLabel(connectors: Array<Record<string, unknown>>, task: MepServiceAccessoryTask): string {
  const values = [...new Set(connectors.map(connector => valueText(connector.systemClassification)).filter(Boolean))];
  return values.length ? values.join(" / ") : task.service.text;
}

function purge(now = Date.now()): void {
  for (const [key, state] of states) if (state.expires_at <= now) states.delete(key);
}

function fail(stateKey: string, message: string, status: NonNullable<ChatResponse["aec_query_receipt"]>["status"] = "failed"): ChatResponse {
  states.delete(stateKey);
  return response(`${message} No model changes were made.`, [], status);
}

function continueRun(req: ChatRequest, stateKey: string, state: State): ChatResponse | null {
  if (state.stage === 0) {
    const result = resultFor(req, "mep-service-target-find");
    if (!result) return null;
    if (result.status !== "done") return fail(stateKey, `I could not find candidate ${state.task.target.text} elements: ${result.error || "the bounded identity lookup failed"}.`);
    const root = payload(result);
    if (root?.truncated === true || root?.scanCapReached === true || root?.itemsComplete === false) return fail(stateKey, `The candidate search for ${state.task.target.text} was incomplete, so I will not guess which element is in Room ${state.task.room_number}.`);
    const ids = elementIdsFromFind(root);
    if (ids.length === 0) return fail(stateKey, `I could not find a physical model instance matching ${state.task.target.text}.`, "not_found");
    states.set(stateKey, { ...state, stage: 1, candidate_ids: ids, expires_at: Date.now() + TTL_MS });
    return response(`I found candidate ${state.task.target.text} instances. I’m resolving them against the exact host or linked Room ${state.task.room_number} before inspecting any service connection.`, [action("mep-service-target-locate", "/revit/locate-elements", {
      elementIds: ids,
      roomNumber: state.task.room_number,
      limit: Math.min(500, ids.length + 1),
      spatialResolution: "geometry_with_nearest",
      spatialVerticalScope: "same_level",
      spatialKindPreference: "room",
      includeHostRooms: true,
      includeHostSpaces: false,
      includeLinkedRooms: true,
      nearestCandidateLimit: 5
    })]);
  }

  if (state.stage === 1) {
    const result = resultFor(req, "mep-service-target-locate");
    if (!result) return null;
    if (result.status !== "done") return fail(stateKey, `I could not resolve the candidate ${state.task.target.text} instances against Room ${state.task.room_number}: ${result.error || "the phase-aware room lookup failed"}.`);
    const locatedRows = rows(payload(result)?.items);
    const resolved = locatedRows.filter(item => {
      const spatial = item.spatialContext && typeof item.spatialContext === "object" && !Array.isArray(item.spatialContext) ? item.spatialContext as Record<string, unknown> : null;
      const selected = spatial?.selected && typeof spatial.selected === "object" && !Array.isArray(spatial.selected) ? spatial.selected as Record<string, unknown> : null;
      return spatial?.status === "resolved" && valueText(item.roomNumber ?? selected?.number).toLocaleLowerCase() === state.task.room_number.toLocaleLowerCase();
    });
    if (locatedRows.some(item => (item.spatialContext as Record<string, unknown> | undefined)?.status !== "resolved")) {
      return fail(stateKey, `At least one candidate ${state.task.target.text} has an ambiguous or unresolved relationship to Room ${state.task.room_number}. Please identify the intended fixture; I will not turn a possible room match into a unique target.`, "ambiguous");
    }
    if (resolved.length === 0) return fail(stateKey, `I found candidate ${state.task.target.text} instances, but none resolved factually inside Room ${state.task.room_number}.`, "not_found");
    if (resolved.length > 1) return fail(stateKey, `I found ${resolved.length} ${state.task.target.text} instances in Room ${state.task.room_number}. Please identify which one should receive the ${state.task.accessory.text}; I will not choose by proximity.`, "ambiguous");
    const located = resolved;
    const target = located[0];
    const targetId = Number(target.elementId ?? target.id);
    if (!Number.isSafeInteger(targetId) || targetId <= 0) return fail(stateKey, `The unique ${state.task.target.text} in Room ${state.task.room_number} did not return a valid Revit element id.`);
    states.set(stateKey, { ...state, stage: 2, target, expires_at: Date.now() + TTL_MS });
    return response(`I resolved one exact ${state.task.target.text} in Room ${state.task.room_number}. I’m checking its physical ${state.task.service.text} connector graph; nearby curves will not be treated as serving connections.`, [action("mep-service-target-connectors", "/revit/get-connectors", {
      elementIds: [targetId],
      includeAllRefs: true,
      includeCoordinateSystem: true,
      maxConnectorsPerElement: 64
    })]);
  }

  if (state.stage === 2) {
    const result = resultFor(req, "mep-service-target-connectors");
    if (!result) return null;
    if (result.status !== "done") return fail(stateKey, `I resolved ${targetLabel(state.task, state.target)} in Room ${state.task.room_number}, but connector readback failed: ${result.error || "unknown connector error"}.`);
    const connectorRows = rows(payload(result)?.results);
    const targetId = Number(state.target?.elementId ?? state.target?.id);
    const exact = connectorRows.find(row => Number(row.id ?? row.elementId) === targetId) ?? connectorRows[0];
    if (!exact || exact.ok === false) return fail(stateKey, `I resolved ${targetLabel(state.task, state.target)} in Room ${state.task.room_number}, but Revit did not return a trustworthy connector row.`);
    const connectors = rows(exact.connectors);
    const matching = connectors.filter(connector => connectorMatchesService(connector, state.task));
    if (matching.length === 0) return fail(stateKey, `I found ${targetLabel(state.task, state.target)} in Room ${state.task.room_number}, but it has no connector matching the requested ${state.task.service.text} service. Please confirm the intended service or target fixture.`, "ambiguous");
    const connected = matching.filter(connectorIsPhysicallyConnected);
    const serviceLabel = connectorClassificationLabel(matching, state.task);
    if (connected.length === 0) {
      states.delete(stateKey);
      return response(`I found ${targetLabel(state.task, state.target)} in Room ${state.task.room_number}, but its ${serviceLabel} connector${matching.length === 1 ? " is" : "s are"} open and ${matching.length === 1 ? "has" : "have"} no physical ${state.task.service.kind} connection. There is no existing ${state.task.service.text} “serving” it on which I can place the ${state.task.accessory.text}. Should I first route and connect a ${state.task.service.text} branch to this ${state.task.target.text}, or did you mean a different target? No model changes were made.`, [], "ambiguous");
    }
    const connector = connected[0];
    states.set(stateKey, { ...state, stage: 3, connector, expires_at: Date.now() + TTL_MS });
    return response(`I proved a physical ${serviceLabel} connection at ${targetLabel(state.task, state.target)}. I’m tracing only the bounded local connector graph to identify the actual serving ${state.task.service.kind} curve rather than substituting a nearby curve.`, [action("mep-service-target-trace", "/revit/trace-connected-network", {
      startElementId: targetId,
      inferSystemFromStart: true,
      stopAtBranchFittings: true,
      stopAtTransitions: false,
      maxHops: 4,
      includeDucts: state.task.service.kind === "duct",
      includePipes: state.task.service.kind === "pipe",
      includeFittings: true,
      includeAccessories: true,
      includeTerminals: false,
      includeEquipment: false,
      includeOtherCategories: false,
      maxElements: 200,
      includeSystemAudit: false
    })]);
  }

  const trace = resultFor(req, "mep-service-target-trace");
  if (!trace) return null;
  if (trace.status !== "done") return fail(stateKey, `I proved a physical connection at ${targetLabel(state.task, state.target)}, but the bounded serving-network trace failed: ${trace.error || "unknown trace error"}.`);
  const root = payload(trace);
  const warnings = Array.isArray(root?.warnings) ? root.warnings.map(valueText).filter(Boolean) : [];
  const truncated = Number(root?.visitedCount) >= Number(root?.maxElements) || warnings.some(warning => /truncat|reached\s+max/i.test(warning));
  if (truncated) return fail(stateKey, `The serving-network trace from ${targetLabel(state.task, state.target)} reached its safety cap, so I cannot hand off a complete serving curve.`);
  const byCategory = root?.elementIdsByCategory && typeof root.elementIdsByCategory === "object" && !Array.isArray(root.elementIdsByCategory) ? root.elementIdsByCategory as Record<string, unknown> : {};
  const curveKey = state.task.service.kind === "pipe" ? "OST_PipeCurves" : "OST_DuctCurves";
  const curveIds = (Array.isArray(byCategory[curveKey]) ? byCategory[curveKey] : []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
  if (curveIds.length === 0) return fail(stateKey, `The physical connector graph from ${targetLabel(state.task, state.target)} contained no ${state.task.service.kind} curve, so I cannot claim that an editable service segment was resolved.`, "ambiguous");
  states.delete(stateKey);
  const connectorId = state.connector?.connectorId ?? state.connector?.index ?? "unknown";
  return response(`I resolved the bounded serving target: ${targetLabel(state.task, state.target)} in Room ${state.task.room_number}, connector ${connectorId}, with serving ${state.task.service.kind} curve${curveIds.length === 1 ? "" : "s"} ${curveIds.join(", ")}. This is a grounded handoff, but no verified existing-segment insertion action is available yet for ${state.task.accessory.text}, so I stopped before an unsafe generic placement. No model changes were made.`, [], "found");
}

export function maybeRunMepServiceAccessoryPreflight(req: ChatRequest): ChatResponse | null {
  purge();
  const stateKey = req.session_id;
  const userText = compact(req.user_text ?? "");
  if (userText) {
    const task = parseMepServiceAccessoryTask(userText);
    if (!task) {
      states.delete(stateKey);
      return null;
    }
    const state: State = { task, stage: 0, candidate_ids: [], expires_at: Date.now() + TTL_MS };
    states.set(stateKey, state);
    return response(`I’m grounding the requested ${task.accessory.text} placement before any write: first the exact ${task.target.text} in Room ${task.room_number}, then its physical ${task.service.text} connector graph.`, [action("mep-service-target-find", "/revit/find-elements", {
      identityTerms: task.target.identity_terms,
      physicalElementsOnly: true,
      topLevelInstancesOnly: true,
      limit: 500
    })]);
  }
  const state = states.get(stateKey);
  return state ? continueRun(req, stateKey, state) : null;
}

export function __testOnlyClearMepServiceAccessoryStates(): void {
  states.clear();
}
