import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureWorkspaceLayout } from "./workspace.js";
import { prepareBoundedModelEvidenceInput } from "./evidence/model_context_budget.js";
import { canonicalJsonV2, type AssignmentSnapshotV2 } from "./domain/assignment-kernel/index.js";
import type { AssignmentKernelBindingInputV2 } from "./assignments/assignment_kernel_v2_lifecycle.js";
import {getAssignmentKernelSnapshotV2} from './assignments/assignment_kernel_v2_store.js';

function writeDurable(file: string, value: unknown): void {
  const fd = fs.openSync(file, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
}

type Binding = AssignmentKernelBindingInputV2 & { kernelVersion: 1 | 2 };
type Stored = { binding: Binding; message_id: string; request_hash: string;
  status: "pending" | "complete" | "error"; response?: unknown; failure?: unknown };
/** Transport custody only. A reviewer uses the same accounting/admission path,
 * but must not replace the execution owner's conversation. This is no grant. */
export function desktopResponseOwnsContext(request: any): boolean {
  if (request?.context_role === undefined || request.context_role === 'owner') return true;
  if (request.context_role === 'independent_review') return false;
  throw Error('desktop_context_role_invalid');
}
function identity(binding: Binding, messageId: unknown) {
  if (typeof messageId !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(messageId))
    throw new Error("desktop_response_message_identity_required");
  const root = path.join(ensureWorkspaceLayout().runs, "desktop-responses");
  fs.mkdirSync(root, { recursive: true });
  const key = createHash("sha256").update(canonicalJsonV2([binding.session_id, messageId])).digest("hex");
  return { file: path.join(root, key + ".json"), messageId };
}
function load(file: string, binding: Binding, messageId: string): Stored | null {
  if (!fs.existsSync(file)) return null;
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
  if (record.message_id !== messageId || canonicalJsonV2(record.binding) !== canonicalJsonV2(binding)
      || !["pending", "complete", "error"].includes(record.status))
    throw new Error("desktop_response_binding_mismatch");
  return record;
}
const completedOutputs = (input: any): any[] => Array.isArray(input) ? input.filter(item =>
  ['function_call_output','computer_call_output'].includes(item?.type)) : [];
/** Pin the existing presentation transform only after the incoming raw outputs
 * match the retained boundary exactly. The HTTP relay later applies this same
 * budget transform. Raw records, evidence and image bytes remain untouched. */
function projectedPredecessorOutputHash(request: any, outputs: unknown): string | undefined {
  if (!Array.isArray(outputs) || canonicalJsonV2(completedOutputs(request?.input)) !== canonicalJsonV2(outputs)) return;
  try {
    const projected = prepareBoundedModelEvidenceInput(request.input);
    return createHash('sha256').update(canonicalJsonV2(completedOutputs(projected))).digest('hex');
  } catch {
    // Malformed/unsupported input still reaches the original strict guards;
    // failure to project never grants a different continuation boundary.
    return;
  }
}
/** Only call after HTTP authentication, session access and current binding validation. */
export function readDesktopResponse(binding: Binding, messageId: unknown): Stored | null {
  const id = identity(binding, messageId);
  return load(id.file, binding, id.messageId);
}
/** Accounting recovery is not permission to consume or execute a saved response. */
export function desktopResponseTelemetry(record: Stored | null): unknown {
  if (!record) return { status: "missing" };
  const payload = (record.status === "complete" ? record.response : record.failure) as Record<string, unknown> | undefined;
  return {
    status: record.status, binding: record.binding, message_id: record.message_id,
    telemetry: {
      ...(payload?.model_call_receipt ? { model_call_receipt: payload.model_call_receipt } : {}),
      ...(Array.isArray(payload?.model_call_receipts) ? { model_call_receipts: payload.model_call_receipts } : {}),
      ...(payload?.provider_response_usage ? { provider_response_usage: payload.provider_response_usage } : {})
    }
  };
}
/** Claim before dispatch. An interrupted pending claim never authorizes redispatch. */
export async function retainDesktopResponse<T>(binding: Binding, messageId: unknown, request: unknown,
  invoke: () => Promise<T>, errorPayload: (error: unknown) => unknown, ownerContext = false): Promise<T> {
  const id = identity(binding, messageId);
  const requestHash = createHash("sha256").update(canonicalJsonV2(request)).digest("hex");
  const prior = load(id.file, binding, id.messageId);
  if (prior) {
    if (prior.request_hash !== requestHash) throw new Error("desktop_response_request_identity_conflict");
    // Even completed responses must be recovered explicitly, never executed twice.
    throw new Error("desktop_response_already_dispatched_use_result");
  }
  const pending: Stored = { binding, message_id: id.messageId, request_hash: requestHash, status: "pending" };
  writeDurable(id.file, pending);
  // A new dispatch invalidates the previous resumable boundary before any
  // provider I/O. A failed/interrupted call must never fall back to old actions.
  if (ownerContext) {
    const current = loadContext(binding);
    const predecessor = current?.complete && Array.isArray(current.window)
      ? { response_id: contextResponse(binding, current.message_id).id, window: current.window,
          outputs: current.outputs, model: current.model, reasoning_effort: current.reasoning_effort,
          feedback_markers: current.feedback_markers ?? [],
          projected_outputs_hash: projectedPredecessorOutputHash(request, current.outputs) }
      : undefined;
    replaceContext(binding, { binding, message_id: id.messageId, outputs: null,
      model: (request as any)?.model, reasoning_effort: (request as any)?.reasoning_effort,
      // In-flight custody is not a resumable fallback. Only this exact request
      // may consume its predecessor; failure still leaves complete=false.
      ...(predecessor && (request as any)?.previous_response_id === predecessor.response_id
        ? { predecessor } : {}),
      // Navigation failures survive an interrupted provider call or reopen,
      // but never restore the invalidated response's actions/tool outputs.
      retrieval_failures: current?.retrieval_failures ?? {} });
  }
  const persist = (record: Stored) => {
    const temporary = id.file + "." + randomUUID() + ".tmp";
    const context = ownerContext ? loadContext(binding) : null;
    // Retain the exact newly generated host snapshot once, outside the replay
    // window. Never copy the whole conversation or image payloads into this log.
    writeDurable(temporary, { ...record, ...(context?.message_id === id.messageId
      && context.host_feedback_item ? { request_context: { host_feedback: context.host_feedback_item,
        packing: context.context_packing } } : {}) });
    fs.renameSync(temporary, id.file);
  };
  let response: T;
  try { response = await invoke(); }
  catch (error) { persist({ ...pending, status: "error", failure: errorPayload(error) }); throw error; }
  // A persistence failure must not turn a successful provider call into a retry.
  persist({ ...pending, status: "complete", response });
  return response;
}

function contextFile(binding: Binding): string {
  return identity(binding, 'owner-context').file + '.context';
}
function replaceContext(binding: Binding, value: unknown): void {
  const file = contextFile(binding), temporary = file + '.' + randomUUID() + '.tmp';
  writeDurable(temporary, value);
  fs.renameSync(temporary, file);
}
function loadContext(binding: Binding): any {
  const file = contextFile(binding);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (canonicalJsonV2(value.binding) !== canonicalJsonV2(binding)) throw Error('desktop_context_binding_mismatch');
  return value;
}
/** Only canonical terminal settlement calls this. Retire duplicate inline pixels
 * from temporary reasoning context, never original evidence or replay journals.
 * Incomplete/Pause/unknown work and explicit qualification pins stay protected.
 * Every removed image must already have an independently hashed evidence object.
 * Cleanup failure cannot change an outcome or trigger another provider call. */
export function retireCompletedDesktopImages(binding: Binding, state: AssignmentSnapshotV2): {status:string;images?:number;bytes_recovered?:number} {
  if(binding.kernelVersion!==2||!state.terminal||!state.quiescent
    ||!['complete','complete_with_issues','verified_noop'].includes(state.outcome)
    ||state.execution_control?.state==='paused'||state.provider_usage_hold
    ||state.unresolved_unknown_operation_ids.length||state.in_flight_operation_ids.length||state.in_flight_provider_call_ids.length
    ||state.pending_review_ids.length||state.pending_input_variable_ids.length
    ||Object.values(state.provider_calls).some(c=>!c.usage||!c.completed_at||!Number.isSafeInteger(c.usage.total_tokens)||c.usage.total_tokens!<0)
    ||['session_id','assignment_id','run_id','generation'].some(k=>(state.current_binding as any)[k]!==(binding as any)[k]))return{status:'protected'};
  try {
    const file=contextFile(binding);
    const safe=(target:string)=>{for(let p=path.resolve(target);;){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('reparse');const parent=path.dirname(p);if(parent===p)break;p=parent;}};
    safe(file);if(fs.existsSync(file+'.retain'))return{status:'pinned'};
    const current=loadContext(binding);
    if(!current||current.image_retirement||!current.complete)return{status:'unchanged'};
    const evidence=ensureWorkspaceLayout().evidence,hashes=new Set<string>();let images=0,visited=0;
    const visit=(value:any,depth=0):any=>{
      if(++visited>100_000||depth>64)throw Error('context_scan_bound');
      if(!value||typeof value!=='object')return value;
      if(value.type==='input_image'){
        if(Object.keys(value).some(k=>!['type','image_url','detail'].includes(k))||value.detail!==undefined&&!['auto','low','high','original'].includes(value.detail))throw Error('image_contract');
        const match=typeof value.image_url==='string'&&/^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value.image_url);
        if(!match)throw Error('image_not_durable');const raw=Buffer.from(match[1]!,'base64');if(raw.toString('base64')!==match[1])throw Error('image_encoding');
        const hash=createHash('sha256').update(raw).digest('hex'),object=path.join(evidence,'objects','sha256',hash.slice(0,2),hash+'.bin');safe(object);
        if(!fs.existsSync(object)||!fs.lstatSync(object).isFile()||fs.statSync(object).size!==raw.length||createHash('sha256').update(fs.readFileSync(object)).digest('hex')!==hash)throw Error('image_not_durable');
        images++;hashes.add(hash);return{type:'input_text',text:'Completed-task temporary image copy retired; original evidence sha256:'+hash+'. This historical pointer is not image proof.'};
      }
      return Array.isArray(value)?value.map(v=>visit(v,depth+1)):Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,depth+1)]));
    };
    const next=visit(current);if(!images)return{status:'unchanged'};
    const before=Buffer.byteLength(JSON.stringify(current));
    next.complete=false;next.image_retirement={at:new Date().toISOString(),images,content_hashes:[...hashes],outputs_sha256:contextItemHash(current.outputs),prior_context_sha256:contextItemHash(current),reason:'canonical_completed_duplicate_pixels_only'};
    if(Buffer.byteLength(JSON.stringify(next))>=before)return{status:'unchanged_not_smaller'};
    replaceContext(binding,next);
    return{status:'retired',images,bytes_recovered:before-Buffer.byteLength(JSON.stringify(next))};
  }catch{return{status:'protected_unverified_or_unavailable'};}
}
function retireAfterContextWrite(binding:Binding):void {
  // Final output storage may arrive after terminal settlement. Re-read current
  // canonical state; storage does not resume a task or grant another turn.
  try{const state=getAssignmentKernelSnapshotV2(binding.assignment_id);if(state)retireCompletedDesktopImages(binding,state);}catch{/* Retain on any ambiguity; never relabel or retry completed work. */}
}
function contextResponse(binding: Binding, messageId: string): any {
  const record = readDesktopResponse(binding, messageId), response = record?.response as any;
  if (record?.status !== 'complete' || response?.status !== 'completed'
    || typeof response.id !== 'string' || !response.id
    || response.model_call_receipt?.success !== true || response.model_call_receipt?.route !== 'desktop_computer'
    || response.model_call_receipt?.call_id !== response.id
    || response.provider_response_usage?.disposition !== 'completed'
    || response.provider_response_usage?.message_id !== messageId
    || response.provider_response_usage?.session_id !== binding.session_id
    || !response.provider_response_usage?.raw_response_ids?.includes(response.id)
    || !Array.isArray(response.output)) throw Error('desktop_context_response_not_settled');
  return response;
}

