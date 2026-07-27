function contextObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function hasRevitTurnContext(contextValue: unknown): boolean {
  const context = contextObject(contextValue);
  const ui = contextObject(context.ui);
  return Object.prototype.hasOwnProperty.call(context, "revit")
    || Object.prototype.hasOwnProperty.call(ui, "revit_document");
}

export function mayInjectUnscopedLegacyMemory(contextValue: unknown): boolean {
  return !hasRevitTurnContext(contextValue);
}
