import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {savedComputerBinding,savedComputerConversation,selectComputerConversationForInput} from '../saved_computer_assignment.mjs';
import {providerContinuationInput} from '../provider_continuation.mjs';

test('actual restored input builder delivers checkpoint direction alongside cached provider state',()=>{
 const binding={assignment_id:'notes',session_id:'session',run_id:'run',generation:1};
 const direction='Change only the middle note to COORDINATE WITH STRUCTURAL. Keep the other two notes, their positions, and the border unchanged. Do not save yet.';
 const snapshot={current_binding:binding,spec:{source_user_request:'Create three notes and a border.'},input_values:{user_direction:direction},operations:{},input_invalidated_operation_ids:['old-write']};
 const goal={objective:snapshot.spec.source_user_request,work_budget:{}};
 const messages=savedComputerConversation(goal,snapshot,{session_id:'session',messages:[
  {role:'user',text:goal.objective},{role:'assistant',text:'Notes created with COORDINATE WITH ARCHITECT.'},{role:'user',text:direction}
 ]});
 messages.push({role:'user',text:'Continue the existing task using its saved answers and evidence.'});
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
 const start=source.indexOf('function buildComputerInput('),end=source.indexOf('\nasync function retainComputerProviderContext',start);
 assert(start>=0&&end>start);
 const bindingStart=source.indexOf('function browserComputerAssignmentBinding(');
 const bindingFunction=source.slice(bindingStart,source.indexOf('\n}\n',bindingStart)+2);
 const build=runInNewContext(bindingFunction+'\n'+source.slice(start,end)+';buildComputerInput',{
  computerState:{messages,sidecarAssignment:{...binding,goal_id:binding.assignment_id,kernel_version:2}},MAX_CONVERSATION_MESSAGES:8,savedComputerBinding,selectComputerConversationForInput,
  toComputerInputMessage:(m,o)=>({role:m.role,content:[{type:'input_text',text:m.text},...(o.includeCurrentScreen?[{type:'input_image',image_url:o.currentScreenDataUrl}]:[])]})
 });
 const input=build('fresh-screen'),profile={model:'gpt-6.1-sol',reasoning_effort:'high'};
 const saved={status:'ready',binding,previous_response_id:'prior-report-response',input:[{type:'function_call_output',call_id:'prior-report',output:'retained'}],...profile};
 const result=providerContinuationInput(saved,binding,input,profile);
 assert.equal(result.previous_response_id,'prior-report-response');
 assert.ok(result.input.some(m=>m.role==='user'&&m.content?.some(c=>c.type==='input_text'&&c.text===direction)));
 assert.ok(result.input.some(m=>m.role==='assistant'&&m.content?.some(c=>c.text.includes('user_direction'))));
 assert.equal(result.input.flatMap(m=>m.content??[]).filter(c=>c.type==='input_image').length,1);
 assert.equal(result.input.filter(m=>m.type==='function_call_output').length,1);
 assert.deepEqual(snapshot.input_invalidated_operation_ids,['old-write']);
});
