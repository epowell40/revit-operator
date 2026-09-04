const READ_ONLY_PATHS = new Set([
  "/revit/ping",
  "/revit/context",
  "/revit/activate-view",
  "/revit/state-snapshot",
  "/revit/computer-use-observe",
  "/revit/views",
  "/revit/capabilities",
  "/revit/tool-registry",
  "/revit/tool-search",
  "/revit/tool-doc",
  "/revit/tool-examples",
  "/revit/native-api-catalog",
  "/revit/native-api-search",
  "/revit/native-api-ops",
  "/revit/self-test",
  "/revit/regenerate",
  "/revit/rooms",
  "/revit/room-contents",
  "/revit/plan-dwelling-receptacles",
  "/revit/plan-room-receptacles-from-analog",
  "/revit/spatial-context",
  "/revit/linked-room-boundaries",
  "/revit/find-elements",
  "/revit/find-text-notes",
  "/revit/locate-elements",
  "/revit/resolve-mep-routing-context",
  "/revit/trace-connected-network",
  "/revit/find-elements-by-parameter",
  "/revit/find-duplicate-marks",
  "/revit/ducts-by-spatial-scope",
  "/revit/get-connectors",
  "/revit/get-placement-context",
  "/revit/model-health",
  "/revit/room_mep_intersect",
  "/revit/audit-hosted-instance-placement",
  "/revit/audit-electrical-circuit-loading",
  "/revit/audit-plumbing-fixture-services",
  "/revit/resolve-redline-target",
  "/revit/propose-fix",
  "/revit/resolve-room-wall",
  "/revit/rank-similar-devices-on-wall",
  "/revit/project-point-to-host-frame",
  "/revit/pick-candidate-cluster",
  "/revit/export-image",
  "/revit/capture-screenshare",
  "/revit/export-images",
  "/revit/export-view-frame",
  "/revit/export-view-region",
  "/revit/export-visible-elements",
  "/revit/highlight-and-export",
  "/revit/pick-at-pixel",
  "/revit/set-selection",
  "/revit/query",
  "/revit/resolve",
  "/revit/get-element-summary",
  "/revit/get-parameters",
  "/revit/quantify",
  "/revit/sheets",
  "/revit/schedules",
  "/revit/measure-gap",
  "/revit/get-lighting-data",
  "/revit/analyze-dimensions",
  "/revit/spatial-analysis",
  "/revit/fire-damper-audit",
  "/revit/lighting-audit",
  "/revit/query-zone-data",
  "/revit/list-element-types",
  "/revit/resolve-element-type",
  "/revit/resolve-room-plan-view",
  "/revit/get-titleblock-info",
  "/revit/titleblock-label-map",
  "/revit/titleblock-date-candidates",
  "/revit/verify-parameter-on-sheet",
  "/revit/capture-sheet-region",
  "/revit/get-family-file-path",
  "/revit/find-family-text-notes",
  "/revit/inspect-family-content",
  "/revit/warnings",
  "/revit/qa-checks",
  "/revit/print-sets",
  "/revit/revisions",
  "/revit/plan-family-evolution",
  "/revit/read-family-evolution"
]);

const REVIT_ACTION_PATH_ALIASES = Object.freeze({
  "/revit/list-views": "/revit/views",
  "/revit/query-views": "/revit/views",
  "/revit/list-sheets": "/revit/sheets",
  "/revit/list-schedules": "/revit/schedules",
  "/revit/query-elements": "/revit/query",
  "/revit/delete-elements": "/revit/delete",
  "/revit/set-parameters": "/revit/set-parameter"
});

const ARTIFACT_PUBLICATION_PATHS = new Set([
  "/revit/export-pdf",
  "/revit/export-dwg",
  "/revit/export-ifc",
  "/revit/export-elements-xlsx"
]);

export function canonicalRevitActionPath(pathname) {
  const normalized = String(pathname || "").trim().toLowerCase();
  return REVIT_ACTION_PATH_ALIASES[normalized] || normalized;
}