const WINDOW_BYTES = 27_000_000;
/** Keep the literal provider compaction item, not a textual approximation.
 * Raw earlier records remain in the response journal. */
function compactWindow(items: any[]): any[] | null {
  let last = -1;
  for (let i=items.length-1;i>=0;i--) if (items[i]?.type === 'compaction') { last=i; break; }
  // Opaque compaction is genuine provider state, but cannot be used as precise
  // drawing pixels. Preserve a bounded selection of literal completed image
  // observations alongside it. These remain historical observations with their
  // original metadata, never currentness, verification or execution authority.
  // Keep the original call/output and its opaque reasoning dependencies.
  // Turning image results into user inputs breaks the computer tool's image
  // contract. Dropping the reasoning instead leaves orphaned provider item IDs.
  // These are literal historical results, never new execution or current proof.
  const imagePairs = new Map<string, {call:any;reasoning:any[];output:any;index:number}>();
  if(last>=0){
    const calls=new Map<string,{call:any;reasoning:any[]}>();
    let reasoning:any[]=[];
    const survivingIds=new Set(items.slice(last).map(i=>i?.call_id).filter(Boolean));
    for(let i=0;i<last;i++){
      const item=items[i];
      if(item?.type==='reasoning'){
        if(items[i-1]?.type!=='reasoning')reasoning=[];
        reasoning.push(item);
      }else if(item?.role==='user'||item?.type==='message'||item?.type==='compaction')reasoning=[];
      if(item?.type==='function_call'&&typeof item.call_id==='string')calls.set(item.call_id,{call:item,reasoning:[...reasoning]});
      if(item?.type!=='function_call_output'||!Array.isArray(item.output))continue;
      const pair=calls.get(item.call_id),call=pair?.call,images=item.output.filter((c:any)=>c?.type==='input_image');
      if(!call||typeof call.name!=='string'||!images.length||images.length>3||survivingIds.has(item.call_id))continue;
      imagePairs.set(call.name,{call,reasoning:pair!.reasoning,output:item,index:i});
    }
  }
  let imageBytes=0;
  const retainedReasoning=new Set<string>();
  const retained=[...imagePairs.values()].sort((a,b)=>b.index-a.index).slice(0,2).filter(p=>{
    const bytes=Buffer.byteLength(JSON.stringify([...p.reasoning,p.call,p.output]),'utf8');
    if(bytes>12_000_000-imageBytes)return false;imageBytes+=bytes;return true;
  }).sort((a,b)=>a.index-b.index).flatMap(p=>[
    ...p.reasoning.filter(r=>{const key=r.id??r.encrypted_content;if(retainedReasoning.has(key))return false;retainedReasoning.add(key);return true;}),
    p.call,p.output
  ]);
  const window = last < 0 ? items : [items[last],...retained,...items.slice(last+1)];
  if (window.length > 5000 || Buffer.byteLength(JSON.stringify(window), 'utf8') > WINDOW_BYTES
      || window.some(item => item?.type === 'reasoning' && !item.encrypted_content
        || item?.type === 'compaction' && !item.encrypted_content)) return null;
  return window;
}

