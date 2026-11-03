import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import {inlineAccessoryFixture} from './inline_accessory_readback.fixtures.js';
import {inlineAccessoryReadbackMatchesV2} from '../src/verification/inline_accessory_readback_v2.js';

const locations=[new URL('./fixtures/inline-split-parameters83.json',import.meta.url),new URL('../../test/fixtures/inline-split-parameters83.json',import.meta.url)];
const retained=JSON.parse(fs.readFileSync(locations.find(p=>fs.existsSync(p))!,'utf8'));
test('provisional diagnostic never admits extra native effects or an unsettled receipt',()=>{
  for(const mode of ['extraOwner','rollback','unknown']){
    const f=inlineAccessoryFixture();
    (f.apply as any).postCommitDiagnostic={diagnosticOnly:true,physical:{complete:true},owners:[{elementId:999,present:true,category:null}]};
    if(mode==='extraOwner'){f.apply.transaction.added_element_ids.push(999);f.apply.transaction.affected_element_ids.push(999);f.affected.push('element_id:999');}
    else if(mode==='rollback'){f.apply.transaction.status='rolled_back';f.apply.transaction.committed=false;}
    else (f.apply as any).applied=null;
    assert.equal(inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan),false);
  }
});
for(const [value,storage] of [['10.083333333433334','Double'],['NaN','Double'],['Infinity','Double'],['1e999','Double'],['','Double'],[' 10.083333333333334','Double'],['10.083333333333334','String']])
test(`elevation roundoff does not admit ${JSON.stringify([value,storage])}`,()=>{
  for(const id of [-1141029,-1140240,-1141026,-1141020,-1140239,-1141021,-1114132])for(const ownerId of [10,20]){
    const f=inlineAccessoryFixture();
    const params=JSON.stringify([{id,storage:'Double',value:'10.083333333333334'}]);
    f.apply.preservationBefore.owners.find((o:any)=>o.elementId===10).state.parameters=params;
    for(const o of f.scan.inlineAccessoryState.owners.filter((o:any)=>[10,20].includes(o.elementId)))o.state.parameters=params;
    f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===ownerId).state.parameters=JSON.stringify([{id,storage,value}]);
    assert.equal(inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan),false);
  }
});
for(const split of retained.splits)test(`retained ${split.phase} parameter facts at independent split readback boundary`,()=>{
  // Geometry/receipt are the existing synthetic desired-state fixture. Only
  // parameter arrays below are actual native facts; this is not live API proof.
  const f=inlineAccessoryFixture();
  f.apply.preservationBefore.owners.find((o:any)=>o.elementId===10).state.parameters=retained.before;
  f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===10).state.parameters=split.retained;
  f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===20).state.parameters=split.created;
  assert.equal(inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan),true);
  const newOwner=f.scan.inlineAccessoryState.owners.find((o:any)=>o.elementId===20);
  newOwner.uniqueId=f.apply.preservationBefore.owners.find((o:any)=>o.elementId===10).uniqueId;
  newOwner.state.UniqueId=newOwner.uniqueId;
  assert.equal(inlineAccessoryReadbackMatchesV2(f.input,f.affected,f.apply,f.scan),false,'copied native UniqueId remains invalid');
});
