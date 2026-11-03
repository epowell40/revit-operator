/** Native /revit/visibility wire contract. Nested category, filter, scope-box
 * and request identifiers never identify the view whose properties were read. */
function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.length <= 1_000_000) {
    try { return record(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function viewId(value: unknown): string | null {
  const text = typeof value === "number" || typeof value === "string" ? String(value).trim() : "";
  return /^[1-9]\d*$/.test(text) && Number.isSafeInteger(Number(text)) ? text : null;
}

function nativePayload(value: unknown): Record<string, unknown> {
  const root = record(value);
  if (root.isError === true || root.success === false || root.ok === false || root.error) return {};
  // Legacy MCP transport has one JSON text block. V2 callers supply the
  // immutable observation payload directly. Never combine multiple blocks.
  if (!("view" in root) && !("status" in root) && Array.isArray(root.content) && root.content.length === 1) {
    const content = record(root.content[0]);
    if (content.type === "text" && typeof content.text === "string") return record(content.text);
  }
  return root;
}

function propertyToken(id: string, field: string, value: unknown): string | null {
  if (field === "scale") {
    return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1000
      ? `native_view_property:${id}:scale:${value}` : null;
  }
  const choices = field === "detailLevel" ? ["coarse", "medium", "fine"]
    : field === "discipline" ? ["architectural", "structural", "mechanical", "electrical", "plumbing", "coordination"] : [];
  const text = typeof value === "string" ? value.trim().toLowerCase() : "";
  return choices.includes(text) ? `native_view_property:${id}:${field}:${text}` : null;
}

function categoryLabel(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const label = value.trim();
  if (!label || label.length > 256) return null;
  // Native resolution trims and compares labels case-insensitively. Keep
  // non-ASCII spelling exact rather than guessing localized category names.
  return label.replace(/[A-Z]/g, letter => letter.toLowerCase());
}

function categorySelector(value: unknown): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const selector = value.trim();
  // Imported subcategories have positive native IDs but no BuiltInCategory.
  // Keep that explicit selector separate from display-name proof.
  const numericId = viewId(selector);
  if (numericId) return `id:${numericId}`;
  if (/^OST_[A-Za-z0-9_]+$/.test(selector)) return selector;
  if (/^OST_/i.test(selector)) return null;
  const label = categoryLabel(selector);
  return label ? `label:${JSON.stringify(label)}` : null;
}

function categoryDetail(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ['coarse','medium','fine','undefined'].includes(text) ? text : null;
}

export function isVisibilityPhasingEditV2(value: unknown): boolean {
  const r=record(value),b=record(r.body??r.arguments??value);
  return ['set_phase','set_phase_filter'].includes(String(b.action??'').trim().toLowerCase());
}

export function isVisibilityTemplateEditV2(value: unknown): boolean {
  const r=record(value),b=record(r.body??r.arguments??value);
  return String(b.action??'').trim().toLowerCase()==='set_template';
}

function templateRequest(value: unknown): readonly string[] {
  const r=record(value),b=record(r.body??r.arguments??value),id=viewId(b.viewId);
  if(!isVisibilityTemplateEditV2(value)||!id||b.dryRun===true||r.path!==undefined&&r.path!=='/revit/visibility'
    ||r.method!==undefined&&r.method!=='POST'
    ||Object.keys(b).some(k=>!['viewId','action','dryRun','templateName'].includes(k))
    ||typeof b.templateName!=='string'||/[\u0000-\u001f\u007f]/.test(b.templateName))return [];
  if(b.templateName.trim()==='')return [`native_view_template:${id}:none:true`];
  const name=categoryLabel(b.templateName);
  return name?[`native_view_template:${id}:name:${JSON.stringify(name)}`]:[];
}

/** Requested assignment only, not template creation, contents or appearance.
 * The existing native setter selects by name. A separate get must report that
 * name AND a real template ID on the sole affected, non-template view. */
export function visibilityTemplateReadbackMatchesV2(input: unknown,payload: unknown,read: unknown,affected: readonly string[]): boolean {
  const expected=templateRequest(input);if(!expected.length)return false;
  const r=record(read),b=record(r.body??r.arguments??read),a=record(input),wanted=record(a.body??a.arguments??input),id=viewId(wanted.viewId);
  if(r.path!=='/revit/visibility'||r.method!=='POST'||b.action!=='get'||viewId(b.viewId)!==id||b.dryRun===true
    ||['linkedModelInstanceId','linkedModelId','revitLinkInstanceId','linkedModelName','revitLinkName','linkName'].some(k=>b[k]!=null)
    ||affected.length!==1||affected[0]!==`element_id:${id}`)return false;
  const observed=new Set(visibilityObservedValuesV2(payload));
  return expected.every(token=>observed.has(token));
}

function phaseRequest(value: unknown): readonly string[] {
  const r=record(value),b=record(r.body??r.arguments??value),id=viewId(b.viewId);
  const action=String(b.action??'').trim().toLowerCase();
  const field=action==='set_phase'?'phase':action==='set_phase_filter'?'phaseFilter':null;
  if(!id||!field||b.dryRun===true||r.path!==undefined&&r.path!=='/revit/visibility'
    ||Object.keys(b).some(k=>!['viewId','action','dryRun',field+'Id',field+'Name'].includes(k)))return [];
  const out:string[]=[];
  if(Object.hasOwn(b,field+'Id')){
    const selected=b[field+'Id'];if(typeof selected!=='number'||!viewId(selected))return [];
    out.push(`native_view_phasing:${id}:${field}:id:${selected}`);
  }
  if(Object.hasOwn(b,field+'Name')){
    const selected=categoryLabel(b[field+'Name']);if(!selected)return [];
    out.push(`native_view_phasing:${id}:${field}:name:${JSON.stringify(selected)}`);
  }
  return out;
}

/** Assignment identity only. Filter status rules and complete schedule member
 * scope are separate predicates; neither follows from a phase-filter ID. */
export function visibilityPhasingReadbackMatchesV2(input: unknown,payload: unknown,read?: unknown): boolean {
  const expected=phaseRequest(input);if(!expected.length)return false;
  if(read!==undefined){
    const r=record(read),b=record(r.body??r.arguments??read),a=record(input),wanted=record(a.body??a.arguments??input);
    if(r.path!=='/revit/visibility'||r.method!=='POST'||b.action!=='get'||viewId(b.viewId)!==viewId(wanted.viewId))return false;
  }
  const observed=new Set(visibilityObservedValuesV2(payload));
  return expected.every(token=>observed.has(token));
}

export function visibilityExpectedValuesV2(value: unknown): readonly string[] {
  const root = record(value);
  const body = record(root.body ?? root.arguments ?? value);
  const id = viewId(body.viewId);
  if(isVisibilityPhasingEditV2(value))return phaseRequest(value);
  if(isVisibilityTemplateEditV2(value))return templateRequest(value);
  if (body.action === "set_category_override") {
    // Both selectors accepted by the native handler must be checkable. A
    // display label is matched to native returned identity, never translated
    // through an English label-to-enum table or an echoed request.
    const selector = categorySelector(body.categoryName);
    if (!id || body.dryRun === true || body.apply === false || !selector
      || ["linkedModelInstanceId", "linkedModelId", "revitLinkInstanceId", "linkedModelName", "revitLinkName", "linkName"].some(k => body[k] != null)) return [];
    const prefix = `native_category_property:${id}:${selector}:`;
    const tokens: string[] = [];
    if (Object.hasOwn(body, "detailLevel")) {
      const detail = categoryDetail(body.detailLevel);
      if (!detail) return [];
      tokens.push(prefix + `detailLevel:${detail}`);
    }
    if (Object.hasOwn(body, "halftone")) {
      if (typeof body.halftone !== "boolean") return [];
      tokens.push(prefix + `halftone:${body.halftone}`);
    }
    if (Object.hasOwn(body, "lineWeight")) {
      if (!Number.isInteger(body.lineWeight) || Number(body.lineWeight) < 1 || Number(body.lineWeight) > 16) return [];
      tokens.push(prefix + `lineWeight:${body.lineWeight}`);
    }
    if (["r", "g", "b"].some(k => Object.hasOwn(body, k))) {
      if (!["r", "g", "b"].every(k => Number.isInteger(body[k]) && Number(body[k]) >= 0 && Number(body[k]) <= 255)) return [];
      tokens.push(prefix + `color:${body.r},${body.g},${body.b}`);
    }
    return tokens;
  }
  const field = ({ set_scale: "scale", set_detail_level: "detailLevel", set_discipline: "discipline" } as Record<string, string>)[String(body.action ?? "").trim().toLowerCase()];
  if (!id || !field || body.dryRun === true) return [];
  const token = propertyToken(id, field, body[field]);
  return token ? [token] : [];
}

export function visibilityObservedValuesV2(value: unknown): readonly string[] {
  const root = nativePayload(value);
  // Only a successful independent native get can prove the desired state.
  // Do not recursively search wrappers: echoed inputs and conflicting copies
  // of a view projection cannot supplement the actual returned view.
  if (root.status !== "Ok" || root.action !== "get"
      || root.dryRun !== false || root.success === false || root.ok === false || root.error || root.truncated === true) return [];
  const view = record(root.view);
  const id = viewId(view.id);
  if (!id) return [];
  const values = ["scale", "detailLevel", "discipline"].flatMap(field => {
    const token = propertyToken(id, field, view[field]);
    return token ? [token] : [];
  });
  if(view.isTemplate===false){
    const templateName=categoryLabel(view.viewTemplate);
    if(typeof view.viewTemplateId==='number'&&viewId(view.viewTemplateId)&&String(view.viewTemplateId)!==id&&templateName)
      values.push(`native_view_template:${id}:name:${JSON.stringify(templateName)}`);
    else if(view.viewTemplateId===-1&&view.viewTemplate===null)
      values.push(`native_view_template:${id}:none:true`);
  }
  for(const field of ['phase','phaseFilter']){
    const native=record(view[field]),nativeId=viewId(native.id),name=categoryLabel(native.name);
    if(typeof native.id==='number'&&nativeId&&name){
      values.push(`native_view_phasing:${id}:${field}:id:${nativeId}`);
      values.push(`native_view_phasing:${id}:${field}:name:${JSON.stringify(name)}`);
    }
  }
  const category = record(view.categoryOverride);
  const snapshot = record(view.categorySnapshot), target = record(snapshot.target);
  const label = categoryLabel(category.categoryName);
  const resolvedIdentity = label && snapshot.complete === true
    && snapshot.targetCategoryId === category.categoryId && target.id === category.categoryId
    && categoryLabel(target.name) === label;
  const selectors: string[] = [];
  if (/^OST_[A-Za-z0-9_]+$/.test(String(category.builtInCategory ?? ""))
    && Number.isSafeInteger(category.categoryId) && Number(category.categoryId) < 0) {
    selectors.push(String(category.builtInCategory));
    // Display-label proof requires the separate native category snapshot's
    // resolved target, not a free-standing name beside a graphics value.
    if (resolvedIdentity)
      selectors.push(`label:${JSON.stringify(label)}`);
  }
  // A positive ID is proved only by the independent native snapshot resolving
  // the same typed ID and name. A label, request echo, or partial snapshot
  // cannot establish it; imported display-name ambiguity remains unsupported.
  if (Number.isSafeInteger(category.categoryId) && Number(category.categoryId) > 0
      && category.builtInCategory == null && resolvedIdentity)
    selectors.push(`id:${category.categoryId}`);
    for (const selector of selectors) {
      const prefix = `native_category_property:${id}:${selector}:`;
      const detail = categoryDetail(category.detailLevel);
      // The separate complete native snapshot must corroborate the same category
      // override. Whole-view detail or request echoes cannot fill this field.
      if (resolvedIdentity && detail && categoryDetail(record(target.graphics).detailLevel) === detail)
        values.push(prefix + `detailLevel:${detail}`);
      if (typeof category.halftone === "boolean") values.push(prefix + `halftone:${category.halftone}`);
      if (Number.isInteger(category.lineWeight) && Number(category.lineWeight) >= 1 && Number(category.lineWeight) <= 16)
        values.push(prefix + `lineWeight:${category.lineWeight}`);
      const color = record(category.color);
      if (["r", "g", "b"].every(k => Number.isInteger(color[k]) && Number(color[k]) >= 0 && Number(color[k]) <= 255))
        values.push(prefix + `color:${color.r},${color.g},${color.b}`);
    }
  return values;
}

export function visibilityTargetTokensV2(value: unknown): readonly string[] {
  const root = nativePayload(value);
  // A returned view is authoritative over request selectors on that payload.
  const isResult = "view" in root || "status" in root || "success" in root;
  const input = record(root.body ?? root.arguments ?? value);
  const id = viewId(isResult ? record(root.view).id : input.viewId);
  return id ? [`id:${id}`, `viewid:${id}`] : [];
}
