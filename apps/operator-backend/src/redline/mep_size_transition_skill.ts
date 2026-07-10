export type RedlineMepSizeTransitionStatus =
  | "success"
  | "failed"
  | "needs_human_review"
  | "target_not_found"
  | "invalid_parameter"
  | "verification_failed";

export type RedlineMepSizeTransitionKind = "pipe" | "duct";

export type RedlineMepSizeTransitionPoint = {
  x: number;
  y: number;
  z?: number;
};

export type RedlineMepSizeTransitionAction = {
  operation?: "size_transition" | string;
  target?: RedlineMepSizeTransitionKind | string;
  kind?: RedlineMepSizeTransitionKind | string;
  hostElementId?: number;
  viewId?: number;
  visualViewId?: number;
  systemType?: string;
  levelName?: string;
  upstreamSize?: string;
  downstreamSize?: string;
  transitionPoint?: RedlineMepSizeTransitionPoint;
  transitionChainageFt?: number;
  dryRun?: boolean;
  apply?: boolean;
};

export type RedlineMepSizeTransitionContext = {
  views?: Array<{
    view_id?: number;
    viewId?: number;
    id?: number;
    name?: string;
  }>;
  mep_routes?: RedlineMepSizeTransitionRoute[];
  mepRoutes?: RedlineMepSizeTransitionRoute[];
};

export type RedlineMepSizeTransitionRoute = {
  element_id?: number;
  elementId?: number;
  id?: number;
  kind?: string;
  system_type?: string;
  systemType?: string;
  level_name?: string;
  levelName?: string;
  size?: string;
  connectors?: Array<{
    connector_id?: string;
    connectorId?: string;
    connected?: boolean;
  }>;
};

export type RedlineMepSizeTransitionValidation = {
  status: RedlineMepSizeTransitionStatus;
  ok: boolean;
  reasons: string[];
  taxonomy: {
    operation_class: "size_transition";
    target_class: RedlineMepSizeTransitionKind;
    context_class: "host_model";
    evidence_requirements: ["model_write", "visual_gate", "projection_readback", "fitting_readback", "connector_network_audit", "cleanup_effect_ids"];
  };
  target?: {
    hostElementId: number;
    kind: RedlineMepSizeTransitionKind;
    systemType?: string;
    levelName?: string;
    currentSize?: string;
    connectorCount: number;
    connectedConnectorCount: number;
  };
  requiredLiveInputs: string[];
};

export type RedlineMepSizeTransitionPlan = {
  status: RedlineMepSizeTransitionStatus;
  validation: RedlineMepSizeTransitionValidation;
  endpoint: "/revit/reroute-mep-route-segment";
  benchmarkTaskId: "demo_redline_mep_pipe_size_transition" | "demo_redline_mep_duct_size_transition";
  request: Record<string, unknown>;
  requiredContext: string[];
  requiredEvidence: RedlineMepSizeTransitionValidation["taxonomy"]["evidence_requirements"];
};

export type RedlineMepSizeTransitionExecution = {
  status: RedlineMepSizeTransitionStatus;
  validation: RedlineMepSizeTransitionValidation;
  plan: RedlineMepSizeTransitionPlan;
  executionSource: "mock";
  executionMode: "dry_run_simulation";
  liveBridgeCall: false;
  writeGrantRequired: false;
  mockOnly: true;
  mockApplied: false;
  projectionReadback?: {
    kind: "projection_readback";
    transitionPoint?: RedlineMepSizeTransitionPoint;
    transitionChainageFt?: number;
  };
  sizeReadback?: {
    kind: "size_readback";
    upstreamSize: string;
    downstreamSize: string;
  };
  connectorAudit?: {
    kind: "connector_network_audit";
    connectorCount: number;
    connectedConnectorCount: number;
    connectedNetworkOk: boolean;
  };
  message: string;
};

export type RedlineMepSizeTransitionVerification = {
  status: RedlineMepSizeTransitionStatus;
  ok: boolean;
  checks: Array<{
    name: string;
    ok: boolean;
    expected: unknown;
    actual: unknown;
  }>;
};

function normalizedText(value: unknown): string {
  return String(value ?? "").trim();
}