function assertClosedWindow(items: any[]): void {
  const pending = new Map<string, string>(), seen = new Set<string>();
  for (const item of items) {
    if (['function_call','computer_call'].includes(item?.type)) {
      if (typeof item.call_id !== 'string' || !item.call_id || seen.has(item.call_id))
        throw Error('desktop_context_window_call_identity');
      seen.add(item.call_id); pending.set(item.call_id, item.type);
    } else if (['function_call_output','computer_call_output'].includes(item?.type)) {
      if (pending.get(item.call_id) !== item.type.replace(/_output$/, ''))
        throw Error('desktop_context_window_tool_pair');
      pending.delete(item.call_id);
    }
  }
  if (pending.size) throw Error('desktop_context_window_incomplete');
}

function assertWindowImages(input: unknown): void {
  const queue: any[] = [input];
  while (queue.length) {
    const item = queue.pop();
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item)) { queue.push(...item); continue; }
    if (['input_image','computer_screenshot'].includes(item.type)) {
      const hasUrl = typeof item.image_url === 'string' && !!item.image_url;
      const hasFile = typeof item.file_id === 'string' && !!item.file_id;
      if (hasUrl === hasFile) throw Error('desktop_context_window_image_missing_or_ambiguous');
    }
    for (const key of ['content','input','output']) if (item[key] && typeof item[key] === 'object') queue.push(item[key]);
  }
}

