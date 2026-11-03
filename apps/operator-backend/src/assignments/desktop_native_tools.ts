import {createHash} from 'node:crypto';
import {canonicalJsonV2, type AssignmentSnapshotV2} from '../domain/assignment-kernel/index.js';
import {assignmentKernelV2ForBinding} from './assignment_kernel_v2_factory.js';
import type {AssignmentKernelBindingInputV2} from './assignment_kernel_v2_lifecycle.js';
import {desktopExecutorOwnsAssignmentV2} from './desktop_executor_owner.js';
import {localDesktopNativeTransportAvailable} from './desktop_native_transport_policy.js';
import {getRequestOperatorBackendAuth, requestMatchesAssignmentPrincipalId} from '../request_context.js';
import {desktopResponseContinuationAllowed, readDesktopResponse, retainDesktopResponse} from '../desktop_response_store.js';
import {activeProviderTurnForBinding} from '../codex/active_turns.js';
import {getWorkspaceMcpRuntime, workspaceMcpRuntimes,desktopNativeCallsByWorkspace} from '../codex/workspace_mcp_runtime.js';
import {getWorkspaceRoot} from '../workspace.js';
import {handleCodexDynamicToolCall} from '../brains/codex_dynamic_tool_handler.js';
import {beginTeammateLoopOwner, bindTeammateLoopOwnerTurn, endTeammateLoopOwner} from '../teammate_loop_runtime.js';
import {beginRevitCourierTurnContext, endRevitCourierTurnContext} from '../courier/revit_courier_context.js';
import {revitCourierTargetFromContext} from '../courier/revit_courier_target.js';
import {OPERATOR_BACKEND_CONTRACT_VERSION} from '../contracts.js';
import {REVIT_ARTIFACT_DELIVERY_GUIDANCE} from '../brains/revit_artifact_delivery_guidance.js';
import {boundDesktopNativeOutput,boundDesktopNativeToolContract} from './desktop_native_output.js';
import {DESKTOP_EXECUTION_EFFICIENCY_GUIDANCE,desktopNativeInitialContext} from './desktop_execution_guidance.js';
import {nativeInteractiveInputOwnership,withNativeInteractiveInvocation,afterNativeInteractiveReadback} from './native_interactive_input.js';
import {buildAssignmentKernelPublicationV2} from './assignment_kernel_v2_publication.js';

const PREFIX='native__';
type Tool = {name:string;description:string;inputSchema:Record<string,unknown>;deferLoading?:boolean};
type RecordValue=Record<string,any>;
function object(value:unknown):RecordValue {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('desktop_native_object_required');
  return value as RecordValue;
}
function id(value:unknown):string {
  if(typeof value!=='string'||!value.length||value.length>256||!/^[A-Za-z0-9._:-]+$/.test(value))
    throw Error('desktop_native_identity_required');
  return value;
}

/** This adapter transports a tool selected by the existing desktop provider.
 * It does not run a model, accept caller-authored native arguments, or settle
 * effects itself. The same dynamic handler remains the only execution path. */
export function desktopNativeResponseCall(record:ReturnType<typeof readDesktopResponse>, responseId:unknown, callId:unknown) {
  const response=object(record?.response);
  if(record?.status!=='complete'||response.id!==id(responseId)||response.status!=='completed'
    ||response.model_call_receipt?.success!==true||response.model_call_receipt?.route!=='desktop_computer'
    ||response.model_call_receipt?.call_id!==response.id
    ||response.provider_response_usage?.disposition!=='completed'
    ||response.provider_response_usage?.message_id!==record.message_id
    ||response.provider_response_usage?.session_id!==record.binding.session_id
    ||!response.provider_response_usage?.raw_response_ids?.includes(response.id))
    throw Error('desktop_native_provider_response_not_settled');
  const matches=Array.isArray(response.output)?response.output.filter((item:any)=>item?.call_id===id(callId)):[];
  if(matches.length!==1||matches[0].type!=='function_call'||typeof matches[0].name!=='string'
    ||!matches[0].name.startsWith(PREFIX))throw Error('desktop_native_call_not_in_provider_response');
  const item=matches[0];
  const args=object(typeof item.arguments==='string'?JSON.parse(item.arguments):item.arguments);
  const tool=item.name===PREFIX+'invoke'?id(args.tool):item.name.slice(PREFIX.length);
  return {tool, arguments:item.name===PREFIX+'invoke'?object(args.arguments):args};
}

