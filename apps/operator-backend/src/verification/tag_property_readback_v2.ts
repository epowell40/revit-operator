/** Strict property readback for existing IndependentTag edits. Native authority,
 * binding, digest and freshness remain mandatory Assignment Kernel fences. */
const GET_ELEMENT = 'method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const object = (v: unknown): Record<string, any> | null => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, any> : null;
const positive = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) > 0;
const propertyNames = new Set(['OwnerViewId', 'HasLeader', 'TagHeadPosition', 'LeaderEndCondition']);

/** Match the native handler's supported enum parsing, without accepting other values. */
export function tagLeaderEndConditionV2(value: unknown): 'attached' | 'free' | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'attached' || normalized === 'free' ? normalized : null;
}
type NativeItem = { element_id: number; unique_id: string; properties: Record<string, any>; native_types: Record<string, string> };

function structured(v: unknown): unknown {
  if (typeof v !== 'string' || v.length > 1_000_000) return v;
  try { return JSON.parse(v); } catch { return v; }
}

export function existingTagRepairRequestV2(input: unknown): Record<string, any> | null {
  const root = object(input), body = object(structured(root?.body ?? input));
  return body && positive(body.repairExistingTagId) ? body : null;
}

function propertyReadRequest(input: unknown): { operations: Record<string, any>[]; ids: number[] } | null {
  const root = object(input), body = object(structured(root?.body ?? input));
  if (!body || !Array.isArray(body.operations) || body.operations.length < 2 || body.operations.length > 16) return null;
  const handles = new Set<string>(), ids = new Set<number>(), seen = new Set<string>();
  let properties = 0;
  for (const value of body.operations) {
    const request = object(value);
    if (!request || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(request.id) || seen.has(request.id)) return null;
    seen.add(request.id);
    if (request.op === 'call') {
      if (request.target !== 'doc' || request.memberId !== GET_ELEMENT || !Array.isArray(request.args)
        || request.args.length !== 1 || !positive(request.args[0])) return null;
      ids.add(request.args[0]); handles.add('$' + request.id);
    } else if (request.op === 'get_property') {
      if (!handles.has(request.target) || !propertyNames.has(request.property)) return null;
      properties++;
    } else return null;
  }
  return properties ? { operations: body.operations, ids: [...ids] } : null;
}

export function nativeTagPropertyReadTargetsV2(input: unknown): readonly string[] {
  return propertyReadRequest(input)?.ids.map(id => `id:${id}`).sort() ?? [];
}

export function decodeNativeTagPropertyReadV2(input: unknown, payload: unknown): NativeItem[] | null {
  const root = object(input), response = object(payload), request = propertyReadRequest(input);
  if (root?.method !== 'POST' || root.path !== '/revit/native-api-ops' || !request || !response
    || response.version !== 'operator.native_api_ops.v2' || response.ok !== true || response.read_only !== true
    || !Array.isArray(response.operations) || response.operations.length !== request.operations.length
    || response.operation_count !== request.operations.length) return null;
  const handles = new Map<string, NativeItem>(), items = new Map<number, NativeItem>();
  for (let i = 0; i < request.operations.length; i++) {
    const r = request.operations[i]!, observed = object(response.operations[i]);
    if (!observed || observed.id !== r.id || observed.op !== r.op) return null;
    if (r.op === 'call') {
      const identity = object(observed.result_preview);
      if (!identity || observed.member_id !== GET_ELEMENT || observed.target_type !== 'Autodesk.Revit.DB.Document'
        || identity.id !== r.args[0] || typeof identity.unique_id !== 'string'
        || identity.unique_id.length < 10 || identity.unique_id.length > 120) return null;
      const previous = items.get(identity.id);
      if (previous && previous.unique_id !== identity.unique_id) return null;
      const item = previous ?? { element_id: identity.id, unique_id: identity.unique_id, properties: {}, native_types: {} };
      items.set(identity.id, item); handles.set('$' + r.id, item);
    } else {
      const item = handles.get(r.target);
      if (!item || observed.property !== r.property || observed.target_type !== 'Autodesk.Revit.DB.IndependentTag'
        || !Object.hasOwn(observed, 'result_preview')) return null;
      if (Object.hasOwn(item.properties, r.property)
        && JSON.stringify(item.properties[r.property]) !== JSON.stringify(observed.result_preview)) return null;
      item.properties[r.property] = observed.result_preview; item.native_types[r.property] = observed.target_type;
    }
  }
  return [...items.values()];
}

export function existingTagRepairReadbackMatchesV2(applyInput: unknown, readInput: unknown, payload: unknown): boolean {
  const body = existingTagRepairRequestV2(applyInput);
  if (!body || !positive(body.repairExistingTagId) || !positive(body.viewId)
    || body.dryRun === true || body.apply === false
    || ['leaderEndXyz', 'leaderElbowXyz'].some(k => Object.hasOwn(body, k))) return false;
  const requested = ['hasLeader', 'tagHeadPositionXyz', 'leaderEndCondition'].filter(k => Object.hasOwn(body, k));
  if (!requested.length) return false;
  const tag = decodeNativeTagPropertyReadV2(readInput, payload)?.find(i => i.element_id === body.repairExistingTagId);
  if (!tag || tag.properties.OwnerViewId?.id !== body.viewId) return false;
  for (const field of requested) {
    const property = ({hasLeader:'HasLeader',tagHeadPositionXyz:'TagHeadPosition',leaderEndCondition:'LeaderEndCondition'} as Record<string,string>)[field]!;
    const actual = tag.properties[property], expected = body[field];
    if (!Object.hasOwn(tag.properties, property)) return false;
    if (field === 'hasLeader') { if (typeof expected !== 'boolean' || actual !== expected) return false; }
    else if (field === 'tagHeadPositionXyz') {
      if (!Array.isArray(expected) || expected.length !== 3 || !expected.every(Number.isFinite) || !object(actual)
        || ![actual.x,actual.y,actual.z].every((v,i) => Number.isFinite(v) && Math.abs(v-expected[i]) <= 1e-6)) return false;
    } else {
      const condition = tagLeaderEndConditionV2(expected);
      if (!condition || typeof actual !== 'string' || actual.toLowerCase() !== condition) return false;
    }
  }
  return true;
}
