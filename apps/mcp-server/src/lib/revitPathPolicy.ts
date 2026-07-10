export function assertRevitBridgePath(path: unknown): asserts path is string {
  if (typeof path !== "string" || !path.trim().startsWith("/revit/")) {
    throw new Error("path must start with /revit/.");
  }
}