export function assertDesktopNativeState(snapshot:AssignmentSnapshotV2, responseId?:string):void {
  if(!desktopResponseContinuationAllowed(snapshot)||snapshot.completion_proposal
    ||snapshot.in_flight_provider_call_ids.length)throw Error('desktop_native_assignment_not_ready');
  assertDesktopNativeProviderAccounting(snapshot,responseId);
}
function assertDesktopNativeProviderAccounting(snapshot:AssignmentSnapshotV2,responseId?:string) {
  if(responseId&&(snapshot.in_flight_provider_call_ids.length||!Object.values(snapshot.provider_calls).some(call=>call.upstream_receipt?.call_id===responseId
    &&call.completed_at&&call.success===true&&call.usage))
    )
    throw Error('desktop_native_provider_accounting_not_settled');
}

function resolveOwner(binding:AssignmentKernelBindingInputV2) {
  const resolved=assignmentKernelV2ForBinding(binding);
  if(!resolved||!requestMatchesAssignmentPrincipalId(resolved.binding.principal_id,undefined,binding.session_id)
    ||!localDesktopNativeTransportAvailable()||!desktopExecutorOwnsAssignmentV2(resolved.snapshot))
    throw Error('desktop_native_owner_binding_required');
  if(activeProviderTurnForBinding(binding))throw Error('desktop_native_helper_already_active');
  return resolved;
}
function resolve(binding:AssignmentKernelBindingInputV2,responseId?:string) {
  const resolved=resolveOwner(binding);
  assertDesktopNativeState(resolved.snapshot,responseId);
  return resolved;
}

export function desktopNativeModelTools(tools:Tool[]) {
  // The general read/write executor is a primary drafting capability. Keep its
  // current host schema and SDK instructions in Responses.tools, outside the
  // compacted conversation. Only expose it when present in this same catalog;
  // dispatch still uses the existing argument, binding and native guards.
  const directExecutor=tools.some(tool=>tool.name==='operator_run_dynamic_revit_program');
  // These complete contracts remain in this same catalog and can be described
  // and invoked on demand. Do not repeat large bookkeeping schemas, or the MCP
  // alias of the owner's existing evidence reader, in every execution turn.
  // Without the direct executor preserve the existing eager interface.
  const supplemental=new Set(['operator_manage_work_plan','operator_evaluate_assignment_criteria','operator_retrieve_evidence']);
  const result=tools.filter(tool=>(tool.deferLoading!==true||tool.name==='operator_run_dynamic_revit_program')
    &&!(directExecutor&&supplemental.has(tool.name))).map(tool=>({type:'function',name:PREFIX+tool.name,
    description:tool.description,parameters:tool.inputSchema,strict:false}));
  result.push({type:'function',name:PREFIX+'invoke',strict:false,
    description:'Call an existing deferred Revit Operator MCP tool by its documented name and exact arguments. Use native__describe_tool to read its current request schema and instructions first; native HTTP tool search does not describe MCP executors. The backend validates the current catalog, assignment, arguments and native authority. This is a direct tool call in your current context, not a helper agent.',
    parameters:{type:'object',properties:{tool:{type:'string'},arguments:{type:'object'}},required:['tool','arguments'],additionalProperties:false}});
  result.push({type:'function',name:PREFIX+'describe_tool',strict:false,
    description:'Read the exact current description and input schema of one exposed MCP tool by its unprefixed name, including operator_run_dynamic_revit_program for custom C# reads or writes. This is documentation only: it runs no program, grants no authority and proves no model facts. Use the returned contract with native__invoke. Oversized documentation is retained for bounded evidence retrieval.',
    parameters:{type:'object',properties:{tool:{type:'string',minLength:1,maxLength:256}},required:['tool'],additionalProperties:false}});
  return result;
}