/** Called after bounded evidence projection/current host feedback, before
 * provider dispatch. The sidecar cursor addresses a local exact boundary;
 * when its literal window exists, the provider receives input-array chaining.
 * Missing legacy windows keep the supported cursor route, never reconstructed
 * images or a fabricated compaction. No network recovery or hidden retry. */
// Cold computer replay must not append a new startup image to historical
// top-level user pixels (including inline references, not just desktop screens).
// Retire only those historical pixels from the live window; keep the original
// attachment text, literal tool-image pairs and immutable raw journals intact.
function supersededStartupImages(window: any[], body: any): { input: any[]; omitted: number } {
  const hasUserImage = (item: any) => item?.role === 'user' && Array.isArray(item.content)
    && item.content.some((c: any) => c?.type === 'input_image');
  if (!body.tools?.some((t: any) => t?.type === 'computer') || !Array.isArray(body.input)
      || !body.input.some(hasUserImage)) return { input: window, omitted: 0 };
  assertWindowImages(window); // Retirement must not hide malformed image identities.
  let omitted = 0;
  const input = window.map(item => !hasUserImage(item) ? item : { ...item, content: item.content.map((part: any) => {
    if (part?.type !== 'input_image') return part;
    omitted++;
    return { type: 'input_text', text:
      'Historical desktop screenshot or inline reference image omitted from replay because this request supplies a fresh screen/image input. '
      + 'Original image-input SHA256: ' + createHash('sha256').update(canonicalJsonV2(part)).digest('hex')
      + '. Original pixels, source attachment references and raw evidence remain retained. This digest is not visual proof. '
      + 'Re-read the retained source attachment or retrieve a focused current model view when those pixels are needed; do not infer image details from this placeholder.' };
  }) });
  return { input, omitted };
}

