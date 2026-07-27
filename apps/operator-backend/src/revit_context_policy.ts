function contextObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function hasRevitTurnContext(contextValue: unknown): boolean {
  const context = contextObject(contextValue);
  const revit = contextObject(context.revit);
  const ui = contextObject(context.ui);
  const compatibilityDocument = contextObject(ui.revit_document);
  return Object.keys(revit).length > 0 || Object.keys(compatibilityDocument).length > 0;
}

export function mayInjectUnscopedLegacyMemory(contextValue: unknown): boolean {
  return !hasRevitTurnContext(contextValue);
}