/** Same catalog used for execution, not a parallel registry or invented schema. */
export function desktopNativeToolContract(tools:Tool[],args:unknown) {
  const input=object(args);
  if(Object.keys(input).length!==1||!Object.hasOwn(input,'tool'))throw Error('desktop_native_contract_arguments_invalid');
  const name=id(input.tool),matches=tools.filter(tool=>tool.name===name);
  if(matches.length!==1)throw Error('desktop_native_tool_not_exposed');
  const tool=matches[0];
  if(typeof tool.description!=='string'||!tool.inputSchema||typeof tool.inputSchema!=='object'||Array.isArray(tool.inputSchema))
    throw Error('desktop_native_contract_invalid');
  const contract={schema:'operator.desktop-native-tool-contract.v1',completion_eligible:false,authorizationGranted:false,
    tool,invocation:{tool:'native__invoke',name,arguments:'Use the exact inputSchema; execution remains subject to current admission and source/effect limits.'}};
  if(Buffer.byteLength(JSON.stringify(contract),'utf8')>262_144)throw Error('desktop_native_contract_too_large');
  return contract;
}

/** A valid documentation lookup can miss without dispatching model work.
 * Keep malformed/ambiguous catalogs and every execution/ownership failure fatal
 * here; never convert an uncertain native invocation into a retry suggestion. */
export function desktopNativeToolDescription(tools:Tool[],args:unknown) {
  try {return {success:true,payload:desktopNativeToolContract(tools,args)};}
  catch(error) {
    if(!(error instanceof Error)||error.message!=='desktop_native_tool_not_exposed'
      ||tools.some(tool=>tool.name===object(args).tool))throw error;
    return {success:false,payload:{schema:'operator.desktop-native-tool-contract-unavailable.v1',
      requested_tool:object(args).tool,code:'desktop_native_tool_not_exposed',
      completion_eligible:false,authorizationGranted:false,native_action_dispatched:false,
      guidance:'That tool name is not exposed in the current catalog. Use a currently exposed tool name or the existing discovery tools to correct the lookup. This documentation request ran no native action and provides no model evidence; it does not reverse or settle any earlier effects.'}};
  }
}

export async function desktopNativeCatalog(binding:AssignmentKernelBindingInputV2) {
  resolve(binding);
  const runtime=getWorkspaceMcpRuntime(workspaceMcpRuntimes,getWorkspaceRoot());
  const catalog=await runtime.getDynamicToolNamespace();
  const current=resolve(binding); // Catalog startup may have overlapped Pause or generation change.
  return {schema:'operator.desktop-native-tools.v1',tools:desktopNativeModelTools(catalog.tools),
    guidance:[
      'You are the sole execution agent. Use native__ tools for native work and tracked SaveAs/file inspection, UI tools for interaction and independent review_current_work for appearance. Keep the whole request here; no execution-agent handoffs.',
      desktopNativeInitialContext(current.snapshot),
      'native__operator_run_dynamic_revit_program is directly available when exposed in the current catalog, with its exact request schema and C# SDK instructions in your tool definition. Use it for useful authorized custom reads or construction/correction batches; no separate code request or documentation lookup is needed. Keep actions bounded, preserve successful work and independently read actual results. A fixed-tool answer is not proof code ran. native__describe_tool and native__invoke remain available for other deferred tools, including operator_manage_work_plan and operator_evaluate_assignment_criteria. Retrieve evidence with the owner reader; the MCP operator_retrieve_evidence alias is also available on demand. Deferral changes no work-plan or completion requirement. Retained itemRange filters/order preserve original indices/source/partial flags, not native completeness. Defer unsupported requested design with specific missing inputs; continue independent work. Written questions alone are a deliverable, not unfinished design.',
      'After a useful native C# batch, ask review_current_work to assess exact executed code against the user request using code_evidence_ids from the executor output. Use review_mode:code_execution for code-only review without screenshots, or attach those IDs to a needed visual review for one combined reviewer call. Include relevant native C# readback calls; code returns are not independent verification. Do not predict every dependent Revit change or repeat writes for review. The reviewer is tool-free and cannot execute, grant authority, settle unknown effects or certify persistence. Keep independent result reads and required save/file evidence; disclose unreviewed scope.',
      DESKTOP_EXECUTION_EFFICIENCY_GUIDANCE,
      'Finish edits, verification and save/file inspection before final review unless requested otherwise. After confirmed later edits to an authorized non-workshared result, SaveAs supports the same path with overwrite=true: reconcile receipts, preserve source, inspect the updated file. For strict assignments, retain requested written findings through report_work_for_review with empty claim arrays before final inspection. For advisory assignments, report_work_for_review is the final unverified handoff after inspection or a genuine stop; written_findings supplies its user-facing body, not an interim checkpoint.',
      REVIT_ARTIFACT_DELIVERY_GUIDANCE
    ].join('\n')};
}

