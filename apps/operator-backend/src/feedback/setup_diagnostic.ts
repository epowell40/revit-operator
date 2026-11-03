import {getAssignmentKernelSnapshotV2} from '../assignments/assignment_kernel_v2_store.js';

export type SetupDiagnostic={schema:'operator.execution-setup-diagnostic.v1';message_id:string;phase:string;cause_code:string;message:string;
 provider_started:false;native_dispatch_this_request:false;assignment_id:string;run_id:string;generation:number;recorded_at?:string};

/** Backend diagnostic context only. Bind to this session's retained request;
 * an old generation or another task must not be presented as its cause. */
export function feedbackSetupDiagnostic(value:unknown,sessionId:string,userRequest:string):SetupDiagnostic|null {
 const d=value as SetupDiagnostic|null;
 if(!d||d.schema!=='operator.execution-setup-diagnostic.v1'||!['request_validation','runtime_setup','provider_start'].includes(d.phase)
  ||typeof d.cause_code!=='string'||!/^[A-Za-z0-9_-]{1,96}$/.test(d.cause_code)||typeof d.message!=='string'||!d.message.trim()||d.message.length>2000
  ||typeof d.message_id!=='string'||!d.message_id||d.message_id.length>240||typeof d.assignment_id!=='string'||d.assignment_id.length>240
  ||typeof d.run_id!=='string'||d.run_id.length>240||!Number.isSafeInteger(d.generation)||d.generation<1
  ||d.provider_started!==false||d.native_dispatch_this_request!==false)return null;
 const snapshot=getAssignmentKernelSnapshotV2(d.assignment_id),binding=snapshot?.current_binding;
 if(!snapshot||binding?.session_id!==sessionId||binding.run_id!==d.run_id||binding.generation!==d.generation
   ||snapshot.spec.source_user_request!==userRequest)return null;
 return {schema:d.schema,message_id:d.message_id,phase:d.phase,cause_code:d.cause_code,message:d.message,
  provider_started:false,native_dispatch_this_request:false,assignment_id:d.assignment_id,run_id:d.run_id,generation:d.generation,
  ...(typeof d.recorded_at==='string'&&Number.isFinite(Date.parse(d.recorded_at))?{recorded_at:d.recorded_at}:{})};
}
