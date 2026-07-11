import type { ActionCall, ToolResult } from "../contracts.js";

type MepSemanticKind = "pipe" | "duct" | "unknown";
type MepSemanticOperation = "branch_to_target" | "route_network_to_targets" | "verify_existing" | "unknown";
type MepSemanticStatus = "not_applicable" | "needs_discovery" | "dry_run_ready" | "blocked";
type MepSemanticTargetClass = "sink" | "diffuser" | "air_terminal" | "plumbing_fixture" | "fixture" | "unknown";

export type MepSemanticRouteRequest = {
  user_text?: string;
  view_id?: number;
  viewId?: number;
  room_number?: string;
  roomNumber?: string;
  level_name?: string;
  levelName?: string;
  tool_results?: ToolResult[];
  toolResults?: ToolResult[];
};

export type MepSemanticRoutePlan = {
  kind: MepSemanticKind;
  operation: MepSemanticOperation;
  target_class: MepSemanticTargetClass;
  source: {
    strategy: "nearest_compatible_editable_main" | "selected_or_visible_main" | "unresolved";
    element_id?: number;
  };
  targets: Array<{
    strategy: "visible_or_selected_target" | "all_visible_targets" | "unresolved";
    class: MepSemanticTargetClass;
    element_id?: number;
    point?: { x: number; y: number; z?: number };
  }>;
  system: {
    policy: "inherit_from_main" | "explicit_from_text" | "unresolved";
    value?: string;
  };
  size_policy: "inherit_from_main" | "inherit_from_target_connector" | "explicit_from_text" | "unresolved";
  topology: "single_branch" | "trunk_with_branches" | "unknown";
  confidence: "high" | "medium" | "low";
  assumptions: string[];
  blockers: string[];
  required_discovery: string[];
  evidence: {
    target_count: number;
    main_count: number;
    has_target_point: boolean;
    has_projected_main_point: boolean;
  };
  dry_run_action?: ActionCall;
};

export type MepSemanticRouteResponse = {
  ok: boolean;
  handled: boolean;
  status: MepSemanticStatus;
  plan?: MepSemanticRoutePlan;
  next_actions: ActionCall[];
  assistant_message: string;
  blocker?: string;
};

type CandidateElement = {
  id: number;
  category?: string;
  name?: string;
  familyName?: string;
  typeName?: string;
  systemName?: string;
  systemType?: string;
  point?: { x: number; y: number; z?: number };
  projectedPoint?: { x: number; y: number; z?: number };
};