// Ephemeral exclusion only; durable operations and transport claims remain in
// their existing stores. A disconnected caller never causes automatic retry.
const busy=desktopNativeCallsByWorkspace;
const INTERACTIVE_PATH='/revit/place-mep-accessory-interactively';
export const DESKTOP_NATIVE_AWAIT_TOOL={type:'function',name:PREFIX+'await_interactive_placement',strict:false,
  description:'Consume the original pending native placement call and its actual receipt. If the placement tool already ended, await without sending another Escape. If it is still active after the requested placements, end it with Escape, then await. Pending dispatch is not proof the tool is ready; do not cancel preparation just to call await. Intentional cancellation remains available. This never starts or retries placement and does not itself verify connections or correctness.',
  parameters:{type:'object',properties:{},additionalProperties:false}};
type PendingNative = {result:Promise<unknown>;operationId:string|null;consumed:boolean;awaitClaimed:boolean;responses:Map<string,string>};
const pendingNative=new Map<string,PendingNative>();
function pendingKey(snapshot:AssignmentSnapshotV2):string {
  return canonicalJsonV2([getWorkspaceRoot(),snapshot.current_binding]);
}

/** The original native HTTP/MCP call stays pending and owns its existing
 * runtime leases. Only its input request can return early to the same owner.
 */
