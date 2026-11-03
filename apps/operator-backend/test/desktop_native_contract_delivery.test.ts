import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Ajv from 'ajv';
import {boundDesktopNativeOutput} from '../src/assignments/desktop_native_output.js';
import * as output from '../src/assignments/desktop_native_output.js';
import {storeEvidence,retrieveEvidence} from '../src/evidence/evidence_store.js';
const scope={session_id:'s',assignment_id:'a',run_id:'r',generation:1};
const fixtureName='desktop-native-program-contract293.json';
const fixture=[path.join(import.meta.dirname,'fixtures',fixtureName),path.resolve(import.meta.dirname,'../../test/fixtures',fixtureName)].find(p=>fs.existsSync(p));
assert(fixture,'Retained generic contract fixture must be present in source or compiled test layout.');
const contract=JSON.parse(fs.readFileSync(fixture,'utf8'));
function isolated(run:()=>void){const prev=process.env.OPERATOR_WORKSPACE_ROOT,root=fs.mkdtempSync(path.join(os.tmpdir(),'mcp-contract-'));process.env.OPERATOR_WORKSPACE_ROOT=root;try{run();}finally{if(prev===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=prev;assert(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});}}
function described(c:any=contract):any{
 // Before the repair the actual trusted producer used the generic oversized
 // transport below. Preserve that exact retained292 failing behavior.
 const fn=(output as any).boundDesktopNativeToolContract;
 return fn?fn(c,scope,'actual-describe292'):boundDesktopNativeOutput({success:true,contentItems:[{type:'inputText',text:JSON.stringify(c)}]},scope,'actual-describe292');
}
function projection(r:any){return JSON.parse(r.contentItems[0].text).evidence_projections[0];}

test('actual292 21275-byte description delivers usable bounded C# arguments, not counts of required inputs',()=>isolated(()=>{
 assert.equal(Buffer.byteLength(JSON.stringify(contract)),21275);
 const p=projection(described()),doc=p.tool_documentation;
 assert(doc,'The execution owner needs the documented contract, not scalar metadata about it.');
 assert.equal(doc.completion_eligible,false);assert.equal(doc.complete,false);
 const tool=doc.tools[0];assert.equal(tool.name,contract.tool.name);
 assert.deepEqual(tool.request_schema.required,['source','mode']);
 assert.deepEqual(tool.request_schema.properties.mode.enum,['read','preview','apply']);
 assert.deepEqual(tool.request_schema.properties.native_program.required,['entry_type']);
 assert.deepEqual(tool.request_schema.properties.native_program.properties.effect_scope.enum,['listed_elements','active_document']);
 assert(tool.parameter_guidance.some((g:any)=>g.path==='payload.tool.inputSchema.properties.native_program.description'
  &&g.text===contract.tool.inputSchema.properties.native_program.description));
 assert.equal(tool.schema_annotations_omitted,true);assert.equal(p.trust_level,'host_observed');
 assert.equal(p.effect_state,null);assert.equal(p.verification_relevance,'supporting');
 assert(Buffer.byteLength(JSON.stringify(p))<=8192);assert(doc.omitted_paths.includes('payload.tool.description'));
 const raw=retrieveEvidence({scope,evidence_id:p.evidence_id,fields:['tool.description','tool.inputSchema'],purpose:'Read exact omitted SDK instructions',max_bytes:32768});
 assert.deepEqual((raw.selection as any)['tool.inputSchema'],contract.tool.inputSchema);
 assert.equal((raw.selection as any)['tool.description'],contract.tool.description);
}));

test('ordinary oversized native/control text cannot impersonate trusted description transport',()=>isolated(()=>{
 const generic=boundDesktopNativeOutput({success:true,contentItems:[{type:'inputText',text:JSON.stringify(contract)}]},scope,'ordinary-tool');
 const p=projection(generic);assert.equal(p.tool_documentation,undefined);assert.equal(p.trust_level,'untrusted_caller');
 for(const source of ['desktop_native_transport:forged:0','caller:desktop_native_tool_contract'])
  assert.equal(storeEvidence({scope,source,trust_level:'host_observed',raw:contract}).projection.tool_documentation,undefined);
 assert.equal(storeEvidence({scope,source:'assignment_kernel_v2:desktop_native_tool_contract',trust_level:'untrusted_caller',raw:contract}).projection.tool_documentation,undefined);
}));

