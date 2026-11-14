/** The host binds transport identity; model arguments never supply assignment,
 * provider or native authority. Existing backend catalog schemas stay intact. */
/** Only the shell sets hostBudgetOwnsContinuation, after installing the bound
 * backend native catalog. This removes a duplicate legacy loop counter; every
 * request/action still requires the existing host budget and control admission.
 * It grants no turns, resources, permissions, success or automatic recovery. */
export function desktopComputerTurnAllowed(step,legacyMaxSteps,hostBudgetOwnsContinuation) {
  if(!Number.isSafeInteger(step)||step<1||!Number.isSafeInteger(legacyMaxSteps)||legacyMaxSteps<1
    ||typeof hostBudgetOwnsContinuation!=='boolean')throw Error('desktop_turn_policy_invalid');
  return hostBudgetOwnsContinuation||step<=legacyMaxSteps;
}

export function desktopNativeBinding(assignment) {
  if(assignment?.kernel_version!==2||!assignment.session_id||!(assignment.goal_id||assignment.assignment_id)
    ||!assignment.run_id||!Number.isSafeInteger(assignment.generation)||assignment.generation<1)
    throw Error('desktop_native_assignment_required');
  return {session_id:assignment.session_id,assignment_id:assignment.goal_id||assignment.assignment_id,
    run_id:assignment.run_id,generation:assignment.generation};
}
export function installDesktopNativeTools(existing,catalog) {
  if(catalog?.schema!=='operator.desktop-native-tools.v1'||!Array.isArray(catalog.tools)||!catalog.tools.length
    ||typeof catalog.guidance!=='string')throw Error('desktop_native_catalog_required');
  const names=new Set();
  for(const tool of catalog.tools) {
    if(tool?.type!=='function'||typeof tool.name!=='string'||!/^native__[A-Za-z0-9_]+$/.test(tool.name)
      ||tool.name.length>64||names.has(tool.name)||!tool.parameters||typeof tool.parameters!=='object')
      throw Error('desktop_native_catalog_invalid');
    names.add(tool.name);
  }
  // No second execution agent or supporting native shortcut in this mode.
  const removed=new Set(['delegate_revit_task','inspect_revit_context','run_dynamic_revit_program','export_revit_sheets_pdf','queue_revit_batch_job']);
  return [...existing.filter(tool=>!removed.has(tool.name)).map(tool=>{
    // Advisory work-plan claims have no strict inspection item to close. Hide only
    // that optional legacy argument; the host validator and review stay unchanged.
    if(catalog.execution_mode!=='single_actor_review_v1'||tool.name!=='review_current_work'
      ||!tool.parameters?.properties?.complete_inspection_item_id)return tool;
    if(tool.parameters.required?.includes('complete_inspection_item_id'))throw Error('advisory_review_contract_invalid');
    const {complete_inspection_item_id,...properties}=tool.parameters.properties;
    return {...tool,parameters:{...tool.parameters,properties}};
  }),...catalog.tools];
}
/** Keep the legacy UI lane intact while removing its executor handoff directions
 * from the unified lane. Tests inspect the actual assembled owner instructions. */
