import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CodexAppServer } from "../src/codex/app_server.js";
import { CodexMcpToolRuntime } from "../src/codex/mcp_tool_runtime.js";
import { decideCodexStreaming, cancelCodexBrainTurn } from "../src/brains/codex_brain.js";
import { runWithRequestContext } from "../src/request_context.js";
import { createOperatorBackendAuth } from "../src/operator_backend_auth.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

test("same conversation handoff waits for the prior real brain's lease cleanup before provider start", async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-turn-handoff-"));
  const home=path.join(root,"home"); fs.mkdirSync(path.join(home,".codex"),{recursive:true});
  fs.writeFileSync(path.join(home,".codex/auth.json"),JSON.stringify({auth_mode:"chatgpt",tokens:{access_token:"fixture-only"}}));
  const names=["OPERATOR_WORKSPACE_ROOT","OPERATOR_BRAIN","OPERATOR_REVIT_TRANSPORT","OPERATOR_ASSIGNMENT_KERNEL_V2","OPERATOR_THIN_REFERENCE_SESSION_IDS","REVIT_OPERATOR_MODE"];
  const prior=Object.fromEntries(names.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{OPERATOR_WORKSPACE_ROOT:path.join(root,"workspace"),OPERATOR_BRAIN:"codex",OPERATOR_REVIT_TRANSPORT:"direct",OPERATOR_ASSIGNMENT_KERNEL_V2:"0",OPERATOR_THIN_REFERENCE_SESSION_IDS:"",REVIT_OPERATOR_MODE:"development"});
  const here=path.dirname(fileURLToPath(import.meta.url));
  const fixture=[path.join(here,"fixtures/codex_app_server_fixture.js"),path.join(here,"../../test/fixtures/codex_app_server_fixture.js")].find(fs.existsSync)!;
  const clients=new Set<CodexAppServer>();
  const ensure=CodexAppServer.prototype.ensureStarted;
  t.mock.method(os,"homedir",()=>home);
  t.mock.method(globalThis,"fetch",async()=>{throw Error("Unexpected network");});
  t.mock.method(CodexAppServer.prototype,"ensureStarted",async function(this:CodexAppServer){
    clients.add(this); const opts=(this as any).opts;
    opts.command=process.execPath;opts.commandPrefixArgs=[fixture];opts.spawnEnv={...opts.spawnEnv,CODEX_FIXTURE_STATE_PATH:path.join(root,"state.json"),CODEX_FIXTURE_TRACE_PATH:path.join(root,"trace.jsonl"),CODEX_FIXTURE_REUSE_ACTIVE_TURN:"1"};
    return ensure.call(this);
  });
  t.mock.method(CodexMcpToolRuntime.prototype,"getDynamicToolNamespace",async()=>({type:"namespace",name:"revit_operator",description:"fixture",tools:[]}));
  t.mock.method(CodexMcpToolRuntime.prototype,"callTool",async()=>{throw Error("Unexpected native dispatch");});
  const sequence:string[]=[];
  let firstBound!:()=>void; const bound=new Promise<void>(r=>firstBound=r);
  const bind=CodexMcpToolRuntime.prototype.bindBackendAuthLeaseTurn;
  t.mock.method(CodexMcpToolRuntime.prototype,"bindBackendAuthLeaseTurn",function(this:CodexMcpToolRuntime,lease:Parameters<typeof bind>[0],id:string){bind.call(this,lease,id);sequence.push("bound:"+id);firstBound();});
  const end=CodexMcpToolRuntime.prototype.endBackendAuthLease;
  t.mock.method(CodexMcpToolRuntime.prototype,"endBackendAuthLease",function(this:CodexMcpToolRuntime,lease:Parameters<typeof end>[0]){if(lease?.turn_id)sequence.push("ended:"+lease.turn_id);end.call(this,lease);});
  const start=CodexAppServer.prototype.startBoundTurn;
  t.mock.method(CodexAppServer.prototype,"startBoundTurn",function(this:CodexAppServer,...args:Parameters<typeof start>){sequence.push("start");return start.apply(this,args);});
  const request=(message_id:string,user_text:string)=>({version:"operator.backend.v1" as const,session_id:"handoff-session",message_id,user_text});
  let first:Promise<unknown>|undefined,second:Promise<unknown>|undefined;
  try {
    await runWithRequestContext({operator_backend_auth:createOperatorBackendAuth("shared_token","fixture-token")},async()=>{
      first=decideCodexStreaming(request("first","interrupt-me"),{});void first.catch(()=>{});
      await bound;
      const queued=decideCodexStreaming(request("cancel-queued","Do not start this cancelled successor"),{});
      void queued.catch(()=>{});
      assert.equal(cancelCodexBrainTurn("handoff-session","cancel-queued"),true);
      await assert.rejects(queued,/No successor provider or native work was started/);
      second=decideCodexStreaming(request("second","Finish the report"),{});void second.catch(()=>{});
      await new Promise(r=>setTimeout(r,80));
      assert.equal(sequence.filter(x=>x==="start").length,1,"Follow-up must not submit turn/start while the old turn owns its auth lease");
      assert.equal(cancelCodexBrainTurn("handoff-session","first"),true);
      await Promise.all([first,second]);
      assert.equal(sequence.filter(x=>x==="start").length,2);
      assert.ok(sequence.indexOf("ended:turn-fixture-1")<sequence.lastIndexOf("start"),JSON.stringify(sequence));
      assert.deepEqual(sequence.filter(x=>x.startsWith("bound:")),["bound:turn-fixture-1","bound:turn-fixture-2"]);
    });
  } finally {
    cancelCodexBrainTurn("handoff-session","first");cancelCodexBrainTurn("handoff-session","second");
    await Promise.allSettled([first,second]);for(const c of clients)await c.stopAndWait();
    __closeForTests();for(const [k,v]of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}t.mock.restoreAll();
    assert.equal(path.dirname(root),path.resolve(os.tmpdir()));fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:50});
  }
});
