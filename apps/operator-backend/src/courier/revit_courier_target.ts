export type RevitCourierTarget = {
  target_executor_id?: string;
  target_document_title?: string;
  target_document_path?: string;
};

function boundedContextString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  if (value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function declaredBoundedContextString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  label: string
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, key)) return undefined;
  const rawValue = record[key];
  if (typeof rawValue === "string" && /^ *$/.test(rawValue)) return undefined;
  const value = boundedContextString(rawValue, maxLength);
  if (!value) throw new Error(`Revit context integrity error: ${label} is malformed.`);
  return value;
}

export function revitCourierTargetFromContext(context: unknown): RevitCourierTarget {
  if (!context || typeof context !== "object" || Array.isArray(context)) return {};
  const rawContext = context as Record<string, unknown>;
  const ui = rawContext.ui && typeof rawContext.ui === "object" && !Array.isArray(rawContext.ui)
    ? rawContext.ui as Record<string, unknown>
    : {};
  const legacyDocument = ui.revit_document && typeof ui.revit_document === "object" && !Array.isArray(ui.revit_document)
    ? ui.revit_document as Record<string, unknown>
    : {};
  const revit = rawContext.revit && typeof rawContext.revit === "object" && !Array.isArray(rawContext.revit)
    ? rawContext.revit as Record<string, unknown>
    : {};
  const canonicalDocument = revit.document && typeof revit.document === "object" && !Array.isArray(revit.document)
    ? revit.document as Record<string, unknown>
    : {};
  const canonicalExecutor = declaredBoundedContextString(revit, "courier_executor_id", 200, "canonical courier executor");
  const legacyExecutor = declaredBoundedContextString(legacyDocument, "courier_executor_id", 200, "compatibility courier executor");
  const canonicalTitle = declaredBoundedContextString(canonicalDocument, "title", 512, "canonical document title");
  const legacyTitle = declaredBoundedContextString(legacyDocument, "title", 512, "compatibility document title");
  const canonicalPath = declaredBoundedContextString(canonicalDocument, "path", 2048, "canonical document path");
  const legacyPath = declaredBoundedContextString(legacyDocument, "path", 2048, "compatibility document path");
  if (canonicalExecutor && legacyExecutor && canonicalExecutor !== legacyExecutor) {
    throw new Error("Revit context integrity error: canonical and compatibility courier executors disagree.");
  }
  if (canonicalTitle && legacyTitle && canonicalTitle.toLowerCase() !== legacyTitle.toLowerCase()) {
    throw new Error("Revit context integrity error: canonical and compatibility document titles disagree.");
  }
  if (canonicalPath && legacyPath && canonicalPath.replace(/\\/g, "/").toLowerCase() !== legacyPath.replace(/\\/g, "/").toLowerCase()) {
    throw new Error("Revit context integrity error: canonical and compatibility document paths disagree.");
  }
  const executorId = canonicalExecutor || legacyExecutor;
  const targetExecutorId = executorId && /^[A-Za-z0-9._:-]+$/.test(executorId) ? executorId : undefined;
  if (executorId && !targetExecutorId) {
    throw new Error("Revit context integrity error: courier executor is malformed.");
  }
  if (!targetExecutorId) return {};
  const documentTitle = canonicalTitle || legacyTitle;
  const documentPath = canonicalPath || legacyPath;
  return {
    target_executor_id: targetExecutorId,
    ...(documentTitle ? { target_document_title: documentTitle } : {}),
    ...(documentPath ? { target_document_path: documentPath } : {})
  };
}