type FeedbackMarker = { index: number; sha256: string };
const contextItemHash = (item: any) => createHash('sha256').update(canonicalJsonV2(item)).digest('hex');

function feedbackMarkers(window: any[], markers: unknown): FeedbackMarker[] {
  if (markers === undefined) return []; // Legacy windows have no authenticated markers.
  if (!Array.isArray(markers) || markers.length > 5000) throw Error('desktop_context_feedback_identity');
  const seen = new Set<number>();
  for (const marker of markers) {
    if (!Number.isSafeInteger(marker?.index) || marker.index < 0 || marker.index >= window.length
        || !/^[a-f0-9]{64}$/.test(marker.sha256) || seen.has(marker.index)
        || contextItemHash(window[marker.index]) !== marker.sha256)
      throw Error('desktop_context_feedback_identity');
    seen.add(marker.index);
  }
  return markers;
}

function hostFeedback(binding: Binding, input: any, item: any): any {
  if (item === undefined) return undefined;
  if (!Array.isArray(input) || !input.length || canonicalJsonV2(input.at(-1)) !== canonicalJsonV2(item)
      || item?.role !== 'user' || item.content?.length !== 1
      || item.content[0]?.type !== 'input_text' || typeof item.content[0].text !== 'string'
      || !item.content[0].text.startsWith('HOST CURRENT CHECK FEEDBACK. '))
    throw Error('desktop_context_feedback_identity');
  let packet: any;
  try { packet = JSON.parse(item.content[0].text.slice(item.content[0].text.indexOf('\n') + 1)); }
  catch { throw Error('desktop_context_feedback_identity'); }
  if (packet.schema !== 'operator.desktop-assignment-feedback.v1'
      || !Number.isSafeInteger(packet.assignment_version) || packet.assignment_version < 1
      || ['session_id','assignment_id','run_id','generation'].some(key => packet.binding?.[key] !== (binding as any)[key]))
    throw Error('desktop_context_feedback_identity');
  return item;
}

/** Only exact embedded-image duplicates in the historical replay are omitted.
 * Fresh outputs, unique pixels, quality settings, call pairs, native metadata
 * and opaque provider compaction/reasoning stay intact. URLs/files are not
 * content identities. An omission is not freshness, absence or verification. */
function uniqueHistoricalPixels(history: any[], fresh: any[]): { input: any[]; omitted: number } {
  const key = (part: any): string | null => {
    if (part?.type !== 'input_image' || typeof part.image_url !== 'string'
        || Object.keys(part).some(k => !['type','image_url','detail'].includes(k))
        || part.detail !== undefined && !['auto','low','high','original'].includes(part.detail)) return null;
    const match = /^data:image\/(?:png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url);
    if (!match || Buffer.from(match[1]!, 'base64').toString('base64') !== match[1]) return null;
    return contextItemHash(part);
  };
  const seen = new Set<string>();
  const parts = (item: any): any[] => Array.isArray(item?.output) ? item.output
    : Array.isArray(item?.content) ? item.content : [];
  for (const item of fresh) for (const part of parts(item)) { const hash = key(part); if (hash) seen.add(hash); }
  let omitted = 0;
  const input = [...history];
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i], blocks = parts(item), next = [...blocks]; let changed = false;
    for (let j = blocks.length - 1; j >= 0; j--) {
      const hash = key(blocks[j]); if (!hash) continue;
      if (!seen.has(hash)) { seen.add(hash); continue; }
      next[j] = { type: 'input_text', text: 'Historical duplicate image omitted from replay. Identical encoded pixels '
        + '(image-part SHA256 ' + hash + ') are present later in this input. Original source/native metadata '
        + 'and raw evidence remain retained. This omission grants no freshness or verification.' };
      omitted++; changed = true;
    }
    if (changed) input[i] = { ...item, [Array.isArray(item.output) ? 'output' : 'content']: next };
  }
  return { input, omitted };
}

