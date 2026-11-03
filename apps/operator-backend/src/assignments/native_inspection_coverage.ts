/** Native read coverage only. These checks never certify engineering, visual
 * appearance, preservation comparisons, or the meaning of a checklist item. */
const positive = (v: any): v is number => Number.isSafeInteger(v) && v > 0;
const text = (v: any) => typeof v === "string" && v.trim().length > 0;
const unique = (values: any[]) => new Set(values).size === values.length;
const nonnegative = (v: any) => Number.isSafeInteger(v) && v >= 0;
const finite = (v: any) => typeof v === "number" && Number.isFinite(v);

export const WORK_PLAN_INSPECTION_PATHS = [
  "/revit/get-connectors", "/revit/view-owned-detailing",
  "/revit/get-element-summary", "/revit/find-text-notes", "/revit/inspect-family-content", "/revit/inspect-exported-files", "/revit/get-parameters"
] as const;

export const WORK_PLAN_INSPECTION_GUIDANCE = "Cite fresh complete native reads after the latest edit, including SaveAs: get-element-summary for exact element identity/type/tag-reference coverage, find-text-notes with exact elementIds and a complete active-project identity/type/owner cohort for text notes (search prefixes do not count), get-parameters with exact target elementIds and preservationScheduleIds from the native parameter commit for unchanged collateral schedules (a target-only read does not prove preservation), inspect-family-content for an unfiltered loaded-family inspection, get-connectors for connectivity, paired view-owned-detailing verification of duplicate-view withDetailing, or the accepted inspect-exported-files verification operation paired with the saved/exported artifact. File proof covers only its exact artifact paths, never model elements or drawing completeness. An ordinary view-owned-detailing inventory cannot close another kind of inspection. Use the supported scoped reads instead; do not repeat completed edits or ask the user to resolve a tool-contract problem. Inspection coverage does not certify engineering or visual appearance.";

function requestBody(input: any): any {
  try { return typeof input?.body === "string" ? JSON.parse(input.body) : input?.body; }
  catch { return null; }
}

function completeTagReferences(body: any, row: any): boolean {
  const r = row.tagReferences;
  if (body.includeTagReferences !== true || r?.schema !== "operator.tag_references.v1" || r.applicable !== true
      || r.complete !== true || r.enumerationFailed !== false || r.truncated !== false
      || r.unresolvedReferences !== 0 || r.orphaned !== false || !Array.isArray(r.errors) || r.errors.length
      || !Array.isArray(r.items) || !r.items.length || r.returned !== r.items.length || r.totalReferences !== r.items.length
      || !unique(r.items.map((i: any) => i?.identityKey))
      || !positive(r.ownerView?.elementId) || !text(r.ownerView?.uniqueId)) return false;
  const location = row.location;
  if (location?.type !== "tagHead" || ![location.x, location.y, location.z].every(finite)
      || location.ownerViewId !== r.ownerView.elementId || location.ownerViewUniqueId !== r.ownerView.uniqueId) return false;
  return r.items.every((i: any) => text(i?.identityKey) && i.resolved === true && positive(i.elementId) && text(i.uniqueId)
    && (i.documentScope === "host" && i.linkInstanceId == null && i.identityKey === `host:${i.elementId}`
      || i.documentScope === "linked" && positive(i.linkInstanceId) && i.identityKey === `link:${i.linkInstanceId}:${i.elementId}`));
}

/** Return only project IDs explicitly requested and completely returned. Child
 * family label/type IDs and incidental tagged subjects never widen coverage. */
