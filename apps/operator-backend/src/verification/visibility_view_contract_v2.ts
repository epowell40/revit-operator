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

export function visibilityExpectedValuesV2(value: unknown): readonly string[] {
  const root = record(value);
  const body = record(root.body ?? root.arguments ?? value);
  const id = viewId(body.viewId);
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
      || root.dryRun !== false || root.success === false || root.ok === false || root.error) return [];
  const view = record(root.view);
  const id = viewId(view.id);
  if (!id) return [];
  return ["scale", "detailLevel", "discipline"].flatMap(field => {
    const token = propertyToken(id, field, view[field]);
    return token ? [token] : [];
  });
}

export function visibilityTargetTokensV2(value: unknown): readonly string[] {
  const root = nativePayload(value);
  // A returned view is authoritative over request selectors on that payload.
  const isResult = "view" in root || "status" in root || "success" in root;
  const input = record(root.body ?? root.arguments ?? value);
  const id = viewId(isResult ? record(root.view).id : input.viewId);
  return id ? [`id:${id}`, `viewid:${id}`] : [];
}
