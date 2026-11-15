import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {createAuthProvider} from '../auth_provider.mjs';
const source=n=>fs.readFileSync(new URL(n,import.meta.url),'utf8');
test('standalone launch selects the shared embedded UI and exact local launcher',()=>{
 const start=source('../../../scripts/opencore/Start.ps1');
 assert.match(start,/OPERATOR_UI_MODE='embedded'/);
 assert.match(start,/OPERATOR_DESKTOP_LAUNCHER_PATH/);
 assert.match(start,/OPERATOR_TOOL_EXPOSURE_PROFILE='general'/);
 assert.match(start,/OPERATOR_ASSIGNMENT_KERNEL_V2='1'/);
});
test('standalone uses local credentials without opening a hosted token store',async()=>{
 const a=createAuthProvider({loadOperatorClientConfig:()=>({auth_mode:'shared_token'}),resolveBackendUrl:()=> 'http://127.0.0.1:7007',resolveOperatorToken:()=> 'fixture'});
 a.validateRuntime();assert.equal(a.status().signInRequired,false);assert.equal(a.status().sharedTokenAvailable,true);
 assert.equal(await a.loadOperatorAuthTokenSet(),null);assert.throws(()=>a.login('email','password'),/No account sign-in/);
 assert.throws(()=>a.persistOperatorAuthTokenSet({AccessToken:'foreign'}),/No account sign-in/);
});
test('foreign backend, credentials in URL, paths and account modes fail closed',()=>{
 for(const [url,mode] of [['https://remote.invalid','shared_token'],['http://name:password@127.0.0.1:7007','shared_token'],['http://127.0.0.1:7007/private','shared_token'],['http://127.0.0.1:7007','foreign-account']]){
  const a=createAuthProvider({loadOperatorClientConfig:()=>({auth_mode:mode}),resolveBackendUrl:()=>url,resolveOperatorToken:()=> 'fixture'});
  assert.throws(()=>a.validateRuntime(),/Standalone Operator requires/);assert.throws(()=>a.status(),/Standalone Operator requires/);
 }
});
test('public runtime excludes hosted account implementation and retains normal task UI',()=>{
 const auth=source('../auth_provider.mjs'),server=source('../server.js'),html=source('../public/index.html');
 // A generic account-route refusal is allowed; actual account/token implementation is private.
 assert.doesNotMatch(auth+server,/ProtectedData|loginClashPilotTokenSet|license_id|auth_refresh_recovery/);
 assert.match(html,/id="taskDrawer"/);assert.match(html,/id="agentModel"/);
 assert.doesNotMatch(html,/id="speed(?:Mode|Diet)"/);
});
