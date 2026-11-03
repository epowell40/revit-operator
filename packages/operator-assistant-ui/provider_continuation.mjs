const keys=['assignment_id','session_id','run_id','generation'];
/** Provider continuation carries reasoning, not permission or native proof. */
export function providerContinuationInput(saved,binding,initialInput,profile){
 if(saved?.status==='unavailable')return {input:initialInput};
 if(saved?.status!=='ready'||!keys.every(k=>saved.binding?.[k]===binding?.[k])
   ||typeof saved.previous_response_id!=='string'||!saved.previous_response_id
   ||!Array.isArray(saved.input)||!saved.input.every(i=>['function_call_output','computer_call_output'].includes(i?.type)))
   throw Error('Saved provider continuation is incomplete or belongs to another task.');
 if(saved.model!==profile?.model||saved.reasoning_effort!==profile?.reasoning_effort)
   return {input:initialInput}; // A deliberate profile change starts fresh reasoning, never changes the requested profile.
 const latestUser=initialInput.findLast(i=>i?.role==='user');
 if(!latestUser)throw Error('Provider continuation requires the current user direction.');
 return {previous_response_id:saved.previous_response_id,input:[...saved.input,latestUser]};
}

export function providerCompletedToolOutputs(outputs){
 return outputs.filter(i=>['function_call_output','computer_call_output'].includes(i?.type));
}

/** Compaction is not a native revision or an instruction to recapture a
 * passing region. Literal images remain subject to existing scope/currentness. */
export const COMPACTED_VISUAL_CONTINUATION='The provider compacted earlier context. Keep the same task and saved work. Literal reference/model images may remain in the current input; reuse them only where existing image-delivery, scope and native-currentness checks admit them. Compaction alone does not require another capture. If pixels are missing, the model changed, or this is recovery, retrieve the relevant reference crop and fresh corresponding Revit pixels before the next spatial edit. Never infer precise image details from opaque compacted memory or a file path. Use the saved source-linked work record and native elements, reconcile interrupted work, then continue the next discrepancy without rediscovering the entire sheet or repeating construction.';