export function singleExecutionInstructions(instructions,guidance,executionMode) {
  if(executionMode==='single_actor_review_v1') {
    instructions=instructions.replaceAll('Keep the final native inspection checklist item pending while a backend helper performs the edits and attribute checks; ask it to return a scoped handoff before completing that item. ','')
      .replaceAll('For the final review, pass complete_inspection_item_id naming the sole remaining declared inspection item; the host can submit its existing retained native reads through normal checklist validation after a current matched review.','');
    guidance+='\nThis assignment uses the advisory work plan: work-plan item IDs are not native inspection IDs. Do not pass complete_inspection_item_id to visual review. Keep native readbacks, required independent visual/code review and save/file evidence; then record scoped work-plan claims and report_work_for_review once. Claims remain advisory, not host-verified completion. A failed review or unknown effect remains unresolved.';
  }
  guidance+='\nFor a bounded edit to existing text, labels or parameters, choose one scoped inspection strategy. Reuse a known typed contract; when required preservation fields need C#, use the directly exposed executor for one bounded read instead of first discovering and calling several overlapping readers. Typed inspection is not a prerequisite to custom code. If searching is needed, use a focused capability name such as find text notes, not a compound list of every requested property; includeSchemas=true returns the contract with the match. Reuse the chosen inspection for independent post-edit readback. Gather the requested values and preservation fields together, apply the known related edits in one supported batch, then compare those fields. Do not enumerate every view element, tessellate unrelated curves or duplicate a sufficient typed read with C# solely for reassurance. Explicit preservation requirements still need relevant before/after evidence; use a scoped C# read when the typed contract lacks those fields. In custom reads use supported Revit classes and null-safe category/location access, not GetType/reflection. TextNote orientation is TextElement.BaseDirection and UpDirection, not a Rotation property; preserve Coord, type and alignment as applicable. Check Curve.IsBound before GetEndPoint or normalized Evaluate: a full circle is an unbounded Arc, so read its Center, Radius and axes instead. Keep native values/units; do not silently skip unsupported preservation fields. Keep write receipts and independent actual result reads; a returned success or code review is not native verification. For drawing-content checks prefer capture_mode:native_visible_region; use visible_work for an actual application UI/display requirement. For displayed text, combine readability/overlap checks and any required executed-code review into one final review_current_work call. A current matched review covers only its checked region and conditions: reuse it when unchanged instead of another zoom, screenshot or reviewer call merely to confirm the same pixels. Obtain missing evidence or recheck after relevant edits, uncertain results, or an uncovered UI requirement. Then issue one concise report_work_for_review with actual findings and remaining limits; do not add an interim report or reopen completed inspection just for bookkeeping.';
  const changes=[
    ['Complete requested Revit work through delegate_revit_task using the current user objective, including simple model/view questions and PDF exports. That executor records native operations, verification and the saved outcome. inspect_revit_context is useful for orientation and progress, but its local result alone cannot finish a saved task. ','Complete requested Revit work directly through native__ tools using the full current user objective. The existing backend records native operations, verification and the saved outcome. A supporting context read alone cannot finish a saved task. '],
    ['Use delegate_revit_task for supported native load/assignment stages and verification','Use native__ tools for supported native load/assignment stages and verification'],
    ['instead of repeatedly sending the same discovery back to a native helper','instead of repeating the same discovery'],
    ['An unavailable helper filesystem search','An unavailable filesystem search'],
    ['Consume helper findings and proposed questions yourself. A helper or tool fault','Assess your retained findings and any missing decision. A tool fault'],
    ['For a strict saved task, delegate the complete export objective through delegate_revit_task so native execution, file evidence and completion are retained. For an advisory or unsaved helper, prefer export_revit_sheets_pdf. ','Use native__ tools for the complete export objective so native execution, file evidence and completion are retained. '],
    ['Use the delegate_revit_task function when the goal is to read from or write to the Revit model through deterministic RevitOperator actions instead of clicking the Revit UI. ',''],
    ['the delegated agent must run the available preview/dry-run operation','you must run the available native preview/dry-run operation'],
    ['Delegate the complete Revit objective','Use the native__ tools for the complete Revit objective'],
    ['Do not finish the saved task with inspect_revit_context alone. ','Do not finish the saved task from a supporting context read alone. '],
    ['Choose between context inspection and task delegation from the full user objective, not from individual nouns or verbs. ',''],
    ['If the task is a large repeated Revit workflow, prefer queue_revit_batch_job so the backend can persist, preview, pause, resume, and retry the work instead of exhausting the live step budget. ','Keep requested items in the existing native work plan and execute ready work serially in this context. '],
    ['have the executor retain that unfinished work','retain that unfinished work'],
    ['preserve this distinction when delegating','preserve this distinction throughout execution'],
    ['review the helper findings and retain your concise answer','retain your concise evidence-grounded answer'],
    ['Keep the final native inspection checklist item pending while a backend helper performs the edits and attribute checks; ask it to return a scoped handoff before completing that item. ','Keep the final native inspection checklist item pending while you perform edits and native attribute checks, until the required independent visual review. '],
    ['do not delegate another round merely for bookkeeping','do not start another execution round merely for bookkeeping'],
    ['A native helper can otherwise finish the shared task before this owner review. Its separate tool-free reviewer','The separate tool-free reviewer']
  ];
  for(const [before,after] of changes)instructions=instructions.replaceAll(before,after);
  return instructions+'\n'+guidance+'\nFor existing-condition reconstruction from a plan-only reference, an unshown elevation is not automatically a missing engineering decision. Unless the user requires exact field elevations, use an explicitly provisional above-ceiling elevation consistent with nearby existing work, with reasonable local clearance at crossings. Preserve the visible plan route, sizes, equipment and actual connections; record inferred heights and do not claim them as measured or field-verified. Honor stated elevations and real known obstructions. Do not invent capacities, airflows, system intent or ambiguous connections. A genuinely uncertain branch remains open while you construct other clear branches, devices or areas; it does not justify handing back the entire unfinished assignment. After one useful comparison and focused native query, perform a small supported construction/correction batch, inspect it and continue.'+'\nFor drawing reconstruction, prioritize missing physical devices, connected branches and sizes before cosmetic label alignment; use practical geometry, sizing/connection and annotation passes. A known unchecked annotation does not block clear independent construction. Obtain readable source and corresponding fresh model pixels before choosing a discrepancy. Use review_current_work with review_mode:observe and a delivered PDF detail reference; this returns images directly to you without another model call. It is observation, not a preview or verification. Use observed targets/neighbors for contextual focus; activate_revit_view alone only navigates and does not show you an image. During drafting, inspect your own results with review_mode:observe, preferably capture_mode:native_visible_region for current drawing geometry and text; visible_work is for actual application UI/display questions and may show delayed painting. Use the fresh native image with native readback to distinguish a model discrepancy from delayed screen painting. Genuine compaction preserves a bounded selection of actual image-tool observations with their original capture metadata. Do not reread an unchanged source crop or recapture unchanged model scope merely because text was compacted. Refresh model pixels after reopening, a relevant model/view change, or missing visual coverage; retained observations do not certify current state. Once a readable source/model pair is available, identify one concrete difference and follow it with a bounded native query or construction action. Do not alternate the same PDF crop, view activation and observation without new information. Preserve actual checked construction and your punch list. After SaveAs or a capture-mode change, obtain a fresh observation with the PDF reference rather than replaying a baseline from another session or capture kind. Do not repeat a confirmed edit merely because a screen has not repainted. Continue clear independent branches while recording a bounded unchecked item. Reserve independent review for a coherent area, branch milestone or final handoff, not each object. Do not repeatedly re-observe unchanged scope.'+'\nFor typical or repeated changes, keep the whole requested scope in this same context. Start from a compact inventory; do not request all sheet details or full parameter records in one discovery burst. Work one sheet or bounded group at a time, verify each group before moving on, and reuse its evidence. Use a supported native parameter batch for known targets when appropriate; avoid redundant per-cell reads. Preserve the complete requested scope and report the whole result once, including any unfinished groups. Chunking does not waive native checks, final appearance where required, SaveAs/file proof, Pause or unknown-effect safeguards.'
    +'\nFor reconstruction from drawings, keep a compact source-to-model outline of the visible devices, branches and connections within the existing work plan or working context. Include remaining endpoints, source ambiguities and stated assumptions; do not create a separate planning artifact or preview just for this outline. Complete one connected system in useful bounded stages before starting another when practical, rather than leaving every system at its main-run stage. Reuse retrieved tool schemas and native type/level/connector facts while they remain applicable. Use supported batches or requested custom code for known related work; inspect real results before dependent stages. Unfinished work alone is not a blocking decision: continue clear independent work and identify the actual source ambiguity, technical limit, user stop or budget boundary when returning a partial. Do not invent missing design values, repeat uncertain writes, or treat this strategy as verification or authority.'
    +'\nCheck off useful batches by source page, area and system using existing work-plan source_basis/location and edit/inspection items. Distinguish drafted (actual work exists) from backchecked (the named scope was compared against its source and applicable native/visual evidence); advisory claims remain unverified by the host. Keep an unfinished parent and its missing branches, devices, tags or notes open when a smaller batch passes. Record evidence and omissions at useful batch boundaries, not a bookkeeping call per element. On continuation, resume the saved model and retained punch list; inspect changed or uncertain scope before dependent work instead of rebuilding or rediscovering completed areas. Counts help find omissions, not prove source coverage. A later relevant change needs an affected-scope backcheck; existing evidence currentness rules still govern reuse. At a genuine handoff, retain source-addressed completed work, unchecked work and omissions through the existing report/followups; a partial report is not a whole-task pass. Do not erase prior failed checks, manufacture completion claims or repeat edits to obtain checklist credit.';
}
export async function invokeDesktopNativeTool({assignment,messageId,responseId,call,context,request}) {
  if(!call?.name?.startsWith('native__')||!messageId||!responseId||!call.call_id)
    throw Error('desktop_native_provider_identity_required');
  const result=await request('/api/assignments/v2/desktop-native/call',{method:'POST',body:JSON.stringify({
    ...desktopNativeBinding(assignment),message_id:messageId,response_id:responseId,call_id:call.call_id,context})});
  if(result?.schema==='operator.desktop-native-pending.v1') {
    const binding=desktopNativeBinding(assignment);
    if(!Object.keys(binding).every(key=>result.binding?.[key]===binding[key])||!result.operation_id||!result.deadline_at)
      throw Error('desktop_native_pending_binding_invalid');
    const output={type:'function_call_output',call_id:call.call_id,output:JSON.stringify(result)};
    Object.defineProperty(output,'native_pending',{value:result});
    Object.defineProperty(output,'native_model_output',{value:output});
    return output;
  }
  if(result?.schema!=='operator.desktop-native-result.v1'||!Array.isArray(result.result?.contentItems)
    ||typeof result.result.success!=='boolean')throw Error('desktop_native_response_invalid');
  const content=result.result.contentItems.map(item=>{
    if(item?.type==='inputText'&&typeof item.text==='string')return {type:'input_text',text:item.text};
    if(item?.type==='inputImage'&&typeof item.imageUrl==='string')return {type:'input_image',image_url:item.imageUrl,detail:'original'};
    throw Error('desktop_native_content_invalid');
  });
  // Images stay images. A transport/parser failure must not trigger redispatch.
  const output={type:'function_call_output',call_id:call.call_id,output:JSON.stringify({ok:result.result.success,
    native_stop_reason:result.stop_reason??null,content:result.result.contentItems})};
  Object.defineProperty(output,'native_model_output',{value:{type:'function_call_output',call_id:call.call_id,output:content}});
  Object.defineProperty(output,'native_stop_reason',{value:result.stop_reason??null});
  return output;
}