function elementId(value: unknown): number | null {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function point(value: unknown): RedlineMepSizeTransitionPoint | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (!finiteNumber(candidate.x) || !finiteNumber(candidate.y)) return undefined;
  return { x: candidate.x, y: candidate.y, z: finiteNumber(candidate.z) ? candidate.z : 0 };
}

function routes(context: RedlineMepSizeTransitionContext): RedlineMepSizeTransitionRoute[] {
  return context.mep_routes ?? context.mepRoutes ?? [];
}

function routeId(route: RedlineMepSizeTransitionRoute): number | null {
  return elementId(route.element_id ?? route.elementId ?? route.id);
}

function routeKind(route: RedlineMepSizeTransitionRoute): RedlineMepSizeTransitionKind | null {
  const value = normalizedText(route.kind).toLowerCase();
  return value === "pipe" || value === "duct" ? value : null;
}

function routeSystem(route: RedlineMepSizeTransitionRoute): string {
  return normalizedText(route.system_type ?? route.systemType);
}

function routeLevel(route: RedlineMepSizeTransitionRoute): string {
  return normalizedText(route.level_name ?? route.levelName);
}

function actionKind(action: RedlineMepSizeTransitionAction): RedlineMepSizeTransitionKind | null {
  const value = normalizedText(action.kind || action.target).toLowerCase();
  return value === "pipe" || value === "duct" ? value : null;
}

function taxonomy(kind: RedlineMepSizeTransitionKind): RedlineMepSizeTransitionValidation["taxonomy"] {
  return {
    operation_class: "size_transition",
    target_class: kind,
    context_class: "host_model",
    evidence_requirements: ["model_write", "visual_gate", "projection_readback", "fitting_readback", "connector_network_audit", "cleanup_effect_ids"]
  };
}

function benchmarkTaskId(kind: RedlineMepSizeTransitionKind): RedlineMepSizeTransitionPlan["benchmarkTaskId"] {
  return kind === "pipe" ? "demo_redline_mep_pipe_size_transition" : "demo_redline_mep_duct_size_transition";
}

function findRoute(
  action: RedlineMepSizeTransitionAction,
  context: RedlineMepSizeTransitionContext,
  kind: RedlineMepSizeTransitionKind
): { route?: RedlineMepSizeTransitionRoute; reason?: string } {
  const allRoutes = routes(context);
  const wantedId = elementId(action.hostElementId);
  if (wantedId !== null) {
    const found = allRoutes.find((route) => routeId(route) === wantedId && routeKind(route) === kind);
    return found ? { route: found } : { reason: `${kind} host element id not found in mock route inventory` };
  }

  const system = normalizedText(action.systemType).toLowerCase();
  const level = normalizedText(action.levelName).toLowerCase();
  const matches = allRoutes.filter((route) => {
    if (routeKind(route) !== kind) return false;
    const systemMatches = !system || routeSystem(route).toLowerCase() === system;
    const levelMatches = !level || routeLevel(route).toLowerCase() === level;
    return systemMatches && levelMatches;
  });
  if (matches.length === 1) return { route: matches[0] };
  if (matches.length > 1) return { reason: "ambiguous MEP route target: provide exact host element id" };
  return { reason: `${kind} route target not found in mock route inventory` };
}

