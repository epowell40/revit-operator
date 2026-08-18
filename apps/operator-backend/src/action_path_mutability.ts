const READ_ONLY_PATHS = new Set<string>([
  "/revit/ping",
  "/revit/context",
  // Activating a view changes only transient Revit UI/navigation state. It does
  // not mutate authoritative model data and must remain usable during an
  // inspection or preview-only assignment.
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
  "/revit/export-pdf",
  "/revit/export-images",
  "/revit/export-dwg",
  "/revit/export-ifc",
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
  "/revit/warnings",
  "/revit/qa-checks",
  "/revit/print-sets",
  "/revit/revisions",
  "/revit/plan-family-evolution",
  "/revit/read-family-evolution"
]);

function bodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== "string" || !body.trim()) return {};
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export type ConditionalActionPathEffect = "read" | "preview" | "apply";

const ARTIFACT_PUBLICATION_PATHS = new Set([
  "/revit/export-pdf",
  "/revit/export-dwg",
  "/revit/export-ifc",
  "/revit/export-elements-xlsx"
]);

export function conditionalActionPathEffect(pathname: string, body?: unknown): ConditionalActionPathEffect | undefined {
  const normalized = (pathname || "").trim().toLowerCase();
  const row = bodyRecord(body);
  // These handlers are observational during an explicit preflight, but create
  // durable files otherwise. Keep their endpoint-specific defaults here rather
  // than relying on generic apply/preview flags that the handlers do not read.
  // Export PDF additionally supports the preflight/preflightOnly aliases.
  if (ARTIFACT_PUBLICATION_PATHS.has(normalized)) {
    const dryRun = normalized === "/revit/export-pdf"
      ? row.dryRun ?? row.preflightOnly ?? row.preflight ?? false
      : row.dryRun ?? false;
    return dryRun === true ? "preview" : "apply";
  }
  // Physical printing defaults to a non-executing printer preflight. Supplying
  // dryRun=false authorizes the external print side effect.
  if (normalized === "/revit/print") return row.dryRun === false ? "apply" : "preview";
  // This endpoint evaluates a plan inside a rollback-only transaction.
  if (normalized === "/revit/transaction-plan") return "preview";
  if (normalized === "/revit/visibility") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "get";
    if (action === "get") return "read";
    return row.dryRun === true || row.dry_run === true || row.preview === true || row.apply === false ? "preview" : "apply";
  }
  if (normalized === "/revit/duplicate-sheet") {
    return row.dryRun === true || row.dry_run === true || row.preview === true || row.apply === false ? "preview" : "apply";
  }
  if (normalized === "/revit/fire-damper-audit") {
    return typeof row.command === "string" && row.command.trim().toLowerCase() === "fix" ? "apply" : "read";
  }
  if (normalized === "/revit/lighting-audit") {
    return row.fix === true || row.visualize === true ? "apply" : "read";
  }
  if (normalized === "/revit/list-element-types") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "list";
    if (action !== "rename_types" && action !== "purge_unused_in_family") return "read";
    return row.dryRun === true ? "preview" : "apply";
  }
  return undefined;
}

export function pathLooksWrite(pathname: string, body?: unknown, method: string = "POST"): boolean {
  const normalizedMethod = String(method || "POST").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return false;
  if (normalizedMethod !== "POST") return true;

  const normalized = (pathname || "").trim().toLowerCase();
  const conditional = conditionalActionPathEffect(normalized, body);
  if (conditional !== undefined) return conditional !== "read";
  return normalized.startsWith("/revit/") && !READ_ONLY_PATHS.has(normalized);
}
