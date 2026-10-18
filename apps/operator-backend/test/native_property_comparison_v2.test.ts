import assert from 'node:assert/strict';import test from 'node:test';
import {nativePropertyComparisonV2}from '../src/verification/native_property_comparison_v2.js';
const setter={method:'POST',path:'/revit/set-parameter',body:{changes:[{elementId:42,parameterName:'Comments',value:'CHECK ME'}],dryRun:false}};
const read={method:'POST',path:'/revit/get-parameters',body:{elementIds:[42],names:['Comments']}};
const payload=(text='CHECK ME')=>({items:[{id:42,uniqueId:'actual-element-42',parameters:{Comments:text}}]});
test('native scalar comparison shows a concrete parameter mismatch and remains distinct from completion proof',()=>{
 const c=nativePropertyComparisonV2(setter,read,payload('OTHER'));
 assert.equal(c.state,'mismatch');assert.deepEqual(c.differences,[{subject:'target_property:"42":comments',expected:['"CHECK ME"'],observed:['"OTHER"']}]);
 assert.equal(nativePropertyComparisonV2(setter,read,payload()).state,'matched');
});
test('expected text uses the existing native drafting policy, with explicit preserved-case respected',()=>{
 const a={...setter,body:{changes:[{elementId:42,parameterName:'Comments',value:'Check me'}]}};
 assert.equal(nativePropertyComparisonV2(a,read,payload()).state,'matched');
 assert.equal(nativePropertyComparisonV2({...a,body:{...a.body,preserveTextCase:true}},read,payload()).state,'mismatch');
});
for(const[name,alter]of Object.entries({
 missing_field:(p:any):void=>{p.items[0].parameters={};},
 missing_owner:(p:any):void=>{p.items=[];},
 wrong_owner:(p:any):void=>{p.items[0].id=43;},
 duplicate_owner:(p:any):void=>{p.items.push(structuredClone(p.items[0]));},
 partial:(p:any):void=>{p.truncated=true;},
 request_echo:(p:any)=>{delete p.items;p.body={elementId:42,parameters:{Comments:'OTHER'}};}
}))test(`missing or ambiguous native data is not called a mismatch: ${name}`,()=>{
 const p:any=payload('OTHER');alter(p);assert.notEqual(nativePropertyComparisonV2(setter,read,p).state,'mismatch');
});
test('comparison is bounded but checks the whole requested batch, not only the displayed prefix',()=>{
 const changes=Array.from({length:20},(_,i)=>({elementId:i+1,parameterName:'Comments',value:'OK'}));
 const a={...setter,body:{changes}},r={...read,body:{elementIds:changes.map(c=>c.elementId),names:['Comments']}},p={items:changes.map(c=>({id:c.elementId,uniqueId:'id-'+c.elementId,parameters:{Comments:c.elementId===20?'BAD':'OK'}}))};
 const c=nativePropertyComparisonV2(a,r,p);assert.equal(c.state,'mismatch');assert.equal(c.differences[0]?.subject,'target_property:"20":comments');assert.equal(c.omitted,0);
});
test('long values compare in full before explicitly clipped presentation',()=>{
 const value='A'.repeat(600),a={...setter,body:{changes:[{elementId:42,parameterName:'Comments',value}]}};
 const c=nativePropertyComparisonV2(a,read,payload(value+'B'));assert.equal(c.state,'mismatch');assert(c.differences[0]?.values_clipped);
 assert(c.differences[0]!.expected[0]!.length<=256);
});
const viewInput={method:'POST',path:'/revit/visibility',body:{action:'set_phase',viewId:42,phaseId:21,dryRun:false}};
const viewRead={method:'POST',path:'/revit/visibility',body:{action:'get',viewId:42}};
const viewPayload={status:'Ok',action:'get',dryRun:false,view:{id:42,phase:{id:22,name:'Existing'}}};
test('actual view-property disagreement includes native wanted and observed values',()=>{
 const c=nativePropertyComparisonV2(viewInput,viewRead,viewPayload);assert.equal(c.state,'mismatch');
 assert.deepEqual(c.differences,[{subject:'native_view_phasing:42:phase:id',expected:['21'],observed:['22']}]);
});
test('view request echo, wrong receiver and incomplete native projection stay unproven',()=>{
 assert.notEqual(nativePropertyComparisonV2(viewInput,viewRead,{...viewPayload,view:{...viewPayload.view,id:43}}).state,'mismatch');
 assert.notEqual(nativePropertyComparisonV2(viewInput,viewRead,{...viewPayload,action:'set_phase'}).state,'mismatch');
 assert.notEqual(nativePropertyComparisonV2(viewInput,viewRead,{...viewPayload,view:{id:42}}).state,'mismatch');
 assert.equal(nativePropertyComparisonV2({path:'/revit/create-duct'},viewRead,viewPayload).state,'unsupported');
});
