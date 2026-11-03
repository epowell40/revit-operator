import nodePath from 'node:path';

/** A registered open family document is preparation, not a saved model edit. */
export function familySessionOpenedV1(path: string, input: unknown, payload: unknown): boolean {
  const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
  const body = row(input), result = row(payload), receipt = row(result.family_session_receipt);
  if (!["/revit/open-family-doc", "/revit/edit-family-from-instance"].includes(path) || result.ok !== true
    || receipt.schema !== "revit-operator.family-session-open.v1" || receipt.status !== "opened"
    || !/^[a-f0-9]{32}$/.test(receipt.session_id ?? "") || result.familyDocumentId !== receipt.session_id
    || receipt.document_valid !== true || receipt.session_registered !== true
    || receipt.model_write_performed !== false || receipt.file_write_performed !== false) return false;
  const instance = body.titleblockInstanceId ?? body.elementId;
  if (instance !== undefined) return receipt.source_kind === "instance" && Number.isSafeInteger(instance) && instance > 0 && receipt.source_id === String(instance);
  if (path !== "/revit/open-family-doc") return false;
  if (typeof body.filePath === "string" && body.filePath.trim()) return receipt.source_kind === "file" && receipt.source_id === body.filePath.trim();
  return receipt.source_kind === "family" && Number.isSafeInteger(body.familyId) && body.familyId > 0 && receipt.source_id === String(body.familyId);
}

/** Confirms the load operation only; it does not certify design intent or file saving. */
export function familySessionReloadedV1(path: string, input: unknown, payload: unknown): boolean {
  const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
  const body = row(input), result = row(payload), receipt = row(result.family_reload_receipt);
  const session = body.docId ?? body.familyDocumentId;
  return ["/revit/load-family-doc", "/revit/reload-family-edit-session"].includes(path)
    && typeof session === "string" && /^[a-f0-9]{32}$/.test(session.trim())
    && result.ok === true && result.familyDocumentId === session.trim()
    && receipt.schema === "revit-operator.family-reload.v1" && receipt.status === "loaded"
    && receipt.session_id === session.trim() && receipt.native_load_returned === true
    && receipt.project_readback_verified === true && Number.isSafeInteger(receipt.family_id)
    && receipt.family_id > 0 && receipt.family_id === result.loadedFamilyId
    && typeof receipt.family_unique_id === "string" && receipt.family_unique_id.trim().length > 0;
}

export function familySessionSavedV1(path: string, input: unknown, payload: unknown): boolean {
  const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
  const body = row(input), result = row(payload), r = row(result.family_save_receipt);
  const session = body.docId ?? body.familyDocumentId;
  const canonical = (v: string) => v.replace(/\\/g, "/").toLowerCase();
  if (path !== "/revit/save-family-doc" || typeof session !== "string" || !/^[a-f0-9]{32}$/.test(session.trim())
    || result.ok !== true || result.saved !== true || result.familyDocumentId !== session.trim()
    || r.schema !== "revit-operator.family-save.v1" || r.status !== "saved" || r.session_id !== session.trim()
    || r.native_save_returned !== true || r.document_path_verified !== true || r.stable_read !== true
    || !Number.isSafeInteger(r.size_bytes) || r.size_bytes <= 0 || !/^[a-f0-9]{64}$/.test(r.sha256 ?? "")
    || typeof r.path !== "string" || !/^(?:[a-z]:[\\/]|\\\\)/i.test(r.path) || !/\.rfa$/i.test(r.path)
    || r.path !== result.filePath) return false;
  // An explicit relative path needs resolver evidence; never infer it from a basename.
  if (body.filePath === undefined || body.filePath === "") return true;
  if (typeof body.filePath !== "string" || body.filePath.length > 2000 || /[\u0000-\u001f]/.test(body.filePath)) return false;
  const requested = body.filePath.trim();
  if (nodePath.win32.isAbsolute(requested)) return canonical(requested) === canonical(r.path);
  const resolution = row(r.path_resolution);
  if (resolution.schema !== "revit-operator.workspace-path-resolution.v1" || resolution.requested_path !== requested
    || typeof resolution.workspace_root !== "string" || !nodePath.win32.isAbsolute(resolution.workspace_root)
    || resolution.workspace_root.length > 2000 || /[\u0000-\u001f]/.test(resolution.workspace_root)
    || resolution.resolved_path !== r.path || resolution.inside_workspace !== true) return false;
  const root = nodePath.win32.resolve(resolution.workspace_root), resolved = nodePath.win32.resolve(root, requested);
  const relative = nodePath.win32.relative(root, resolved);
  return relative.length > 0 && relative !== ".." && !relative.startsWith("..\\") && !nodePath.win32.isAbsolute(relative)
    && canonical(resolved) === canonical(nodePath.win32.normalize(r.path));
}

/** Closing an exact registered temporary family is lifecycle completion, not a project edit. */
export function familySessionClosedV1(path: string, input: unknown, payload: unknown): boolean {
  const row = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
  const body = row(input), result = row(payload), r = row(result.family_close_receipt);
  const session = body.docId ?? body.familyDocumentId;
  if (path !== "/revit/close-doc" || typeof session !== "string" || !/^[a-f0-9]{32}$/.test(session.trim())
    || result.ok !== true || result.closed !== true || result.familyDocumentId !== session.trim()
    || r.schema !== "revit-operator.family-session-close.v1" || r.status !== "closed" || r.session_id !== session.trim()
    || r.native_close_returned !== true || r.document_closed !== true || r.session_unregistered !== true
    || r.save_requested !== (body.saveChanges === true)) return false;
  return body.saveChanges === true
    ? familySessionSavedV1("/revit/save-family-doc", {docId:session}, payload)
    : result.saved === false;
}