function textOf(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function numberOf(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function pointFrom(value: unknown): { x: number; y: number; z?: number } | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const x = numberOf(record.x ?? record.X);
  const y = numberOf(record.y ?? record.Y);
  const z = numberOf(record.z ?? record.Z);
  if (x === undefined || y === undefined) return undefined;
  return z === undefined ? { x, y } : { x, y, z };
}

function inferKind(text: string): MepSemanticKind {
  if (/\b(duct|ductwork|diffuser|diffusers|air\s*terminal|grille|supply\s+air|return\s+air|exhaust\s+air|low\s+pressure)\b/i.test(text)) return "duct";
  if (/\b(pipe|piping|sink|lav(?:atory)?|plumbing|domestic|sanitary|vent|cw|hw|chw|hhw)\b/i.test(text)) return "pipe";
  return "unknown";
}

function inferTargetClass(text: string): MepSemanticTargetClass {
  if (/\b(sink|lav(?:atory)?)\b/i.test(text)) return "sink";
  if (/\b(diffuser|diffusers)\b/i.test(text)) return "diffuser";
  if (/\b(air\s*terminal|grille|register)\b/i.test(text)) return "air_terminal";
  if (/\b(plumbing\s+fixture|fixture)\b/i.test(text)) return "plumbing_fixture";
  return "unknown";
}

function inferOperation(text: string, targetClass: MepSemanticTargetClass): MepSemanticOperation {
  if (/\b(?:verify|check|confirm)\b[\s\S]{0,48}\b(?:existing|whether|if)\b|\bis\s+there\b/i.test(text)) return "verify_existing";
  if (targetClass === "diffuser" || targetClass === "air_terminal" || /\b(to\s+the\s+diffusers|serve\s+diffusers)\b/i.test(text)) return "route_network_to_targets";
  if (/\b(?:extend(?:ing|ed|s)?|extension|connect|route|run|branch|tap)\b/i.test(text)) return "branch_to_target";
  return "unknown";
}

function inferSystem(text: string): { policy: MepSemanticRoutePlan["system"]["policy"]; value?: string } {
  if (/\blow\s+pressure\b/i.test(text)) return { policy: "explicit_from_text", value: "low pressure" };
  if (/\bdomestic\s+cold\s+water|\bCW\b/i.test(text)) return { policy: "explicit_from_text", value: "Domestic Cold Water" };
  if (/\bdomestic\s+hot\s+water|\bHW\b/i.test(text)) return { policy: "explicit_from_text", value: "Domestic Hot Water" };
  if (/\bsupply\s+air\b/i.test(text)) return { policy: "explicit_from_text", value: "Supply Air" };
  return { policy: "inherit_from_main" };
}

function extractElementsFromResult(result: ToolResult): CandidateElement[] {
  const root = asRecord(result.result_json);
  if (!root) return [];
  const arrays = [root.elements, root.items, root.candidates, root.visibleElements, root.results].filter(Array.isArray) as unknown[][];
  const elements: CandidateElement[] = [];
  for (const arr of arrays) {
    for (const raw of arr) {
      const record = asRecord(raw);
      if (!record) continue;
      const id = numberOf(record.id ?? record.elementId ?? record.element_id);
      if (id === undefined) continue;
      elements.push({
        id,
        category: textOf(record.category ?? record.categoryName),
        name: textOf(record.name),
        familyName: textOf(record.familyName ?? record.family),
        typeName: textOf(record.typeName ?? record.type),
        systemName: textOf(record.systemName),
        systemType: textOf(record.systemType),
        point: pointFrom(record.point ?? record.location ?? record.center ?? record.origin),
        projectedPoint: pointFrom(record.projectedPoint ?? record.projected_main_point ?? record.tapPoint)
      });
    }
  }
  return elements;
}

function candidateText(element: CandidateElement): string {
  return [element.category, element.name, element.familyName, element.typeName, element.systemName, element.systemType].filter(Boolean).join(" ").toLowerCase();
}

function isTargetCandidate(element: CandidateElement, targetClass: MepSemanticTargetClass): boolean {
  const text = candidateText(element);
  if (targetClass === "sink") return /\b(sink|lav|plumbing fixture|plumbing fixtures|plumbingfixtures|ost_plumbingfixtures)\b/i.test(text);
  if (targetClass === "diffuser") return /\b(diffuser|air terminal|air terminals|airterminal|ductterminal|ost_ductterminal|grille|register)\b/i.test(text);
  if (targetClass === "air_terminal") return /\b(air terminal|airterminal|ductterminal|ost_ductterminal|diffuser|grille|register)\b/i.test(text);
  if (targetClass === "plumbing_fixture" || targetClass === "fixture") return /\b(fixture|plumbingfixtures|ost_plumbingfixtures|sink|lav)\b/i.test(text);
  return false;
}

function isMainCandidate(element: CandidateElement, kind: MepSemanticKind, systemValue?: string): boolean {
  const text = candidateText(element);
  if (kind === "pipe" && !/\b(pipe|pipes|piping|pipecurves|ost_pipecurves)\b/i.test(text)) return false;
  if (kind === "duct" && !/\b(duct|ducts|ductwork|ductcurves|ost_ductcurves)\b/i.test(text)) return false;
  if (systemValue && !text.includes(systemValue.toLowerCase())) return /\bmain\b/i.test(text);
  return true;
}

function discoveryActions(args: { kind: MepSemanticKind; operation: MepSemanticOperation; targetClass: MepSemanticTargetClass; viewId?: number; roomNumber?: string; levelName?: string }): ActionCall[] {
  const base = {
    viewId: args.viewId,
    roomNumber: args.roomNumber,
    levelName: args.levelName
  };
  const actions: ActionCall[] = [];
  if (args.targetClass === "sink" || args.targetClass === "plumbing_fixture" || args.targetClass === "fixture") {
    actions.push({
      action_id: "semantic_mep_find_targets",
      method: "POST",
      path: "/revit/find-elements",
      body: { ...base, category: "OST_PlumbingFixtures", query: "sink lav plumbing fixture", includeLocation: true, includeConnectors: true }
    });
  }
  if (args.targetClass === "diffuser" || args.targetClass === "air_terminal") {
    actions.push({
      action_id: "semantic_mep_find_targets",
      method: "POST",
      path: "/revit/find-elements",
      body: { ...base, category: "OST_DuctTerminal", query: "diffuser air terminal grille", includeLocation: true, includeConnectors: true }
    });
  }
  if (args.kind === "pipe") {
    actions.push({
      action_id: "semantic_mep_find_mains",
      method: "POST",
      path: "/revit/find-elements",
      body: { ...base, category: "OST_PipeCurves", query: "editable pipe main", includeLocation: true, includeConnectors: true }
    });
  }
  if (args.kind === "duct") {
    actions.push({
      action_id: "semantic_mep_find_mains",
      method: "POST",
      path: "/revit/find-elements",
      body: { ...base, category: "OST_DuctCurves", query: "editable duct main", includeLocation: true, includeConnectors: true }
    });
  }
  if (args.operation === "route_network_to_targets") {
    actions.push({
      action_id: "semantic_mep_visible_context",
      method: "POST",
      path: "/revit/export-visible-elements",
      body: { ...base, includeMep: true, includeRooms: true, includeGeometry: true }
    });
  }
  return actions;
}

export function resolveMepSemanticRoutePlan(req: MepSemanticRouteRequest): MepSemanticRouteResponse {
  const userText = textOf(req.user_text);
  const viewId = numberOf(req.view_id ?? req.viewId);
  const roomNumber = textOf(req.room_number ?? req.roomNumber) || undefined;
  const levelName = textOf(req.level_name ?? req.levelName) || undefined;
  if (!/\b(pipe|piping|duct|ductwork|diffuser|sink|lav|plumbing|air\s*terminal|grille)\b/i.test(userText)) {
    return {
      ok: true,
      handled: false,
      status: "not_applicable",
      next_actions: [],
      assistant_message: "No semantic MEP routing request was detected."
    };
  }

  const kind = inferKind(userText);
  const targetClass = inferTargetClass(userText);
  const operation = inferOperation(userText, targetClass);
  const system = inferSystem(userText);
  const toolResults = Array.isArray(req.tool_results) ? req.tool_results : Array.isArray(req.toolResults) ? req.toolResults : [];
  const elements = toolResults.flatMap(extractElementsFromResult);
  const targets = elements.filter((element) => isTargetCandidate(element, targetClass));
  const mains = elements.filter((element) => isMainCandidate(element, kind, system.value));
  const firstTarget = targets[0];
  const firstMain = mains[0];
  const projectedMainPoint = firstMain?.projectedPoint ?? firstTarget?.projectedPoint;

  const assumptions: string[] = [];
  if (kind === "pipe") assumptions.push("Use the nearest compatible editable pipe main unless the user selected a different source.");
  if (kind === "duct") assumptions.push("Use the nearest compatible editable duct main unless the user selected a different source.");
  if (system.policy === "inherit_from_main") assumptions.push("Inherit system from the selected main.");
  assumptions.push("Inherit size from the selected main unless explicit size or target connector evidence overrides it.");

  const blockers: string[] = [];
  if (kind === "unknown") blockers.push("Could not infer whether this is a pipe or duct route.");
  if (targetClass === "unknown") blockers.push("Could not infer a routable target class such as sink or diffuser.");
  if (operation === "unknown") blockers.push("Could not infer a supported route operation.");
  if (targets.length > 1 && operation === "branch_to_target") blockers.push("Multiple possible targets were discovered; select one or switch to a network workflow.");
  if (mains.length > 1 && operation === "branch_to_target") blockers.push("Multiple possible mains were discovered; select the intended main or provide a source element id.");

  const requiredDiscovery: string[] = [];
  if (targets.length === 0) requiredDiscovery.push("visible_or_selected_target_with_location_and_connectors");
  if (mains.length === 0) requiredDiscovery.push("nearest_compatible_editable_main_with_connectors");
  if (!firstTarget?.point) requiredDiscovery.push("target_connection_or_location_point");
  if (!projectedMainPoint) requiredDiscovery.push("projected_tap_or_branch_point_on_main");

  const plan: MepSemanticRoutePlan = {
    kind,
    operation,
    target_class: targetClass,
    source: {
      strategy: firstMain ? "nearest_compatible_editable_main" : "unresolved",
      ...(firstMain ? { element_id: firstMain.id } : {})
    },
    targets: firstTarget
      ? [{ strategy: targets.length > 1 ? "all_visible_targets" : "visible_or_selected_target", class: targetClass, element_id: firstTarget.id, ...(firstTarget.point ? { point: firstTarget.point } : {}) }]
      : [{ strategy: "unresolved", class: targetClass }],
    system,
    size_policy: "inherit_from_main",
    topology: operation === "route_network_to_targets" ? "trunk_with_branches" : operation === "branch_to_target" ? "single_branch" : "unknown",
    confidence: blockers.length > 0 ? "low" : requiredDiscovery.length > 0 ? "medium" : "high",
    assumptions,
    blockers,
    required_discovery: requiredDiscovery,
    evidence: {
      target_count: targets.length,
      main_count: mains.length,
      has_target_point: !!firstTarget?.point,
      has_projected_main_point: !!projectedMainPoint
    }
  };

  if (blockers.length === 0 && requiredDiscovery.length === 0 && firstMain && firstTarget?.point && projectedMainPoint) {
    plan.dry_run_action = {
      action_id: "semantic_mep_branch_dry_run",
      method: "POST",
      path: "/revit/connect-mep-branch",
      body: {
        kind,
        mainElementId: firstMain.id,
        branchPoints: [projectedMainPoint, firstTarget.point],
        connectionMode: "auto",
        dryRun: true,
        verify: true,
        visualVerify: false,
        ...(viewId !== undefined ? { viewId } : {}),
        ...(roomNumber ? { roomNumber } : {}),
        ...(levelName ? { levelName } : {})
      }
    };
  }

  const nextActions = plan.dry_run_action ? [plan.dry_run_action] : discoveryActions({ kind, operation, targetClass, viewId, roomNumber, levelName });
  const status: MepSemanticStatus = blockers.length > 0 ? "blocked" : plan.dry_run_action ? "dry_run_ready" : "needs_discovery";
  const assistantMessage =
    status === "dry_run_ready"
      ? "I resolved a semantic MEP route intent to a guarded dry-run branch action. Review the projected tap point, inherited system/size assumptions, and connector evidence before any apply."
      : status === "blocked"
        ? `I could not safely resolve this semantic MEP route yet: ${blockers.join(" ")}`
        : "I resolved the semantic MEP route intent, but more read-only model discovery is required before a dry-run route plan can be formed.";

  return {
    ok: true,
    handled: true,
    status,
    plan,
    next_actions: nextActions,
    assistant_message: assistantMessage,
    ...(blockers.length > 0 ? { blocker: blockers.join(" ") } : {})
  };
}
