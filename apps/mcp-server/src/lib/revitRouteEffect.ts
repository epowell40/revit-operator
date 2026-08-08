export type RevitRouteEffect = "read" | "preview" | "apply";

// The MCP server is packaged independently from operator-backend, so it cannot
// import the sibling app's source at runtime. Keep this route metadata aligned
// with apps/operator-backend/src/action_path_mutability.ts; consumers in this
// package must use revitRouteEffect instead of maintaining their own lists.
const READ_ONLY_POST_PATHS = new Set<string>([
  "/revit/ping",
  "/revit/context",
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
  "/revit/self-test",
  "/revit/rooms",
  "/revit/room-contents",
  "/revit/linked-room-boundaries",
  "/revit/find-elements",
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
  "/revit/query",
  "/revit/resolve",
  "/revit/get-element-summary",
  "/revit/get-parameters",
  "/revit/quantify",
  "/revit/sheets",
  "/revit/measure-gap",
  "/revit/get-lighting-data",
  "/revit/analyze-dimensions",
  "/revit/spatial-analysis",
  "/revit/fire-damper-audit",
  "/revit/lighting-audit",
  "/revit/query-zone-data",
  "/revit/list-element-types",
  "/revit/resolve-element-type",
  "/revit/titleblock-label-map",
  "/revit/titleblock-date-candidates",
  "/revit/verify-parameter-on-sheet",
  "/revit/capture-sheet-region",
  "/revit/certified/sheets/count",
]);

function bodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  if (typeof body !== "string" || !body.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function conditionalPostEffect(path: string, body: unknown): RevitRouteEffect | undefined {
  const row = bodyRecord(body);
  if (path === "/revit/move-elements") {
    // A rolled-back native transaction and a committed translation are two
    // distinct policy effects. Preview certification never authorizes apply.
    return row.dryRun === true ? "preview" : "apply";
  }
  if (path === "/revit/fire-damper-audit") {
    return typeof row.command === "string" && row.command.trim().toLowerCase() === "fix" ? "apply" : "read";
  }
  if (path === "/revit/lighting-audit") {
    return row.fix === true || row.visualize === true ? "apply" : "read";
  }
  if (path === "/revit/list-element-types") {
    const action = typeof row.action === "string" ? row.action.trim().toLowerCase() : "list";
    if (action !== "rename_types" && action !== "purge_unused_in_family") return "read";
    return row.dryRun === true ? "preview" : "apply";
  }
  return undefined;
}

export function revitRouteEffect(pathname: string, method: string, body?: unknown): RevitRouteEffect {
  const normalizedMethod = String(method || "GET").trim().toUpperCase();
  if (normalizedMethod === "GET" || normalizedMethod === "HEAD" || normalizedMethod === "OPTIONS") return "read";

  // Any unfamiliar non-read method is apply-capable unless route metadata
  // proves otherwise. This is deliberately fail-closed for new endpoints.
  if (normalizedMethod !== "POST") return "apply";

  const normalizedPath = String(pathname || "").trim().toLowerCase();
  const conditional = conditionalPostEffect(normalizedPath, body);
  if (conditional !== undefined) return conditional;
  if (normalizedPath === "/revit/transaction-plan") return "preview";
  if (READ_ONLY_POST_PATHS.has(normalizedPath)) return "read";
  return "apply";
}
