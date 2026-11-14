import assert from 'node:assert/strict';import test from 'node:test';
import {installDesktopNativeTools,invokeDesktopNativeTool,desktopNativeBinding,singleExecutionInstructions} from './desktop_native_tools.mjs';
const assignment={kernel_version:2,session_id:'s',goal_id:'a',run_id:'r',generation:1};
test('same-owner documentation is delivered as context without adding native success or executing a tool',async()=>{
 const contract={schema:'operator.desktop-native-tool-contract.v1',completion_eligible:false,authorizationGranted:false,
  tool:{name:'operator_run_dynamic_revit_program',description:'Exact SDK guide',inputSchema:{type:'object'}}};
 const output=await invokeDesktopNativeTool({assignment,messageId:'message',responseId:'response',
  call:{name:'native__describe_tool',call_id:'call',arguments:'{"tool":"caller data must not be forwarded"}'},context:{},
  request:async(_route,opts)=>{assert.equal(JSON.parse(opts.body).arguments,undefined);return {schema:'operator.desktop-native-result.v1',
   result:{success:true,contentItems:[{type:'inputText',text:JSON.stringify(contract)}]},stop_reason:null};}});
 assert.deepEqual(JSON.parse(output.native_model_output.output[0].text),contract);
 assert.equal(output.native_model_output.native_success,undefined);
});
test('unified tools remove delegation and preserve UI/reviewer with exact native schemas',()=>{
 const schema={type:'object'};const tools=[{type:'function',name:'native__revit_ping',parameters:schema}];
 const result=installDesktopNativeTools([{name:'delegate_revit_task'},{name:'review_current_work'},{type:'computer'},{name:'queue_revit_batch_job'}],
  {schema:'operator.desktop-native-tools.v1',tools,guidance:'direct'});
 assert.deepEqual(result.map(t=>t.name),['review_current_work',undefined,'native__revit_ping']);assert.equal(result.at(-1).parameters,schema);
 assert.throws(()=>installDesktopNativeTools([],{schema:'operator.desktop-native-tools.v1',tools:[...tools,...tools],guidance:'direct'}));
});

test('successful attachment images carry a usable host call selector without changing source pixels or raw receipt',async()=>{
 const raw={success:true,contentItems:[{type:'inputText',text:JSON.stringify({attachment_id:'attachment',sha256:'a'.repeat(64),pages_returned:[1],coverage:[{page:1,visual_scope:'full_page'}]})},
  {type:'inputImage',imageUrl:'data:image/png;base64,AAAA'}]};
 const output=await invokeDesktopNativeTool({assignment,messageId:'m',responseId:'r',context:{},
  call:{name:'native__operator_read_attachment',call_id:'call_actual_read',arguments:JSON.stringify({attachment_id:'attachment',pages:[1]})},
  request:async()=>({schema:'operator.desktop-native-result.v1',result:raw,stop_reason:null})});
 const delivered=output.native_model_output.output;
 const selector=delivered.filter(c=>c.type==='input_text').map(c=>JSON.parse(c.text)).find(c=>c.schema==='operator.attachment-review-selector.v1');
 assert.deepEqual(selector?.reference_attachment_read_options,[{call_id:'call_actual_read',page:1}]);
 assert.equal(selector.native_postcondition_verified,false);assert.equal(selector.whole_task_verified,false);
 assert.equal(delivered.find(c=>c.type==='input_image').image_url,raw.contentItems[1].imageUrl);
 assert.deepEqual(JSON.parse(output.output).content,raw.contentItems);
});

