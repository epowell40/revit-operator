import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {relayDesktopComputerResponse,desktopComputerErrorResponse} from '../src/desktop_computer.js';

test('provider request failures preserve a bounded diagnosis without raw provider content or retry',async()=>{
 const prior={key:process.env.OPERATOR_OPENAI_API_KEY,base:process.env.OPERATOR_OPENAI_BASE_URL};
 let message='No tool output found for function call call_private. secret=sk-private',calls=0;
 let providerType='invalid_request_error',parameter='input',requestId='req_diagnostic123';
 const server=http.createServer((_req,res)=>{calls++;res.writeHead(400,{'content-type':'application/json','x-request-id':requestId});res.end(JSON.stringify({error:{message,type:providerType,code:null,param:parameter}}));});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
 try {
  process.env.OPERATOR_OPENAI_API_KEY='synthetic-key';process.env.OPERATOR_OPENAI_BASE_URL=`http://127.0.0.1:${(server.address() as any).port}`;
  for(const [raw,reason] of [
   [message,'missing_tool_output'],
   ['No tool call found for function call output with call_id private.','unexpected_tool_output'],
   ['Previous response with id private not found.','previous_response_unavailable'],
   ['This model maximum context length was exceeded.','context_limit'],
   ['Invalid image in request: private bytes','invalid_image'],
   ['Unknown upstream failure with prompt=DO_NOT_EXPOSE and secret=sk-private','unclassified']
  ]) {
   message=raw;let failure:unknown;
   try{await relayDesktopComputerResponse({model:'gpt-6.1-terra',reasoning_effort:'medium',input:'private prompt'});}catch(e){failure=e;}
   assert(failure);const payload=desktopComputerErrorResponse(failure) as any;
   assert.deepEqual(payload.provider_diagnostic,{status:400,type:'invalid_request_error',reason,parameter:'input',request_id:'req_diagnostic123'});
   if(reason!=='unclassified')assert.match(payload.error,/HTTP 400/);
   assert.equal(payload.model_call_receipts[0].success,false);assert.equal(payload.model_call_receipts[0].tokens.total_tokens,null);
   for(const secret of ['call_private','private bytes','private prompt','DO_NOT_EXPOSE','sk-private'])assert(!JSON.stringify(payload).includes(secret));
  }
  assert.equal(calls,6,'One request per explicit test, no automatic failed-request replay');
  message='sensitive prompt=DO_NOT_EXPOSE';providerType='sk-private';parameter='input.secret';requestId='sk-private';
  let unsafe:unknown;try{await relayDesktopComputerResponse({model:'gpt-6.1-terra',input:'private'});}catch(e){unsafe=e;}
  const safe=desktopComputerErrorResponse(unsafe) as any;
  assert.deepEqual(safe.provider_diagnostic,{status:400,type:null,reason:'unclassified',parameter:null,request_id:null});
  assert(!JSON.stringify(safe).includes('sk-private'));assert(!JSON.stringify(safe).includes('DO_NOT_EXPOSE'));
  assert.deepEqual(desktopComputerErrorResponse(new Error('ordinary local error')),{error:'ordinary local error'});
 }finally{
  if(prior.key===undefined)delete process.env.OPERATOR_OPENAI_API_KEY;else process.env.OPERATOR_OPENAI_API_KEY=prior.key;
  if(prior.base===undefined)delete process.env.OPERATOR_OPENAI_BASE_URL;else process.env.OPERATOR_OPENAI_BASE_URL=prior.base;
  await new Promise<void>(r=>server.close(()=>r()));
 }
});