export function nativeInspectionTargetIdsV2(input: any, data: any): number[] | null {
  const body = requestBody(input);
  if (input?.method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)) return null;
  if (input.path === "/revit/find-text-notes") {
    const ids=body.elementIds,rows=data?.items;
    const sameIds=(other:any)=>Array.isArray(other)&&other.length===ids.length&&other.every(positive)&&unique(other)&&other.every(id=>ids.includes(id));
    if(!Array.isArray(ids)||!ids.length||ids.length>500||!ids.every(positive)||!unique(ids)
      ||body.elementId!=null||body.ids!=null||body.docId!=null||body.familyDocumentId!=null
      ||data?.ok!==true||data.error!=null||data.scope!=="active_project"||data.docId!=null||data.familyDocumentId!=null
      ||data.itemsComplete!==true||data.exactElementFilterApplied!==true||!sameIds(data.requestedElementIds)||!sameIds(data.elementIds)
      ||!Array.isArray(rows)||rows.length!==ids.length||!unique(rows.map(r=>r?.elementId))||!unique(rows.map(r=>r?.uniqueId)))return null;
    if(rows.some(r=>r?.error!=null||!positive(r?.elementId)||r.textNoteId!==r.elementId||!ids.includes(r.elementId)||!text(r.uniqueId)
      ||!positive(r.textTypeId)||!text(r.textTypeUniqueId)||!positive(r.ownerViewId)||!text(r.ownerViewUniqueId)
      ||typeof r.text!=="string"||![r.location?.x,r.location?.y,r.location?.z].every(finite)
      ||body.viewId!=null&&r.ownerViewId!==body.viewId))return null;
    return [...ids].sort((a,b)=>a-b);
  }
  if (input.path === "/revit/get-element-summary") {
    const ids = body.elementIds ?? body.ids, rows = data?.result;
    if (body.includeElectricalCircuitMembership === true
        || !Array.isArray(ids) || !ids.length || ids.length > 500 || !ids.every(positive) || !unique(ids)
        || body.elementIds != null && body.ids != null && JSON.stringify(body.elementIds) !== JSON.stringify(body.ids)
        || !Array.isArray(rows) || rows.length !== ids.length || !unique(rows.map(r => r?.id))
        || !unique(rows.map(r => r?.uniqueId))) return null;
    for (const row of rows) {
      if (!positive(row?.id) || !ids.includes(row.id) || row.found !== true || !text(row.uniqueId) || !text(row.className)
          || row.error != null || row.typeId != null && !positive(row.typeId)) return null;
      if (row.className === "IndependentTag" && !completeTagReferences(body, row)) return null;
      // An explicitly requested reference read cannot silently omit applicability.
      if (body.includeTagReferences === true && row.tagReferences?.applicable !== false
          && !completeTagReferences(body, row)) return null;
    }
    return [...ids].sort((a, b) => a - b);
  }
  if (input.path !== "/revit/inspect-family-content") return null;
  const s = data?.source, inv = data?.inventory;
  // Workspace RFA facts never establish the family currently loaded in this project.
  if (Object.hasOwn(body, "filePath") || s?.scope === "external_file") return null;
  if (!positive(body.elementId) || !s || s.elementId !== body.elementId || !text(s.uniqueId)
      || !positive(s.familyId) || !positive(s.typeId) || !text(s.familyName)
      || data.ok !== true || data.observational !== true || data.mutated !== false || data.closedWithoutSaving !== true
      || data.query !== null || body.contains != null && body.contains !== ""
      || !inv || inv.truncated !== false || !positive(inv.scannedElementCount) || !nonnegative(inv.returnedElementCount)
      || inv.returnedElementCount > inv.scannedElementCount || !positive(inv.maxElements) || inv.maxElements > 2000
      || inv.returnedElementCount >= inv.maxElements) return null;
  const arrays = [data.staticText, data.labels, data.nestedInstances, data.otherElements];
  if (!arrays.every(Array.isArray)) return null;
  const rows = arrays.flat();
  if (rows.length !== inv.returnedElementCount || !unique(rows.map(r => r?.elementId))
      || !unique(rows.map(r => r?.uniqueId)) || rows.some(r => !positive(r?.elementId) || !text(r?.uniqueId) || r.error != null)) return null;
  if (data.staticText.some((r: any) => typeof r.text !== "string")) return null;
  if (data.labels.some((r: any) => {
    const t = r.labelType;
    return !t || !positive(t.elementId) || !text(t.uniqueId) || !text(t.font)
      || !finite(t.textSizeFeet) || t.textSizeFeet <= 0 || !finite(t.widthFactor) || t.widthFactor <= 0
      || [t.bold, t.italic, t.underline].some(v => typeof v !== "boolean");
  })) return null;
  return [s.elementId];
}