function bodyRecord(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) return body;
  if (typeof body !== "string" || !body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function genericConditionalIntentEffect(row) {
  const transaction = bodyRecord(row.transaction);
  const modeValue = typeof transaction.mode === "string" && transaction.mode.trim()
    ? transaction.mode
    : typeof row.mode === "string"
      ? row.mode
      : "";
  const mode = modeValue.trim().toLowerCase();
  const previewRequested = row.dryRun === true
    || row.dry_run === true
    || row.preview === true
    || ["rollback", "preview", "dry_run", "dry-run"].includes(mode);
  const applyRequested = row.apply === true
    || row.dryRun === false
    || row.dry_run === false
    || row.commit === true
    || row.execute === true
    || ["commit", "apply", "execute"].includes(mode);

  // Contradictory mode signals are not a preview authorization. The native
  // exposure layer still validates the handler-specific request contract, but
  // admission conservatively reserves apply authority when intent is unclear.
  if (applyRequested) return "apply";
  return previewRequested ? "preview" : undefined;
}

function explicitConditionalActionPathEffect(normalized, row) {
  if (normalized === "/revit/move-elements") {
    // A rollback-only move preview and a committed translation are distinct
    // policy effects. Preview certification must never authorize apply.
    if (genericConditionalIntentEffect(row) === "apply") return "apply";
    return row.dryRun === true ? "preview" : "apply";
  }
  if (ARTIFACT_PUBLICATION_PATHS.has(normalized)) {
    if (genericConditionalIntentEffect(row) === "apply") return "apply";
    const dryRun = normalized === "/revit/export-pdf"
      ? row.dryRun ?? row.preflightOnly ?? row.preflight ?? false
      : row.dryRun ?? false;
    return dryRun === true ? "preview" : "apply";
  }
  if (normalized === "/revit/print") {
    return genericConditionalIntentEffect(row) === "apply" ? "apply" : "preview";
  }
  if (normalized === "/revit/transaction-plan") return "preview";
  if (normalized === "/revit/visibility") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "get";
    if (action === "get") return "read";
    return genericConditionalIntentEffect(row) === "preview" ? "preview" : "apply";
  }
  if (normalized === "/revit/duplicate-sheet") {
    return genericConditionalIntentEffect(row) === "preview" ? "preview" : "apply";
  }
  if (normalized === "/revit/fire-damper-audit") {
    return typeof row.command === "string" && row.command.trim().toLowerCase() === "fix" ? "apply" : "read";
  }
  if (normalized === "/revit/lighting-audit") return row.fix === true || row.visualize === true ? "apply" : "read";
  if (normalized === "/revit/list-element-types") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "list";
    if (action !== "rename_types" && action !== "purge_unused_in_family") return "read";
    return row.dryRun === true ? "preview" : "apply";
  }
  if (normalized === "/revit/create-text") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "create";
    if (action === "list_types" || action === "inspect") return "read";
    return genericConditionalIntentEffect(row) === "preview" ? "preview" : "apply";
  }
  return undefined;
}

export function conditionalActionPathEffect(pathname, body) {
  const normalized = canonicalRevitActionPath(pathname);
  const row = bodyRecord(body);
  const explicit = explicitConditionalActionPathEffect(normalized, row);
  if (explicit !== undefined) return explicit;
  // Certified mutation handlers commonly expose the same conditional execution
  // fields. Interpret those fields after handler-specific branches so backend
  // admission and the independently packaged MCP classify the exact native
  // request identically. Incidental fields never widen a read-only route.
  if (!normalized.startsWith("/revit/") || READ_ONLY_PATHS.has(normalized)) return undefined;
  return genericConditionalIntentEffect(row);
}

export function pathLooksWrite(pathname, body, method = "POST") {
  const normalizedMethod = String(method || "POST").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return false;
  if (normalizedMethod !== "POST") return true;
  const normalized = canonicalRevitActionPath(pathname);
  const conditional = conditionalActionPathEffect(normalized, body);
  if (conditional !== undefined) return conditional !== "read";
  return normalized.startsWith("/revit/") && !READ_ONLY_PATHS.has(normalized);
}

export function revitRouteEffect(pathname, method, body) {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";
  if (normalizedMethod !== "POST") return "apply";
  const normalized = canonicalRevitActionPath(pathname);
  const conditional = conditionalActionPathEffect(normalized, body);
  if (conditional !== undefined) return conditional;
  return READ_ONLY_PATHS.has(normalized) ? "read" : "apply";
}

// Certification hashes describe the strongest reviewed execution surface for
// an exact request. Until a route has an explicit handler-specific rule above,
// a mutation-capable POST remains conservatively "apply" for certification
// even when generic OperationV2 admission recognizes its rollback intent.
export function revitRouteCertificationEffect(pathname, method, body) {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";
  if (normalizedMethod !== "POST") return "apply";
  const normalized = canonicalRevitActionPath(pathname);
  const explicit = explicitConditionalActionPathEffect(normalized, bodyRecord(body));
  if (explicit !== undefined) return explicit;
  return READ_ONLY_PATHS.has(normalized) ? "read" : "apply";
}

// Recovery without the authoritative request body is not equivalent to an
// actual empty body. Preserve unconditional reads and rollback-only routes,
// but treat any body-dependent route as apply until its exact plan is restored.
export function revitRouteEffectWhenBodyUnavailable(pathname, method) {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";
  if (normalizedMethod !== "POST") return "apply";
  const normalized = canonicalRevitActionPath(pathname);
  const explicit = explicitConditionalActionPathEffect(normalized, {});
  if (explicit === "preview") return "preview";
  if (explicit !== undefined) return "apply";
  return READ_ONLY_PATHS.has(normalized) ? "read" : "apply";
}