export async function executeDesktopNativeCall(binding:AssignmentKernelBindingInputV2,input:unknown):Promise<unknown> {
  const body=object(input), current=resolveOwner(binding), responseId=id(body.response_id);
  assertDesktopNativeProviderAccounting(current.snapshot,responseId);
  const selected=desktopNativeResponseCall(readDesktopResponse({...binding,kernelVersion:2},id(body.message_id)),responseId,id(body.call_id));
  const key=pendingKey(current.snapshot), pending=pendingNative.get(key);
  if(selected.tool==='await_interactive_placement') {
    if(Object.keys(selected.arguments).length||!pending||pending.consumed||pending.awaitClaimed)throw Error('desktop_native_owned_interaction_required');
    pending.awaitClaimed=true;
    // Native settlement and durable result retention, not a fabricated APPLY.
    // Awaiting even a failed/cancelled original call can never redispatch it.
    try{return await pending.result;}finally{pending.consumed=true;if(pendingNative.get(key)===pending)pendingNative.delete(key);}
  }
  if(pending&&!pending.consumed)throw Error('desktop_native_interaction_result_must_be_consumed');
  assertDesktopNativeState(current.snapshot,responseId);
  if(selected.tool!=='revit_call_tool'||selected.arguments.method!=='POST'||selected.arguments.path!==INTERACTIVE_PATH)
    return executeDesktopNativeCallSettled(binding,input);
  const signature=createHash('sha256').update(canonicalJsonV2({capability_id:'revit_call_tool',method:'POST',
    path:INTERACTIVE_PATH,body:selected.arguments.body??null}),'utf8').digest('hex');
  const call=withNativeInteractiveInvocation(current.snapshot.current_binding,signature,()=>executeDesktopNativeCallSettled(binding,input));
  const entry:PendingNative={result:call.result,operationId:null,consumed:false,awaitClaimed:false,responses:new Map()};
  pendingNative.set(key,entry);
  const dispatched=call.ready.then(operation=>{
    entry.operationId=operation.operation_id;
    return {schema:'operator.desktop-native-pending.v1',operation_id:operation.operation_id,
      deadline_at:operation.deadline_at,binding:current.binding,input_readiness:'unconfirmed',
      message:'The original native placement invocation is still in flight and may be queued or still preparing its preservation data. Dispatch does not prove input readiness. In the actual Revit UI, wait for placement mode and the requested accessory type before clicking the intended host. The previous selected pipe/duct Properties or a ribbon transition alone is insufficient. Do not press Escape to clear the previous selection while preparation is pending; that can cancel placement. Wait and inspect again while preparation continues, within the existing deadline. Once ready, place only the requested accessory. If the placement tool already ended, call await_interactive_placement without another Escape; if still active after the requested placements, Escape then await. Intentional cancellation and Pause remain available. No commit or verification is claimed. No other native call, save, report or completion is allowed until the original result is consumed.'};
  });
  const consumedWithoutInput=()=>{if(!entry.operationId){entry.consumed=true;if(pendingNative.get(key)===entry)pendingNative.delete(key);}};
  return Promise.race([call.result.then(result=>{consumedWithoutInput();return result;},error=>{
    consumedWithoutInput();throw error;
  }),dispatched]);
}

/** Read-only, authenticated control projection. It cannot recreate a pending
 * invocation after restart, admit a native call, or change canonical state. */
export function desktopNativeInteractionState(binding:AssignmentKernelBindingInputV2) {
  const current=resolveOwner(binding), entry=pendingNative.get(pendingKey(current.snapshot));
  const operation=nativeInteractiveInputOwnership.operationAwaitingInput(current.snapshot);
  return {schema:'operator.desktop-native-interaction.v1',publication:buildAssignmentKernelPublicationV2(current.snapshot),
    pending_result:Boolean(entry&&!entry.consumed),
    input_operation_id:entry&&!entry.consumed&&entry.operationId===operation?.operation_id?operation.operation_id:null};
}

/** Only the exact live invocation can supply a wait. A native placement result
 * may already be settled while its automatic independent read is still running.
 * Keep that original Promise and leave explicit result consumption unchanged.
 * No restored/client-authored state can manufacture a wait or provider grant. */
export function withDesktopNativeProviderReadiness<T>(binding:AssignmentKernelBindingInputV2,run:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
  const resolved=assignmentKernelV2ForBinding(binding);
  if(!resolved)return run(); // The ordinary provider boundary rejects stale bindings.
  const entry=pendingNative.get(pendingKey(resolved.snapshot));
  if(!entry||entry.consumed||!entry.operationId)return run();
  const current=resolveOwner(binding),op=current.snapshot.operations[entry.operationId];
  const readyForReadbackWait=op?.settlement_state==='settled'&&Boolean(op.result&&op.settled_at)
    &&!current.snapshot.terminal&&current.snapshot.outcome==='active'
    &&(!current.snapshot.execution_control||current.snapshot.execution_control.state==='running')
    &&!current.snapshot.unresolved_unknown_operation_ids.length;
  return afterNativeInteractiveReadback(readyForReadbackWait?entry.result:null,run,signal);
}

/** Provider tools are restricted while the same native result is outstanding.
 * Caller-supplied tools cannot turn this exception into another mutation lane. */
