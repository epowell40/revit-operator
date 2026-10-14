type Row = Record<string, unknown>;
const row = (value: unknown): Row | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : null;
const GET_ELEMENT = 'method:Autodesk.Revit.DB.Document.GetElement(Autodesk.Revit.DB.ElementId)';
const key=(value:unknown)=>typeof value==='string'?value.trim().toLowerCase():'';
const reference=(value:unknown)=>typeof value==='string'&&value.trim().startsWith('$')?key(value.trim().slice(1)):'';
const documentTarget=(value:unknown)=>['doc','document'].includes(key(value));

/** Reviewed read targeting only; this does not establish the returned value. */
export function nativeElementBooleanReadTargetsV1(input: unknown): string[] {
  const request=row(input);let body=row(request?.body??request?.arguments??request);
  if (!body && typeof request?.body==='string') {if(request.body.length>1_000_000)return [];try{body=row(JSON.parse(request.body));}catch{return [];}}
  const operations=body?.operations;if(!Array.isArray(operations)||!operations.length||operations.length>128)return [];
  const ids=operations.map(step=>key(row(step)?.id));if(ids.some(id=>!id||id.length>64)||new Set(ids).size!==ids.length)return [];
  const targets=new Set<string>();
  for(let index=0;index<operations.length;index++){
    const step=row(operations[index]);if(step?.op!=='get_property'||key(step.property)!=='hasstripedrows'||!reference(step.target))continue;
    const sourceIndex=ids.indexOf(reference(step.target)),source=sourceIndex>=0?row(operations[sourceIndex]):null;
    if(sourceIndex>=index||source?.op!=='call'||!documentTarget(source.target)||source.memberId!==GET_ELEMENT||!Array.isArray(source.args)||source.args.length!==1)continue;
    const id=source.args[0];if(Number.isSafeInteger(id)&&id>0)targets.add('id:'+id);
  }
  return [...targets].sort();
}

/** Read one returned boolean property from the exact native read-only graph.
 * Request fields and object summaries never stand in for the property result.
 * Native authority, binding, settlement and freshness remain caller gates. */
export function nativeElementBooleanReadbackV1(input: unknown, payload: unknown,
  elementId: number, property: string, targetType: string): boolean | undefined {
  const request = row(input), raw = row(payload);
  if (!request || !raw || !Number.isSafeInteger(elementId) || elementId <= 0
      || !['/revit/native-api-ops','revit_native_api_ops'].includes(String(request.path ?? request.tool))
      || raw.version !== 'operator.native_api_ops.v2' || raw.ok !== true || raw.read_only !== true) return undefined;
  let body = row(request.body ?? request.arguments ?? request);
  if (!body && typeof request.body === 'string') {
    if (request.body.length > 1_000_000) return undefined;
    try { body = row(JSON.parse(request.body)); } catch { return undefined; }
  }
  const operations = body?.operations, native = raw.operations, results = row(raw.results);
  if (!Array.isArray(operations) || !operations.length || operations.length > 128
      || !Array.isArray(native) || raw.operation_count !== operations.length
      || native.length !== operations.length || !results
      || body?.returns!=null&&!Array.isArray(body.returns)) return undefined;
  const ids = operations.map(step=>key(row(step)?.id));
  if (ids.some(id=>!id || id.length > 64) || new Set(ids).size !== ids.length) return undefined;
  const returned = Object.entries(results);if(new Set(returned.map(([name])=>key(name))).size!==returned.length)return undefined;
  const returnIds=Array.isArray(body?.returns)&&body.returns.length?body.returns.map(id=>key(typeof id==='string'?id.trim().replace(/^\$/,''):id)):[ids.at(-1)!];
  for (let i=0;i<operations.length;i++) {
    const step=row(operations[i]),receipt=row(native[i]);
    if (!step || !receipt || key(receipt.id) !== ids[i] || receipt.op !== step.op) return undefined;
    if (step.op === 'call' && receipt.member_id !== step.memberId) return undefined;
    if (step.op === 'get_property' && key(receipt.property) !== key(step.property)) return undefined;
  }
  const matches: boolean[]=[];
  for (let i=0;i<operations.length;i++) {
    const step=row(operations[i])!,receipt=row(native[i])!;
    if (step.op !== 'get_property' || key(step.property) !== key(property) || receipt.target_type !== targetType
        || typeof receipt.result_preview !== 'boolean') continue;
    const target=reference(step.target);
    const sourceIndex=ids.indexOf(target),lookup=sourceIndex>=0 ? row(operations[sourceIndex]) : null;
    const source=sourceIndex>=0 ? row(native[sourceIndex]) : null,identity=row(source?.result_preview);
    if (sourceIndex>=i || !lookup || !source || lookup.op!=='call' || !documentTarget(lookup.target)
        || lookup.memberId!==GET_ELEMENT || source.target_type!=='Autodesk.Revit.DB.Document'
        || !Array.isArray(lookup.args) || lookup.args.length!==1 || lookup.args[0]!==elementId
        || identity?.id!==elementId || typeof identity.unique_id!=='string' || !identity.unique_id) continue;
    if (!returnIds.includes(ids[i]) || returned.find(([name])=>key(name)===ids[i])?.[1]!==receipt.result_preview) continue;
    matches.push(receipt.result_preview);
  }
  return matches.length===1 ? matches[0] : undefined;
}
