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