for(const variant of ['failed','stopped','wrong_tool','wrong_attachment','missing_page','duplicate_page','no_image','ambiguous_summary','malformed_arguments'])test('attachment selector is omitted for '+variant,async()=>{
 const summary={attachment_id:'attachment',sha256:'a'.repeat(64),pages_returned:[1],coverage:[{page:1}]};
 const raw={success:variant!=='failed',contentItems:[]};
 if(variant==='wrong_attachment')summary.attachment_id='foreign';
 if(variant==='missing_page')summary.pages_returned=[2];
 if(variant==='duplicate_page')summary.pages_returned=[1,1];
 raw.contentItems.push({type:'inputText',text:JSON.stringify(summary)});
 if(variant==='ambiguous_summary')raw.contentItems.push({...raw.contentItems[0]});
 if(variant!=='no_image')raw.contentItems.push({type:'inputImage',imageUrl:'data:image/png;base64,AAAA'});
 const output=await invokeDesktopNativeTool({assignment,messageId:'m',responseId:'r',context:{},
  call:{name:variant==='wrong_tool'?'native__revit_ping':'native__operator_read_attachment',call_id:'call_actual',
    arguments:variant==='malformed_arguments'?'{':JSON.stringify({attachment_id:'attachment',pages:[1]})},
  request:async()=>({schema:'operator.desktop-native-result.v1',result:raw,stop_reason:variant==='stopped'?'paused':null})});
 assert.equal(output.native_model_output.output.some(c=>c.type==='input_text'&&c.text.includes('operator.attachment-review-selector.v1')),false);
 assert.deepEqual(JSON.parse(output.output).content,raw.contentItems);
});
test('host sends only identity/context, preserves native image blocks and does not manufacture authority',async()=>{
 let calls=0;
 const output=await invokeDesktopNativeTool({assignment,messageId:'message',responseId:'response',
  call:{name:'native__revit_ping',call_id:'call',arguments:'{"malicious":"not forwarded"}'},context:{revit:{}},
  request:async(route,opts)=>{calls++;assert.equal(route,'/api/assignments/v2/desktop-native/call');
   const body=JSON.parse(opts.body);assert.equal(body.arguments,undefined);assert.equal(body.tool,undefined);
   assert.equal(body.assignment_id,'a');return {schema:'operator.desktop-native-result.v1',result:{success:true,
    contentItems:[{type:'inputText',text:'actual native projection'},{type:'inputImage',imageUrl:'data:image/png;base64,AAA'}]},stop_reason:null};}});
 assert.equal(calls,1);assert.equal(output.native_model_output.output[1].image_url,'data:image/png;base64,AAA');
 assert.equal(JSON.parse(output.output).ok,true);assert.equal(output.native_model_output.native_success,undefined);
});
test('transport failure never invokes an automatic retry and missing host identity refuses',async()=>{
 let calls=0;const args={assignment,messageId:'message',responseId:'response',call:{name:'native__revit_ping',call_id:'call'},
  request:async()=>{calls++;throw Error('lost transport');}};
 await assert.rejects(invokeDesktopNativeTool(args),/lost transport/);assert.equal(calls,1);
 await assert.rejects(invokeDesktopNativeTool({...args,responseId:''}),/identity_required/);assert.equal(calls,1);
 assert.throws(()=>desktopNativeBinding({...assignment,kernel_version:1}));
});

test('unavailable documentation returns a failed tool output to the same owner without a terminal stop or native success',async()=>{
 const diagnostic={schema:'operator.desktop-native-tool-contract-unavailable.v1',requested_tool:'operator_get_assignment_status',
  completion_eligible:false,authorizationGranted:false,native_action_dispatched:false,code:'desktop_native_tool_not_exposed'};
 let calls=0;
 const output=await invokeDesktopNativeTool({assignment,messageId:'message',responseId:'response',
  call:{name:'native__describe_tool',call_id:'call',arguments:'{}'},context:{},
  request:async()=>{calls++;return {schema:'operator.desktop-native-result.v1',result:{success:false,
   contentItems:[{type:'inputText',text:JSON.stringify(diagnostic)}]},stop_reason:null};}});
 assert.equal(calls,1);assert.equal(JSON.parse(output.output).ok,false);
 assert.equal(output.native_stop_reason,null);assert.equal(output.native_model_output.native_success,undefined);
 assert.deepEqual(JSON.parse(output.native_model_output.output[0].text),diagnostic);
});

