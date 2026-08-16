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
  "/revit/rooms",
  "/revit/room-contents",
  "/revit/spatial-context",
  "/revit/linked-room-boundaries",
  "/revit/find-elements",
  "/revit/find-text-notes",
  "/revit/locate-elements",
  "/revit/resolve-mep-routing-context",
  "/revit/trace-connected-network",
  "/revit/find-elements-by-parameter",
  "/revit/ducts-by-spatial-scope",
  "/revit/get-connectors",
  "/revit/resolve-room-wall",
  "/revit/rank-similar-devices-on-wall",
  "/revit/project-point-to-host-frame",
  "/revit/pick-candidate-cluster",
  "/revit/export-image",
  "/revit/export-pdf",
  "/revit/export-images",
  "/revit/export-dwg",
  "/revit/export-ifc",
  "/revit/export-view-frame",
  "/revit/export-view-region",
  "/revit/export-visible-elements",
  "/revit/highlight-and-export",
  "/revit/pick-at-pixel",
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

export function conditionalActionPathEffect(pathname: string, body?: unknown): ConditionalActionPathEffect | undefined {
  const normalized = (pathname || "").trim().toLowerCase();
  const row = bodyRecord(body);
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