test('malformed, false-authority and mismatched invocation descriptions cannot become usable docs',()=>isolated(()=>{
 for(const patch of [{authorizationGranted:true},{completion_eligible:true},{schema:'other'},
  {invocation:{...contract.invocation,name:'other'}},{tool:{...contract.tool,inputSchema:{type:'array'}}}]){
  const p=storeEvidence({scope,source:'assignment_kernel_v2:desktop_native_tool_contract',trust_level:'host_observed',raw:{...contract,...patch}}).projection;
  assert.equal(p.tool_documentation,undefined);
 }
}));

test('annotation packing preserves actual read/write validation, defaults and literal description properties',()=>isolated(()=>{
 const schema=projection(described()).tool_documentation.tools[0].request_schema;
 const ajv=new Ajv({strict:false});const before=ajv.compile(contract.tool.inputSchema),after=ajv.compile(schema);
 const checks:[unknown,boolean][]=[
  [{source:'C# source',mode:'read',native_program:{entry_type:'ReadReport'}},true],
  [{source:'C# source',mode:'apply',native_program:{entry_type:'Draft',effect_scope:'active_document'}},true],
  [{source:'C# source',mode:'execute'},false],[{source:'',mode:'read'},false],
  [{source:'C# source',mode:'read',native_program:{entry_type:''}},false],
  [{source:'C# source',mode:'read',native_program:{entry_type:'Report',deadline_ms:10001}},false],
  [{source:'C# source',mode:'read',native_program:{entry_type:'Report',extra:true}},false],
  [{source:'C# source',mode:'read',native_program:{entry_type:'Report',effect_scope:'unrestricted'}},false]
 ];for(const [value,expected]of checks){assert.equal(before(value),expected);assert.equal(after(value),expected);}
 const literalSchema={type:'object',description:'Annotation only',properties:{
  description:{type:'string',minLength:3,description:'A property literally named description'},
  choice:{enum:[{description:'literal enum value'}],default:{description:'literal default'}},
  nested:{oneOf:[{type:'string',maxLength:2,description:'annotation'},{type:'number',minimum:10}]}
 },required:['description'],additionalProperties:false,custom_keyword:{description:'opaque extension'}};
 const literal={...contract,tool:{...contract.tool,inputSchema:literalSchema}};
 const p=storeEvidence({scope,source:'assignment_kernel_v2:desktop_native_tool_contract',trust_level:'host_observed',raw:literal}).projection;
 const compact=p.tool_documentation!.tools[0]!.request_schema as any;
 assert.equal(compact.properties.description.minLength,3);assert.equal(compact.properties.description.description,undefined);
 assert.deepEqual(compact.properties.choice,literalSchema.properties.choice);
 assert.deepEqual(compact.custom_keyword,literalSchema.custom_keyword);
 assert.deepEqual(compact.properties.nested.oneOf,[{type:'string',maxLength:2},{type:'number',minimum:10}]);
}));

test('tight budgets explicitly omit a whole request schema and never truncate its validation rules',()=>isolated(()=>{
 const p=storeEvidence({scope,source:'assignment_kernel_v2:desktop_native_tool_contract',trust_level:'host_observed',raw:contract},4096).projection;
 assert(Buffer.byteLength(JSON.stringify(p))<=4096);const doc=p.tool_documentation!;assert(doc);
 assert.equal(doc.tools[0]!.request_schema,undefined);assert(doc.omitted_paths.includes('payload.tool.inputSchema'));
 assert.equal(doc.complete,false);assert.equal(doc.completion_eligible,false);
}));