export function desktopNativeInteractionTools(binding:AssignmentKernelBindingInputV2,tools:unknown):unknown[]|null {
  const resolved=assignmentKernelV2ForBinding(binding);
  if(!resolved)return null;
  const entry=pendingNative.get(pendingKey(resolved.snapshot));
  if(!entry||entry.consumed)return null;
  const current=resolveOwner(binding);
  if(!Array.isArray(tools))throw Error('desktop_native_interaction_tools_required');
  // Native return may race the final computer_call_output. Preserve the tool
  // declaration until its original result is consumed. This is protocol
  // continuity only: operationAwaitingInput and the action-time ownership
  // checks still deny any new computer input after return, Pause or expiry.
  const running=!current.snapshot.execution_control||current.snapshot.execution_control.state==='running';
  const computer=running?tools.filter((tool:any)=>tool?.type==='computer'||tool?.type==='computer_use_preview'):[];
  return [...computer,DESKTOP_NATIVE_AWAIT_TOOL];
}

/** Only an actual accounted relay response can be recovered during the same
 * live invocation. Restart, native return, Pause or changed response content
 * loses this continuation without changing retained provider/native receipts. */
export function retainNativeInteractiveProviderResponse(binding:AssignmentKernelBindingInputV2,response:unknown):void {
  try {
  const current=resolveOwner(binding),entry=pendingNative.get(pendingKey(current.snapshot));
  if(!entry||entry.consumed)return;
  const value=object(response);
  assertDesktopNativeProviderAccounting(current.snapshot,id(value.id));
  if(value.status!=='completed'||value.model_call_receipt?.success!==true
    ||value.model_call_receipt?.route!=='desktop_computer'||value.model_call_receipt.call_id!==value.id
    ||value.provider_response_usage?.disposition!=='completed'
    ||value.provider_response_usage.session_id!==binding.session_id
    ||!value.provider_response_usage.raw_response_ids?.includes(value.id))return;
  entry.responses.set(value.id,createHash('sha256').update(canonicalJsonV2(value)).digest('hex'));
  }catch { /* A concurrent owner change must not discard an accounted provider response. No recovery grant is retained. */ }
}

export function desktopNativeInteractiveResponseAllowed(binding:AssignmentKernelBindingInputV2,record:ReturnType<typeof readDesktopResponse>):boolean {
  try {
    const current=resolveOwner(binding),entry=pendingNative.get(pendingKey(current.snapshot));
    const operation=nativeInteractiveInputOwnership.operationAwaitingInput(current.snapshot);
    if(!entry||entry.consumed||!operation||entry.operationId!==operation.operation_id||record?.status!=='complete')return false;
    const response=object(record.response);
    assertDesktopNativeProviderAccounting(current.snapshot,id(response.id));
    if(record.binding.assignment_id!==binding.assignment_id||record.binding.run_id!==binding.run_id
      ||record.binding.generation!==binding.generation||record.binding.session_id!==binding.session_id
      ||record.message_id!==response.provider_response_usage?.message_id)return false;
    return entry.responses.get(response.id)===createHash('sha256').update(canonicalJsonV2(response)).digest('hex');
  }catch{return false;}
}

