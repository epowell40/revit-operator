import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleEvidenceHttpRoute } from "../src/evidence/evidence_http_routes.js";
import { storeEvidence } from "../src/evidence/evidence_store.js";

test("HTTP retrieval exposes grounded summary counts, missing fields and byte-limited page continuation", { concurrency: false }, async () => {
  const prior=process.env.OPERATOR_WORKSPACE_ROOT;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-inventory-http-"));
  process.env.OPERATOR_WORKSPACE_ROOT=root;
  const server=http.createServer(async(request,response)=>{
    if(!await handleEvidenceHttpRoute(request,response,new URL(request.url||"/","http://localhost"))){response.statusCode=404;response.end();}
  });
  try {
    await new Promise<void>((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
    const address=server.address(); assert.ok(address&&typeof address==="object");
    const scope={session_id:"inventory-session"};
    const items=Array.from({length:80},(_,i)=>({elementId:i+1,category:"Equipment",familyName:"Example",typeName:"Unit",description:"x".repeat(300)}));
    const stored=storeEvidence({scope,source:"native:inventory",trust_level:"authoritative_native",raw:{count:80,itemsComplete:true,items,actualNull:null}},4096);
    const retrieve=async(selector:Record<string,unknown>,requestedScope=scope)=>fetch(`http://127.0.0.1:${address.port}/evidence/retrieve`,{
      method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scope:requestedScope,evidence_id:stored.ref.evidence_id,purpose:"Inspect next equipment evidence",...selector})});
    const countResponse=await retrieve({fields:["inventory.total","inventory.complete","actualNull","missing"]});
    assert.equal(countResponse.status,200);
    const counts=await countResponse.json() as any;
    assert.deepEqual(counts.result.selection,{"inventory.total":80,"inventory.complete":true,actualNull:null,missing:null});
    assert.deepEqual(counts.result.missing_fields,["missing"]);
    const pageResponse=await retrieve({item_range:{path:"items",start:0,count:80},max_bytes:4096});
    assert.equal(pageResponse.status,200);
    const page=(await pageResponse.json() as any).result;
    assert.ok(page.pagination.byte_limited); assert.ok(page.pagination.has_more);
    assert.equal(page.pagination.next_start,page.selection.length);
    const nextResponse=await retrieve({item_range:{path:"items",start:page.pagination.next_start,count:80},max_bytes:4096});
    const next=(await nextResponse.json() as any).result;
    assert.equal(next.selection[0].elementId,page.selection.at(-1).elementId+1);
    const wrongScope=await retrieve({fields:["inventory.total"]},{session_id:"other-session"});
    assert.equal(wrongScope.status,400);
  } finally {
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    if(prior===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prior;
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test("evidence HTTP endpoints remain behind the shared-token authentication boundary", () => {
  const source = fs.readFileSync(path.resolve("src", "index.ts"), "utf8");
  const policy = source.slice(
    source.indexOf("function requiresOperatorToken(pathname: string): boolean {"),
    source.indexOf("function sessionOwnerForPrincipal(")
  );
  assert.match(policy, /pathname\.startsWith\("\/evidence\/"\)/);
});

test("caller evidence route cannot forge trust and stores admitted bytes as untrusted", { concurrency: false }, async () => {
  const prior = process.env.OPERATOR_WORKSPACE_ROOT;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "operator-evidence-http-"));
  process.env.OPERATOR_WORKSPACE_ROOT = root;
  const server = http.createServer(async (request, response) => {
    const handled = await handleEvidenceHttpRoute(request, response, new URL(request.url || "/", "http://localhost"));
    if (!handled) { response.statusCode = 404; response.end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const endpoint = `http://127.0.0.1:${address.port}/evidence/store`;
    const forged = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { session_id: "session-http" }, source: "caller", trust_level: "authoritative_native", raw_json: { count: 1 } })
    });
    assert.equal(forged.status, 400);
    assert.match(JSON.stringify(await forged.json()), /always untrusted/);

    const admitted = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: { session_id: "session-http" }, source: "caller", raw_json: { count: 1 } })
    });
    assert.equal(admitted.status, 201);
    const body = await admitted.json() as any;
    assert.equal(body.ref.trust_level, "untrusted_caller");
    assert.equal(body.projection.trust_level, "untrusted_caller");
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.OPERATOR_WORKSPACE_ROOT;
    else process.env.OPERATOR_WORKSPACE_ROOT = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
