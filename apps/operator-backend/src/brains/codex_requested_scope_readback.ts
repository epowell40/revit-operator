import type { CodexMcpToolRuntime } from '../codex/mcp_tool_runtime.js';
import type { CodexServerRequest } from '../codex/app_server.js';
import type { AssignmentKernelTurnBindingV2 } from '../assignments/assignment_kernel_v2_factory.js';
import { getAssignmentKernelSnapshotV2 } from '../assignments/assignment_kernel_v2_store.js';
import { collectRequestedFamilyScopeReadbacksV1 } from '../verification/requested_family_scope_readback_v1.js';
import { canonicalJsonV2 } from '../domain/assignment-kernel/index.js';

/** Control-tool adapter only; the supplied dispatcher retains all ordinary
 * schema/owner/pause/admission/budget/native-settlement checks for each read. */
export async function codexRequestedScopeReadbackV1(input:{runtime:CodexMcpToolRuntime;request:CodexServerRequest;
 binding:AssignmentKernelTurnBindingV2;session_id:string;arguments:any;dispatch:(r:CodexServerRequest)=>Promise<unknown>}) {
 const a=input.arguments;
 if(input.request.params?.tool!=='operator_manage_work_plan'||a?.action!=='check_scope'||a.operationIds!==undefined)return null;
 const current=getAssignmentKernelSnapshotV2(input.binding.assignment_id);
 const scope=[...(current?.work_plan_scope_requests??[])].reverse().find(r=>r.item_id===a.itemId);
 if(!scope||canonicalJsonV2(scope.scope)!==canonicalJsonV2(a.scopeCheck))return null;
 return collectRequestedFamilyScopeReadbacksV1(input.binding,scope,{
  current:()=>getAssignmentKernelSnapshotV2(input.binding.assignment_id),
  read:(plan,id)=>input.dispatch({id,method:'item/tool/call',params:{namespace:'revit_operator',tool:'revit_call_tool',
    turnId:input.request.params?.turnId,threadId:input.request.params?.threadId,arguments:plan}}),
  refresh:async ids=>{
   const args={...a,operationIds:[...ids]};await input.runtime.validateToolArguments?.('operator_manage_work_plan',args);
   return input.runtime.callTool('operator_manage_work_plan',args,{turnId:input.request.params?.turnId,
    sessionId:input.session_id,assignmentKernelV2Binding:input.binding});
  }
 });
}