/** Content-free measurements of the actual API envelope, not token estimates
 * or billing. Pixel strings and instructions are hashed/counted, never copied. */
export function desktopModelInputPackage(body: any) {
  const rows = Array.isArray(body.input) ? body.input : [], groups: Record<string,{count:number;bytes:number}> = Object.create(null);
  const images: string[] = []; let textBytes = 0, feedbackBytes = 0, feedbackCount = 0;
  const inspect = (value: any): void => {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(inspect); return; }
    if (value.type === 'input_image') images.push(contextItemHash(value));
    if (value.type === 'input_text' && typeof value.text === 'string') {
      textBytes += Buffer.byteLength(value.text);
      if (value.text.startsWith('HOST CURRENT CHECK FEEDBACK. ')) { feedbackCount++; feedbackBytes += Buffer.byteLength(value.text); }
    }
    for (const field of ['input','output','content']) {
      if (typeof value[field] === 'string') textBytes += Buffer.byteLength(value[field]);
      else inspect(value[field]);
    }
  };
  inspect(rows);
  for (const row of rows) {
    const value = row?.type ?? row?.role;
    const kind = ['function_call','function_call_output','computer_call','computer_call_output','compaction','reasoning','user','assistant','message'].includes(value) ? value : 'other';
    const group = groups[kind] ?? {count:0,bytes:0};
    group.count++; group.bytes += Buffer.byteLength(JSON.stringify(row)); groups[kind] = group;
  }
  const instructions = typeof body.instructions === 'string' ? body.instructions : '';
  return {schema:'operator.model-input-package.v1',input_items:rows.length,
    input_utf8_bytes:Buffer.byteLength(JSON.stringify(body.input)),by_type:groups,text_utf8_bytes:textBytes,
    image_inputs:images.length,unique_image_parts:new Set(images).size,
    host_feedback_count:feedbackCount,host_feedback_utf8_bytes:feedbackBytes,
    instructions_utf8_bytes:Buffer.byteLength(instructions),instructions_sha256:createHash('sha256').update(instructions).digest('hex'),
    tools_count:Array.isArray(body.tools)?body.tools.length:0,tools_utf8_bytes:Buffer.byteLength(JSON.stringify(body.tools??[])),
    limits:'Encoded transport bytes and item counts only; no provider token attribution, billing, evidence authority or task completion.'};
}