test('unified actor instructions require actual model pixels, not camera navigation as visual evidence',()=>{
 const text=singleExecutionInstructions('base','native');assert.match(text,/review_mode:observe/);assert.match(text,/activate_revit_view alone only navigates/);assert.match(text,/without another model call/);assert.match(text,/not a preview or verification/);
});

test('active unified edit instructions prefer one scoped inspection strategy and one applicable review while preserving evidence obligations',()=>{
 const text=singleExecutionInstructions('base','current catalog');
 assert.match(text,/choose one scoped inspection strategy/);
 assert.match(text,/Reuse the chosen inspection for independent post-edit readback/);
 assert.match(text,/Explicit preservation requirements still need relevant before\/after evidence/);
 assert.match(text,/scoped C# read when the typed contract lacks those fields/);
 assert.match(text,/null-safe category\/location access, not GetType\/reflection/);
 assert.match(text,/TextElement.BaseDirection and UpDirection, not a Rotation property/);
 assert.match(text,/Check Curve.IsBound before GetEndPoint or normalized Evaluate/);
 assert.match(text,/do not silently skip unsupported preservation fields/);
 assert.match(text,/one final review_current_work call/);
 assert.match(text,/recheck after relevant edits, uncertain results, or an uncovered UI requirement/);
 assert.match(text,/one concise report_work_for_review/);
});


test('advisory final review cannot confuse work-plan IDs with strict inspection closure',()=>{
 const legacy='Keep the final native inspection checklist item pending while a backend helper performs the edits and attribute checks; ask it to return a scoped handoff before completing that item. For the final review, pass complete_inspection_item_id naming the sole remaining declared inspection item; the host can submit its existing retained native reads through normal checklist validation after a current matched review.';
 const advisory=singleExecutionInstructions(legacy,'bound catalog','single_actor_review_v1');
 assert.doesNotMatch(advisory,/For the final review, pass complete_inspection_item_id/);
 assert.match(advisory,/work-plan item IDs are not native inspection IDs/);
 assert.match(singleExecutionInstructions(legacy,'bound catalog'),/pass complete_inspection_item_id/);
 const review={type:'function',name:'review_current_work',parameters:{type:'object',properties:{complete_inspection_item_id:{type:'string'},code_evidence_ids:{type:'array'},review_mode:{type:'string'}},required:['review_mode']}};
 const catalog={schema:'operator.desktop-native-tools.v1',execution_mode:'single_actor_review_v1',guidance:'bound',tools:[{type:'function',name:'native__read',parameters:{type:'object'}}]};
 const projected=installDesktopNativeTools([review],catalog)[0];
 assert.equal(projected.parameters.properties.complete_inspection_item_id,undefined);
 assert.equal(projected.parameters.properties.code_evidence_ids,review.parameters.properties.code_evidence_ids);
 assert.deepEqual(projected.parameters.required,['review_mode']);
 assert(review.parameters.properties.complete_inspection_item_id,'Original schema remains unchanged');
 assert.equal(installDesktopNativeTools([review],{...catalog,execution_mode:'strict'})[0],review);
 assert.equal(installDesktopNativeTools([review],{...catalog,execution_mode:undefined})[0],review);
});
test('detail reconstruction shares source-addressed tracking and correction rather than a percentage stop',()=>{
 const instructions=singleExecutionInstructions('base','native');
 assert.match(instructions,/2D details and diagrams/);
 assert.match(instructions,/components, linework and text/);
 assert.match(instructions,/operator_manage_work_plan.*locate/);
 assert.match(instructions,/known source gaps/);
 assert.match(instructions,/benchmark percentage is not a stopping rule/);
 assert.match(instructions,/not a bookkeeping call per element/);
});