export function validateRedlineMepSizeTransition(
  action: RedlineMepSizeTransitionAction,
  context: RedlineMepSizeTransitionContext
): RedlineMepSizeTransitionValidation {
  const reasons: string[] = [];
  const operation = normalizedText(action.operation || "size_transition");
  const kind = actionKind(action);
  const fallbackKind = kind ?? "pipe";
  const baseTaxonomy = taxonomy(fallbackKind);

  if (operation !== "size_transition") reasons.push(`unsupported operation '${operation || "<missing>"}'; expected size_transition`);
  if (!kind) reasons.push(`unsupported target '${normalizedText(action.target || action.kind) || "<missing>"}'; expected pipe or duct`);
  if (!normalizedText(action.upstreamSize)) reasons.push("missing upstream size");
  if (!normalizedText(action.downstreamSize)) reasons.push("missing downstream size");
  if (!point(action.transitionPoint) && !finiteNumber(action.transitionChainageFt)) reasons.push("missing transition location: provide transitionPoint or transitionChainageFt");
  if (reasons.length > 0 || !kind) return { status: "invalid_parameter", ok: false, reasons, taxonomy: baseTaxonomy, requiredLiveInputs: [] };

  const { route, reason } = findRoute(action, context, kind);
  if (!route) {
    return {
      status: "target_not_found",
      ok: false,
      reasons: [reason ?? "MEP route target not found"],
      taxonomy: taxonomy(kind),
      requiredLiveInputs: ["host element id", "route inventory"]
    };
  }

  const resolvedHostId = routeId(route);
  if (resolvedHostId === null) {
    return { status: "target_not_found", ok: false, reasons: ["MEP route target is missing a valid element id"], taxonomy: taxonomy(kind), requiredLiveInputs: ["host element id"] };
  }

  const connectors = route.connectors ?? [];
  const connectedConnectorCount = connectors.filter((connector) => connector.connected === true).length;
  if (connectors.length > 0 && connectedConnectorCount < connectors.length) {
    return {
      status: "needs_human_review",
      ok: false,
      reasons: ["connector network is not fully connected in mock route inventory"],
      taxonomy: taxonomy(kind),
      target: {
        hostElementId: resolvedHostId,
        kind,
        systemType: routeSystem(route) || undefined,
        levelName: routeLevel(route) || undefined,
        currentSize: normalizedText(route.size) || undefined,
        connectorCount: connectors.length,
        connectedConnectorCount
      },
      requiredLiveInputs: ["connector network audit"]
    };
  }

  return {
    status: "success",
    ok: true,
    reasons: [],
    taxonomy: taxonomy(kind),
    target: {
      hostElementId: resolvedHostId,
      kind,
      systemType: routeSystem(route) || normalizedText(action.systemType) || undefined,
      levelName: routeLevel(route) || normalizedText(action.levelName) || undefined,
      currentSize: normalizedText(route.size) || undefined,
      connectorCount: connectors.length,
      connectedConnectorCount
    },
    requiredLiveInputs: []
  };
}

export function planRedlineMepSizeTransitionDryRun(
  action: RedlineMepSizeTransitionAction,
  context: RedlineMepSizeTransitionContext
): RedlineMepSizeTransitionPlan {
  const validation = validateRedlineMepSizeTransition(action, context);
  const kind = validation.target?.kind ?? actionKind(action) ?? "pipe";
  const upstreamSize = normalizedText(action.upstreamSize);
  const downstreamSize = normalizedText(action.downstreamSize);
  const transitionPoint = point(action.transitionPoint);
  const request: Record<string, unknown> = {
    kind,
    operation: "size_transition",
    ...(elementId(action.viewId) ? { viewId: elementId(action.viewId) } : {}),
    ...(elementId(action.visualViewId ?? action.viewId) ? { visualViewId: elementId(action.visualViewId ?? action.viewId) } : {}),
    ...(validation.target?.hostElementId ? { hostElementId: validation.target.hostElementId } : {}),
    ...(validation.target?.levelName ? { levelName: validation.target.levelName } : {}),
    ...(validation.target?.systemType ? { systemType: validation.target.systemType } : {}),
    ...(kind === "pipe" ? { upstreamPipeSize: upstreamSize, downstreamPipeSize: downstreamSize } : { upstreamDuctSize: upstreamSize, downstreamDuctSize: downstreamSize }),
    ...(transitionPoint ? { transitionPoint } : {}),
    ...(finiteNumber(action.transitionChainageFt) ? { transitionChainageFt: action.transitionChainageFt } : {}),
    verify: true,
    dryRun: true,
    apply: false,
    mockOnly: true,
    visualVerify: false,
    cleanupCreatedElements: false,
    readbackRequired: true
  };

  return {
    status: validation.status,
    validation,
    endpoint: "/revit/reroute-mep-route-segment",
    benchmarkTaskId: benchmarkTaskId(kind),
    request,
    requiredContext: [
      "host pipe/duct element id or unique system/level route",
      "upstream and downstream sizes",
      "transition point or chainage",
      "connector network audit",
      "fitting/readback evidence",
      "cleanup plan before apply"
    ],
    requiredEvidence: validation.taxonomy.evidence_requirements
  };
}

