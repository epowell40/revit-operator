export const FOCUSED_EVIDENCE_TOOL_V1: Readonly<{type:'function';strict:false;name:'operator_retrieve_evidence';description:string;parameters:Record<string,unknown>}>;
export function focusedEvidenceFailureOutputV1(toolCall:unknown,functionOutput:unknown):{type:'function_call_output';call_id:string;output:string}|null;
export function retrieveFocusedEvidenceV1(currentOwner:()=>unknown,args:unknown,
  request:(path:string,options:{method:'POST';body:string})=>Promise<unknown>):Promise<{
    evidence_ref:Record<string,any>;
    model_output:{
      ok:true;schema:'operator.focused-evidence-read.v1';authority:'supporting_retained_evidence';read_only:true;
      native_postcondition_verified:false;whole_task_verified:false;source_identity:Record<string,any>;result:Record<string,any>;
    };
  }>;