export function prepareDesktopProviderInput(binding: Binding, messageId: unknown, body: any,
  internal: { hostFeedback?: unknown } = {}): any {
  if (!desktopResponseOwnsContext(body)) return body;
  const current = loadContext(binding);
  if (!current || current.message_id !== messageId) return body; // legacy/direct relay
  // This argument is supplied only by the authenticated host producer. A text
  // prefix/schema in caller input is never sufficient to mark or delete it.
  const latestFeedback = hostFeedback(binding, body.input, internal.hostFeedback);
  let markers: FeedbackMarker[] = [], omittedFeedback = 0, omittedImages = 0, omittedStartupImages = 0;
  let prepared = body;
  if (current.predecessor) {
    const prior = current.predecessor;
    const outputs = completedOutputs(body.input);
    const outputsMatch = prior.projected_outputs_hash === undefined
      ? canonicalJsonV2(outputs) === canonicalJsonV2(prior.outputs) // Legacy retained boundary.
      : /^[a-f0-9]{64}$/.test(prior.projected_outputs_hash)
        && createHash('sha256').update(canonicalJsonV2(outputs)).digest('hex') === prior.projected_outputs_hash;
    if (body.previous_response_id !== prior.response_id || body.model !== prior.model
        || body.reasoning_effort !== prior.reasoning_effort
        || !outputsMatch)
      throw Error('desktop_context_window_predecessor_mismatch');
    const known = feedbackMarkers(prior.window, prior.feedback_markers);
    const superseded = new Set(latestFeedback ? known.map(x => x.index) : []);
    const startup = supersededStartupImages(prior.window, body);
    omittedStartupImages = startup.omitted;
    const retained = startup.input.filter((_item: any, i: number) => !superseded.has(i));
    omittedFeedback = superseded.size;
    const pixels = uniqueHistoricalPixels(retained, body.input);
    omittedImages = pixels.omitted;
    if (!latestFeedback) markers = known;
    const input = [...pixels.input, ...body.input];
    if (Buffer.byteLength(JSON.stringify(input), 'utf8') > WINDOW_BYTES)
      throw Error('desktop_context_window_budget_exceeded');
    assertClosedWindow(input);
    const { previous_response_id: _cursor, ...rest } = body;
    prepared = { ...rest, input };
  }
  const input = typeof prepared.input === 'string'
    ? [{ role: 'user', content: prepared.input }] : prepared.input;
  // A remote legacy cursor alone cannot establish its missing earlier window.
  const providerInput = !prepared.previous_response_id && Array.isArray(input) ? input : null;
  if (providerInput) { assertClosedWindow(providerInput); assertWindowImages(providerInput); }
  if (latestFeedback && providerInput) markers.push({ index: providerInput.length - 1, sha256: contextItemHash(latestFeedback) });
  replaceContext(binding, { ...current, model: body.model, reasoning_effort: body.reasoning_effort,
    provider_input: providerInput, continuation_transport: providerInput ? 'durable_input_array' : 'previous_response_id',
    feedback_markers: markers, host_feedback_item: latestFeedback,
    context_packing: { superseded_host_snapshots: omittedFeedback, duplicate_historical_images: omittedImages,
      ...(omittedStartupImages ? { superseded_startup_images: omittedStartupImages } : {}) } });
  return prepared;
}
/** Host transport state only. Retaining completed outputs proves no model work,
 * admits no action, and does not consume a new provider call. Partial responses
 * are intentionally not resumable; the saved canonical-context path remains. */
