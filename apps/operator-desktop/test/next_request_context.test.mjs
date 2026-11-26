import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {runInNewContext} from 'node:vm';
import {savedComputerBinding,savedComputerConversation,browserComputerMessages,selectComputerConversationForInput} from '../saved_computer_assignment.mjs';

const server=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=server.indexOf('  if (nextRequestAfter) {',server.indexOf('app.post("/api/computer/run"'));
const restore=server.slice(start,server.indexOf('  // Admission and the exact-owned interactive release',start));
const buildStart=server.indexOf('function buildComputerInput(');
const build=server.slice(buildStart,server.indexOf('\n}\n',buildStart)+2);
const bindingStart=server.indexOf('function browserComputerAssignmentBinding(');
const bindingFunction=server.slice(bindingStart,server.indexOf('\n}\n',bindingStart)+2);

test('next objective keeps human chat without carrying the previous task-bound execution context',async()=>{
  const binding={assignment_id:'old-task',session_id:'same-chat',run_id:'old-run',generation:1};
  const history={session_id:'same-chat',messages:[{role:'user',text:'Read the levels'},{role:'assistant',text:'L2 is element 9946.'}]};
  const saved={executor:'computer',binding,goal:{objective:'Read the levels',work_budget:{}},
    snapshot:{current_binding:binding,operations:{},work_plan:{items:[]}}};
  const computerState={messages:[],sidecarAssignment:null,lastResponseId:'old-response',restoreProviderContext:true};
  const errors=[];
  const context={nextRequestAfter:binding,computerState,savedComputerBinding,savedComputerConversation,browserComputerMessages,selectComputerConversationForInput,
    readSavedAssignmentExecutor:async()=>saved,readBackendJson:async()=>history,
    sendJsonError:(_res,error)=>errors.push(error),res:{},MAX_CONVERSATION_MESSAGES:12,toComputerInputMessage:m=>m};
  await runInNewContext('(async()=>{'+restore+'})()',context);
  assert.equal(errors.length,0);
  // Production clears the idle assignment before admitting the next one. Neither
  // this point nor the new binding may adopt the old task's pinned context.
  const input=runInNewContext(bindingFunction+'\n'+build+';buildComputerInput',context);
  assert.deepEqual(JSON.parse(JSON.stringify(input(null))),history.messages);
  computerState.sidecarAssignment={goal_id:'new-task',session_id:'same-chat',run_id:'new-run',generation:1,kernel_version:2};
  computerState.messages.push({role:'user',text:'Rename L2 to L2-test'});
  assert.equal(input(null).at(-1).text,'Rename L2 to L2-test');
  assert.equal(computerState.backendSessionId,'same-chat');
  assert.equal(computerState.lastResponseId,null);
  assert.equal(computerState.restoreProviderContext,false);
  // Explicit Resume still requires its original exact owner.
  const resumed=savedComputerConversation(saved.goal,saved.snapshot,history);
  const currentBinding=runInNewContext('browserComputerAssignmentBinding()',context);
  assert.throws(()=>selectComputerConversationForInput(resumed,12,currentBinding),/binding changed/);
});
