import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendEvent, __closeForTests } from '../src/memory/sqlite_store.js';
import { runWithRequestContext, type RequestPrincipal } from '../src/request_context.js';

const secret='instruction-binding-test-secret';
function headers(user: string) {
  const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const payload=Buffer.from(JSON.stringify({sub:user,user_id:user,tenant_id:'binding-tenant',roles:['user'],iat:Math.floor(Date.now()/1000)-5,exp:Math.floor(Date.now()/1000)+300})).toString('base64url');
  const signature=createHmac('sha256',secret).update(`${header}.${payload}`).digest('base64url');
  return {authorization:`Bearer ${header}.${payload}.${signature}`};
}
async function fixture(t: any, mode: string) {
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'ib-'));
  const old=process.env.OPERATOR_WORKSPACE_ROOT; process.env.OPERATOR_WORKSPACE_ROOT=workspace; __closeForTests();
  const port=await new Promise<number>(resolve=>{const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const port=(server.address() as net.AddressInfo).port;server.close(()=>resolve(port));});});
  const child=spawn(process.execPath,['--import','tsx','src/index.ts'],{cwd:process.cwd(),env:{...process.env,OPERATOR_BACKEND_PORT:String(port),OPERATOR_AUTH_MODE:mode,OPERATOR_TOKEN:secret,OPERATOR_JWT_SECRET:secret,OPERATOR_JWT_TENANT_ID_CLAIM:'tenant_id',OPERATOR_JWT_ISSUER:'',OPERATOR_JWT_AUDIENCE:'',OPERATOR_WORKSPACE_ROOT:workspace,OPERATOR_BRAIN:'rule'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>{output+=b;});child.stderr.on('data',b=>{output+=b;});
  t.after(async()=>{if(child.exitCode===null){child.kill();await new Promise(resolve=>child.once('exit',resolve));}__closeForTests();if(old===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=old;fs.rmSync(workspace,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${port}`;const deadline=Date.now()+20000;let ready=false;
  while(Date.now()<deadline){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(base+'/health',{headers:mode==='shared_token'?{'x-operator-token':secret}:headers('owner')})).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,40));}
  assert.ok(ready,output);return base;
}
test('instruction binding HTTP requires shared token and explicit session',async t=>{
  const base=await fixture(t,'shared_token');
  assert.equal((await fetch(base+'/codex/instruction-bindings?session_id=private')).status,401);
  assert.equal((await fetch(base+'/codex/instruction-bindings',{headers:{'x-operator-token':secret}})).status,400);
});
test('instruction binding HTTP scopes principal sessions and projects hashes without stored secrets',async t=>{
  const base=await fixture(t,'principal_jwt');
  const create=async()=>{const response=await fetch(base+'/session/new',{method:'POST',headers:headers('owner')});assert.equal(response.status,200);return (await response.json() as any).session_id as string;};
  const session=await create(), otherSession=await create();
  const principal:RequestPrincipal={sub:'owner',user_id:'owner',tenant_id:'binding-tenant',license_id:'binding-tenant',roles:['user'],tier:null,claims:{}};
  const binding={schema:'revit-operator.host-supplied-instructions/v1',source:'host_supplied_acknowledged',prompt_sha256:'a'.repeat(64),system_instruction_sha256:'b'.repeat(64),prompt:'DO NOT EXPOSE PROMPT',token:'DO NOT EXPOSE TOKEN',benchmark_runtime:{schema:'test',configured:true,status:'configured',backend_instance_id:'instance',process_id:123,envelope_sha256:'c'.repeat(64),run_id:'run',prompt_sha256:'a'.repeat(64),system_instruction_sha256:'b'.repeat(64),path:'DO NOT EXPOSE PATH'}};
  runWithRequestContext({principal},()=>{
    appendEvent(session,'assistant','codex.turn.start',{session_id:session,message_id:'message-own',thread_id:'thread-own',turn_id:'turn-own',host_instruction_binding:binding,prompt:'DO NOT EXPOSE OUTER'});
    appendEvent(otherSession,'assistant','codex.turn.start',{session_id:otherSession,message_id:'other-message',turn_id:'other-turn',host_instruction_binding:binding});
  });
  assert.equal((await fetch(base+`/codex/instruction-bindings?session_id=${session}`,{headers:headers('different-owner')})).status,403);
  assert.equal((await fetch(base+'/codex/instruction-bindings',{headers:headers('owner')})).status,400);
  assert.equal((await fetch(base+`/codex/instruction-bindings?session_id=${session}&started_at=invalid`,{headers:headers('owner')})).status,400);
  const response=await fetch(base+`/codex/instruction-bindings?session_id=${session}`,{headers:headers('owner')});assert.equal(response.status,200);
  const payload=await response.json() as any;
  assert.equal(payload.session_id,session);assert.equal(payload.complete,true);assert.equal(payload.turns.length,1);assert.equal(payload.turns[0].turn_id,'turn-own');
  assert.equal(payload.turns[0].host_instruction_binding.prompt_sha256,'a'.repeat(64));
  assert.doesNotMatch(JSON.stringify(payload),/DO NOT EXPOSE|other-turn|other-message/);
  assert.deepEqual(Object.keys(payload.turns[0]).sort(),['session_id','message_id','thread_id','turn_id','host_instruction_binding'].sort());
});