export function retainDesktopContext(binding: Binding, messageId: string, outputs: unknown): {retrieval_feedback?: unknown} {
  const current = loadContext(binding);
  if (!current || current.message_id !== messageId) throw Error('desktop_context_not_latest');
  const response = contextResponse(binding, messageId);
  if (!Array.isArray(outputs) || Buffer.byteLength(JSON.stringify(outputs), 'utf8') > 16_000_000)
    throw Error('desktop_context_outputs_invalid');
  if (response.output.some((item: any) => !['message','reasoning','compaction','function_call','computer_call'].includes(item?.type)))
    throw Error('desktop_context_unsupported_output');
  const calls = response.output.filter((item: any) => ['function_call', 'computer_call'].includes(item?.type));
  if (calls.some((call: any) => typeof call.call_id !== 'string' || !call.call_id || call.call_id.length > 256))
    throw Error('desktop_context_call_identity_required');
  const seen = new Set<string>();
  for (const item of outputs) {
    const call = calls.find((c: any) => c.call_id === item?.call_id);
    if (!call || seen.has(item.call_id) || item.type !== call.type + '_output'
      || (call.type === 'function_call' && !(typeof item.output === 'string' || Array.isArray(item.output)
        && item.output.every((part:any)=>part?.type==='input_text'&&typeof part.text==='string'
          ||part?.type==='input_image'&&typeof part.image_url==='string'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url))))
      || (call.type === 'computer_call' && item.output?.type !== 'computer_screenshot'))
      throw Error('desktop_context_tool_output_mismatch');
    seen.add(item.call_id);
  }
  if (new Set(calls.map((c: any) => c.call_id)).size !== calls.length) throw Error('desktop_context_duplicate_call');
  if(current.image_retirement){
    // An exact late storage retry must not reintroduce retired pixel copies.
    // Keep the same raw-output boundary; a changed retry remains a conflict.
    if(contextItemHash(outputs)!==current.image_retirement.outputs_sha256)throw Error('desktop_context_output_conflict');
    return current.retrieval_feedback?{retrieval_feedback:current.retrieval_feedback}:{};
  }
  // Idempotent final boundaries; no rewriting an already retained output.
  if (current.outputs !== null && canonicalJsonV2(current.outputs) !== canonicalJsonV2(outputs))
    throw Error('desktop_context_output_conflict');
  if (current.outputs !== null) {retireAfterContextWrite(binding);return current.retrieval_feedback ? {retrieval_feedback:current.retrieval_feedback} : {};}
  const failures: Record<string, number> = { ...(current.retrieval_failures ?? {}) };
  const affected = new Set<string>();
  for (const call of calls) {
    if (call.type !== 'function_call' || call.name !== 'operator_retrieve_evidence') continue;
    const item = outputs.find((o:any)=>o.call_id===call.call_id);
    if (!item || typeof item.output !== 'string') continue;
    try {
      const args = JSON.parse(call.arguments), result = JSON.parse(item.output), id=args?.evidenceId;
      if (typeof id!=='string'||!/^ev1_[A-Za-z0-9_-]{32}$/.test(id)) continue;
      if (result?.ok===true && result.schema==='operator.focused-evidence-read.v1'
          && result.source_identity?.evidence_id===id) { delete failures[id]; continue; }
      if (result?.ok!==false || typeof result.error!=='string' || !result.error) continue;
      // Same artifact, even when purpose/selector wording changes. This is a
      // bounded navigation-stall diagnostic, never completion/effect evidence.
      failures[id]=Math.min(4,(failures[id]??0)+1);
      affected.add(id);
    } catch { /* Malformed or unrelated output cannot reset a failure. */ }
  }
  // Keep only bounded failure history. Oldest distinct artifacts fall out;
  // repeated current failures retain their existing slot and saturated count.
  const retainedFailures=Object.fromEntries(Object.entries(failures).slice(-64));
  const id=[...affected].filter(id=>failures[id]).sort((a,b)=>failures[b]!-failures[a]!)[0];
  const feedback=id?{state:failures[id]!>=4?'stalled':failures[id]!>=2?'change_approach':'observing',evidence_id:id,failures:failures[id]!}:undefined;
  const window = Array.isArray(current.provider_input)
    ? compactWindow([...current.provider_input, ...response.output]) : null;
  const markers = Array.isArray(current.provider_input) && window
    ? feedbackMarkers(current.provider_input, current.feedback_markers).flatMap(marker => {
      const index = window.indexOf(current.provider_input[marker.index]);
      return index < 0 ? [] : [{ index, sha256: marker.sha256 }];
    }) : [];
  // Do not keep duplicate full windows in the live context file. Full original
  // response records remain unchanged; only completed exact tool outputs resume.
  const { predecessor: _prior, provider_input: _input, ...retained } = current;
  replaceContext(binding, { ...retained, ...(window ? { window } : {}), outputs, complete: calls.length === outputs.length,
    feedback_markers: markers, retrieval_failures:retainedFailures,retrieval_feedback:feedback });
  retireAfterContextWrite(binding);
  return feedback ? {retrieval_feedback:feedback} : {};
}

/** Call only behind current authenticated assignment validation. Historical
 * provider context is reasoning context, never current model/effect evidence. */
export function readDesktopContext(binding: Binding, state: AssignmentSnapshotV2): unknown {
  if (!desktopResponseContinuationAllowed(state) || state.outcome !== 'active' || state.completion_proposal
    || state.provider_budget_exhausted || state.in_flight_provider_call_ids.length || state.in_flight_operation_ids.length)
    throw Error('desktop_context_continuation_not_admitted');
  for (const key of ['session_id', 'assignment_id', 'run_id', 'generation'] as const)
    if (state.current_binding[key] !== binding[key]) throw Error('desktop_context_binding_mismatch');
  const current = loadContext(binding);
  if (!current?.complete || !Array.isArray(current.outputs)) return { status: 'unavailable' };
  const response = contextResponse(binding, current.message_id);
  if (!Object.values(state.provider_calls).some(call => call.upstream_receipt?.call_id === response.id
    && call.completed_at && call.success === true && call.usage)) throw Error('desktop_context_usage_not_settled');
  return { status: 'ready', binding, previous_response_id: response.id, input: current.outputs,
    model: current.model, reasoning_effort: current.reasoning_effort,
    ...(Array.isArray(current.window) ? { continuation_transport: 'durable_input_array' } : {}) };
}

export function desktopResponseContinuationAllowed(state: AssignmentSnapshotV2 | null | undefined): boolean {
  return !!state && !state.terminal && state.execution_control?.state !== "paused" && !state.provider_usage_hold
    && state.quiescent && state.unresolved_unknown_operation_ids.length === 0
    && state.pending_input_variable_ids.length === 0 && state.pending_review_ids.length === 0;
}