export function executeRedlineMepSizeTransitionMock(
  action: RedlineMepSizeTransitionAction,
  context: RedlineMepSizeTransitionContext
): RedlineMepSizeTransitionExecution {
  const plan = planRedlineMepSizeTransitionDryRun(action, context);
  const validation = plan.validation;
  if (!validation.ok || !validation.target) {
    return {
      status: validation.status,
      validation,
      plan,
      executionSource: "mock",
      executionMode: "dry_run_simulation",
      liveBridgeCall: false,
      writeGrantRequired: false,
      mockOnly: true,
      mockApplied: false,
      message: validation.reasons.join("; ") || "MEP size transition validation failed"
    };
  }

  return {
    status: "success",
    validation,
    plan,
    executionSource: "mock",
    executionMode: "dry_run_simulation",
    liveBridgeCall: false,
    writeGrantRequired: false,
    mockOnly: true,
    mockApplied: false,
    projectionReadback: {
      kind: "projection_readback",
      transitionPoint: point(action.transitionPoint),
      transitionChainageFt: finiteNumber(action.transitionChainageFt) ? action.transitionChainageFt : undefined
    },
    sizeReadback: {
      kind: "size_readback",
      upstreamSize: normalizedText(action.upstreamSize),
      downstreamSize: normalizedText(action.downstreamSize)
    },
    connectorAudit: {
      kind: "connector_network_audit",
      connectorCount: validation.target.connectorCount,
      connectedConnectorCount: validation.target.connectedConnectorCount,
      connectedNetworkOk: validation.target.connectorCount === 0 || validation.target.connectorCount === validation.target.connectedConnectorCount
    },
    message: "Dry-run MEP size transition plan produced with mock projection, size, and connector readback. No model write was simulated."
  };
}

export function verifyRedlineMepSizeTransition(
  action: RedlineMepSizeTransitionAction,
  execution: RedlineMepSizeTransitionExecution,
  observed?: {
    upstreamSize?: string;
    downstreamSize?: string;
    connectedNetworkOk?: boolean;
  }
): RedlineMepSizeTransitionVerification {
  const checks: RedlineMepSizeTransitionVerification["checks"] = [];
  const expectedUpstream = normalizedText(action.upstreamSize);
  const expectedDownstream = normalizedText(action.downstreamSize);
  const actualUpstream = normalizedText(observed?.upstreamSize ?? execution.sizeReadback?.upstreamSize);
  const actualDownstream = normalizedText(observed?.downstreamSize ?? execution.sizeReadback?.downstreamSize);
  const connectedNetworkOk = observed?.connectedNetworkOk ?? execution.connectorAudit?.connectedNetworkOk;

  checks.push({
    name: "mep_size_transition_dry_run_projection_present",
    ok: Boolean(execution.projectionReadback?.transitionPoint || finiteNumber(execution.projectionReadback?.transitionChainageFt)),
    expected: "transition point or chainage",
    actual: execution.projectionReadback
  });
  checks.push({
    name: "mep_size_transition_dry_run_size_preview_matches",
    ok: Boolean(expectedUpstream && expectedDownstream) && actualUpstream === expectedUpstream && actualDownstream === expectedDownstream,
    expected: { upstreamSize: expectedUpstream, downstreamSize: expectedDownstream },
    actual: { upstreamSize: actualUpstream, downstreamSize: actualDownstream }
  });
  checks.push({
    name: "mep_size_transition_dry_run_connector_network_ok",
    ok: connectedNetworkOk === true,
    expected: true,
    actual: connectedNetworkOk
  });
  checks.push({
    name: "mep_size_transition_no_mock_model_write",
    ok: execution.mockApplied === false && execution.plan.request.apply === false,
    expected: { mockApplied: false, apply: false },
    actual: { mockApplied: execution.mockApplied, apply: execution.plan.request.apply }
  });

  const ok = execution.status === "success" && checks.every((check) => check.ok);
  return {
    status: ok ? "success" : "verification_failed",
    ok,
    checks
  };
}
