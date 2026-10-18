import test from 'node:test';import assert from 'node:assert/strict';
import http from 'node:http';import path from 'node:path';import os from 'node:os';import fs from 'node:fs';import {createHash} from 'node:crypto';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {retainedImageDelivery} from './retainedImageDelivery.js';

test('retained pixels require exact scope/hash/count, complete media and the requested byte budget',()=>{
 const bytes=Buffer.alloc(96,19),data=bytes.toString('base64'),request={evidenceId:'ev1_'+'a'.repeat(32),sessionId:'image-session',assignmentId:'work',runId:'run',generation:1};
 const ref={evidence_id:request.evidenceId,session_id:request.sessionId,assignment_id:'work',run_id:'run',generation:1,media_type:'image/jpeg',byte_count:96,content_hash:'sha256:'+createHash('sha256').update(bytes).digest('hex')};
 const make=()=>({ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:{...ref},selection:{media_type:'image/jpeg',data_base64:data},complete:true}});
 assert.equal(retainedImageDelivery(make(),request).content[1]?.type,'image');
 for(const change of [(r:any)=>r.result.evidence_ref.session_id='foreign',(r:any)=>r.result.evidence_ref.assignment_id='foreign',
  (r:any)=>r.result.evidence_ref.run_id='foreign',(r:any)=>r.result.evidence_ref.generation=2,(r:any)=>r.result.evidence_ref.byte_count=95,
  (r:any)=>r.result.evidence_ref.byte_count=5*1024*1024+1,(r:any)=>r.result.evidence_ref.content_hash='sha256:'+'0'.repeat(64),
  (r:any)=>r.result.complete=false,(r:any)=>r.result.selection.media_type='image/svg+xml',(r:any)=>r.result.selection.data_base64+='!']){
   const r=make();change(r);assert.throws(()=>retainedImageDelivery(r,request));
 }
 assert.throws(()=>retainedImageDelivery(make(),{...request,maxBytes:64}));
});

test('actual MCP retained-image tool emits pixels and short provenance, not base64 text',async()=>{
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
 const digest='sha256:'+createHash('sha256').update(bytes).digest('hex');let mode='good';const requests:any[]=[];
 const ref={schema:'revit-operator.evidence-ref.v1',evidence_id:'ev1_'+ 'a'.repeat(32),content_hash:digest,byte_count:bytes.length,media_type:'image/png',session_id:'image-session',assignment_id:null,trust_level:'untrusted_caller'};
 const backend=http.createServer(async(req,res)=>{const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));requests.push(JSON.parse(Buffer.concat(chunks).toString()));
  assert.equal(req.url,'/evidence/retrieve');res.setHeader('content-type','application/json');res.end(JSON.stringify({ok:true,result:{schema:'revit-operator.evidence-retrieval.v1',evidence_ref:mode==='forged'?{...ref,content_hash:'sha256:'+'0'.repeat(64)}:ref,selection:{media_type:'image/png',data_base64:bytes.toString('base64')},complete:true,returned_bytes:160}}));});
 await new Promise<void>(resolve=>backend.listen(0,'127.0.0.1',resolve));const address=backend.address();assert(address&&typeof address!=='string');
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'retained-image-stdio-'));
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(process.cwd(),'dist/server.js')],cwd:process.cwd(),stderr:'pipe',
  env:{...process.env,REVIT_OPERATOR_MODE:'development',OPERATOR_TOOL_EXPOSURE_PROFILE:'laboratory',OPERATOR_TOKEN:'p'.repeat(32),OPERATOR_AUTH_MODE:'shared_token',OPERATOR_OPENAI_API_KEY:'test-only',OPERATOR_WORKSPACE_ROOT:workspace,LOCALAPPDATA:workspace,OPERATOR_API_BASE_URL:`http://127.0.0.1:${address.port}`}});
 transport.stderr?.on('data',()=>{});const client=new Client({name:'retained-image-canary',version:'1.0.0'},{capabilities:{}});
 try{await client.connect(transport);const args={evidenceId:ref.evidence_id,sessionId:'image-session',purpose:'Inspect retained diagram pixels',image:true};
  const result:any=await client.callTool({name:'operator_retrieve_evidence',arguments:args});assert.notEqual(result.isError,true);
  const images=result.content.filter((c:any)=>c.type==='image');assert.equal(images.length,1);assert.equal((images[0] as any).data,bytes.toString('base64'));
  const text=result.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text).join('\n');assert(!text.includes(bytes.toString('base64')));assert(text.length<4096);
  const meta=JSON.parse(text);assert.deepEqual(meta.result.evidence_ref,ref);assert.equal(meta.result.image_delivery.available,true);
  const tools=await client.listTools();const schema:any=tools.tools.find(t=>t.name==='operator_retrieve_evidence')!.inputSchema;assert.equal(schema.properties.maxBytes.maximum,5*1024*1024);
  mode='forged';const forged:any=await client.callTool({name:'operator_retrieve_evidence',arguments:args});assert.equal(forged.isError,true);assert(!forged.content.some((c:any)=>c.type==='image'));
  assert.equal(requests.length,2);assert(requests.every(r=>r.scope.session_id==='image-session'&&r.image===true));
 }finally{await client.close();await new Promise<void>(resolve=>backend.close(()=>resolve()));fs.rmSync(workspace,{recursive:true,force:true});}
});