async function executeDesktopNativeCallSettled(binding:AssignmentKernelBindingInputV2,input:unknown) {
  const body=object(input), messageId=id(body.message_id),responseId=id(body.response_id),callId=id(body.call_id);
  let current=resolve(binding,responseId);
  const storedBinding={...binding,kernelVersion:2 as const};
  const record=readDesktopResponse(storedBinding,messageId);
  const selected=desktopNativeResponseCall(record,responseId,callId);
  const root=getWorkspaceRoot();
  if(busy.has(root))throw Error('desktop_native_tool_already_active');
  busy.add(root);
  try {
    const runtime=getWorkspaceMcpRuntime(workspaceMcpRuntimes,root);
    if(runtime.hasAssignmentKernelV2Lease())throw Error('desktop_native_runtime_already_owned');
    const catalog=await runtime.getDynamicToolNamespace();
    const description=selected.tool==='describe_tool'?desktopNativeToolDescription(catalog.tools,selected.arguments):null;
    if(!description&&!catalog.tools.some((tool:Tool)=>tool.name===selected.tool))throw Error('desktop_native_tool_not_exposed');
    const auth=getRequestOperatorBackendAuth();
    if(!auth)throw Error('desktop_native_auth_required');
    const context=body.context&&typeof body.context==='object'&&!Array.isArray(body.context)?{...body.context}:{};
    delete context.desktop_helper_scope_v1; // A direct executor can never impersonate a scoped helper.
    const target=revitCourierTargetFromContext(context);
    if(process.env.OPERATOR_REVIT_TRANSPORT==='courier'&&!target.target_executor_id)
      throw Error('desktop_native_courier_target_required');
    current=resolve(binding,responseId);
    // Reuse durable once-only transport claims. Pending/error/completed claims
    // never redispatch. Canonical operation settlement is still in the handler.
    const transportId='native-call:'+createHash('sha256').update(canonicalJsonV2([responseId,callId])).digest('hex');
    return await retainDesktopResponse(storedBinding,transportId,{messageId,responseId,callId,selected,target},async()=>{
      if(description){
        const scope={session_id:binding.session_id,assignment_id:binding.assignment_id,run_id:binding.run_id,generation:binding.generation};
        return {schema:'operator.desktop-native-result.v1',result:description.success
          ?boundDesktopNativeToolContract(description.payload,scope,callId)
          :boundDesktopNativeOutput({success:false,contentItems:[{type:'inputText',text:JSON.stringify(description.payload)}]},scope,callId),stop_reason:null};
      }
      const turnId=responseId;
      const authLease=runtime.beginBackendAuthLease(binding.session_id,auth);
      let assignmentLease:ReturnType<typeof runtime.beginAssignmentKernelV2Lease>|null=null;
      let owner:ReturnType<typeof beginTeammateLoopOwner>|null=null;
      let courier:ReturnType<typeof beginRevitCourierTurnContext>=null;
      let stopReason:string|null=null;
      try {
        assignmentLease=runtime.beginAssignmentKernelV2Lease(current.binding);
        owner=beginTeammateLoopOwner(runtime,{version:OPERATOR_BACKEND_CONTRACT_VERSION,
          session_id:binding.session_id,message_id:messageId,assignment_id:binding.assignment_id,
          assignment_run_id:binding.run_id,assignment_generation:binding.generation,
          user_text:current.snapshot.spec.source_user_request,context}, {canonicalSupervisionOnly:true});
        runtime.bindBackendAuthLeaseTurn(authLease,turnId);
        runtime.bindAssignmentKernelV2LeaseTurn(assignmentLease,turnId);
        bindTeammateLoopOwnerTurn(owner,turnId);
        runtime.bindAssignmentKernelV2TurnStop(turnId,reason=>{stopReason=reason;});
        courier=beginRevitCourierTurnContext({session_id:binding.session_id,message_id:messageId,ttl_ms:600_000,...target});
        const result=await handleCodexDynamicToolCall(runtime,{id:callId,method:'item/tool/call',
          params:{namespace:'revit_operator',tool:selected.tool,arguments:selected.arguments,turnId}});
        runtime.flushAssignmentKernelV2TurnStop(turnId);
        return {schema:'operator.desktop-native-result.v1',result:boundDesktopNativeOutput(result as any,{
          session_id:binding.session_id,assignment_id:binding.assignment_id,run_id:binding.run_id,generation:binding.generation
        },callId),stop_reason:stopReason};
      }finally{
        endRevitCourierTurnContext(courier);
        runtime.clearAssignmentKernelV2TurnStop(turnId);
        endTeammateLoopOwner(owner);
        runtime.endAssignmentKernelV2Lease(assignmentLease);
        runtime.endBackendAuthLease(authLease);
      }
    },error=>({error:error instanceof Error?error.message:String(error)}));
  }finally{busy.delete(root);}
}
