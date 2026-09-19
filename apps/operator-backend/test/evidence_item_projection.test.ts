import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { storeEvidence, retrieveEvidence, readEvidenceRef, readAuthoritativeEvidence } from "../src/evidence/evidence_store.js";
import { __closeForTests } from "../src/memory/sqlite_store.js";

const scope={session_id:"projection-session",assignment_id:"projection-assignment",run_id:"projection-run",attempt_id:"native-read",generation:2};
function fixture(t: test.TestContext,items: unknown[]){
 const previous=process.env.OPERATOR_WORKSPACE_ROOT;
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"operator-row-projection-"));
 process.env.OPERATOR_WORKSPACE_ROOT=root;
 t.after(()=>{__closeForTests();if(previous===undefined)delete process.env.OPERATOR_WORKSPACE_ROOT;else process.env.OPERATOR_WORKSPACE_ROOT=previous;fs.rmSync(root,{recursive:true,force:true});});
 const stored=storeEvidence({scope,source:"native-inventory",trust_level:"authoritative_native",raw:{items,count:items.length}});
 const read=(item_range: {path:string;start:number;count:number;fields?:string[]},extra:Record<string,unknown>={})=>retrieveEvidence({scope,evidence_id:stored.ref.evidence_id,purpose:"Review routing columns",max_bytes:100000,item_range,...extra});
 return {stored,read};
}

test("projected native inventory preserves every identity and source bytes inside a bounded page",t=>{
 const rows=Array.from({length:113},(_,id)=>({id,category:"OST_DuctCurves",geometry:{start:[id,0,10],end:[id,12,10]},parameters:{diameter:1/3},unneededMetadata:"x".repeat(6000)}));
 const {stored,read}=fixture(t,rows),before=readAuthoritativeEvidence(stored.ref,scope);
 const page=read({path:"payload.items",start:0,count:113,fields:["id","category","geometry","parameters.diameter"]});
 const selected=page.selection as Array<{row_index:number;values:Record<string,unknown>}>;
 assert.equal(selected.length,113);assert(page.returned_bytes<100000);
 assert.deepEqual(selected.map(x=>x.values.id),rows.map(x=>x.id));assert.deepEqual(selected.map(x=>x.row_index),rows.map(x=>x.id));
 assert.equal(page.complete,false);assert.equal(page.pagination?.has_more,false);
 assert.equal(page.pagination?.requested_rows_complete,true);
 assert.equal(page.pagination?.source_rows_exhausted,true);
 assert.equal(page.pagination?.row_projection,"selected_fields");
 assert.equal(readEvidenceRef(stored.ref.evidence_id).content_hash,stored.ref.content_hash);
 assert.deepEqual(readAuthoritativeEvidence(stored.ref,scope),before);
});

test("projected pagination accounts for row wrappers and resumes without omissions or duplicates",t=>{
 const {read}=fixture(t,Array.from({length:9},(_,id)=>({id,name:"room "+id})));
 const collected:number[]=[];let start=0;
 for(let pages=0;pages<10;pages++){
  const page=read({path:"items",start,count:9,fields:["id","name"]},{max_bytes:180});
  assert(page.returned_bytes<=180);assert.equal(page.complete,false);
  assert.equal(page.pagination?.requested_rows_complete,page.pagination?.byte_limited===false);
  assert.equal(page.pagination?.source_rows_exhausted,page.pagination?.has_more===false);
  collected.push(...(page.selection as Array<{row_index:number}>).map(x=>x.row_index));
  if(!page.pagination?.has_more)break;
  assert(page.pagination.next_start!>start);start=page.pagination.next_start!;
 }
 assert.deepEqual(collected,[0,1,2,3,4,5,6,7,8]);
});

test("projected rows distinguish absent columns from null and preserve literal dotted keys",t=>{
 const {read}=fixture(t,[{id:7,actualNull:null,nested:{x:3},"nested.x":42}]);
 assert.deepEqual(read({path:"payload.items",start:0,count:1,fields:["id","actualNull","absent","nested.x"]}).selection,
  [{row_index:0,values:{id:7,actualNull:null,absent:null,"nested.x":42},missing_fields:["absent"]}]);
 for(const field of ["__proto__","constructor","nested.prototype","nested[process.exit()]"])
  assert.throws(()=>read({path:"items",start:0,count:1,fields:[field]}),/Invalid typed field path/);
});

test("projection cannot bypass scope, selector validation or row size limits",t=>{
 const {read}=fixture(t,[{id:1,value:"x".repeat(1000)}]);
 for(const patch of [{session_id:"foreign"},{assignment_id:"foreign"},{run_id:"foreign"},{generation:3}])
  assert.throws(()=>read({path:"items",start:0,count:1,fields:["id"]},{scope:{...scope,...patch}}),/scope|session|assignment|run|generation/i);
 for(const fields of [null,[],[""],["id"," id "],Array(65).fill("id"),[false],["x".repeat(513)],["id\n"]])
  assert.throws(()=>read({path:"items",start:0,count:1,fields:fields as any}),/selector_invalid/);
 assert.throws(()=>read({path:"items",start:0,count:1,fields:["value"]},{max_bytes:64}),/One evidence row exceeds/);
 assert.equal(read({path:"items",start:0,count:1}).complete,true,"legacy unprojected full read remains complete");
});
