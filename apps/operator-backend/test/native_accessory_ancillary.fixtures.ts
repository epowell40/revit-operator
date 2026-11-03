import fs from 'node:fs';
import {example} from './native_accessory_preservation.fixtures.js';
const file=[new URL('./fixtures/native-placement-ancillary133.json',import.meta.url),new URL('../../test/fixtures/native-placement-ancillary133.json',import.meta.url)].find(p=>fs.existsSync(p))!;
export const actualAncillary133=JSON.parse(fs.readFileSync(file,'utf8'));
// Counterfactual test baseline, NOT a recovered native before snapshot. The
// exact original133 operation remains unverifiable for these internal owners.
export function ancillaryExample(kind:'duct'|'pipe'='duct',mode:'internal'|'dependent'|'both'='both'){
 const f=example(kind),before=f.apply.preservationBefore.nativePlacementState,after=f.after.nativePlacementState;
 const internal=structuredClone(actualAncillary133.internals.filter((r:any)=>r.dependentIds.length===1));
 const flex=structuredClone(actualAncillary133.unchangedFlexDependent);
 const extra:any[]=[];
 for(const state of [before,after]){
  if(mode!=='dependent')state.internalBookkeeping={schema:'operator.inline_accessory_bookkeeping.v1',complete:true,
   scope:'public_semantic_projection_not_hidden_state',candidateScanComplete:true,internals:structuredClone(internal),unavailableInternals:[]};
  if(mode!=='internal'){
   state.dependents=[structuredClone(flex)];state.owners.find((o:any)=>o.elementId===40).dependentIds=[flex.elementId];
  }
 }
 if(mode!=='dependent')extra.push(...internal);
 if(mode!=='internal')extra.push(flex);
 for(const r of extra){
  for(const ids of [f.apply.transaction.modified_element_ids,f.apply.changeTracking.observedModifiedIds,
   f.apply.transaction.affected_element_ids,after.requestedChangedIds])if(!ids.includes(r.elementId))ids.push(r.elementId);
  f.affected.push('element_id:'+r.elementId);after.affected.push({elementId:r.elementId,uniqueId:r.uniqueId,exists:true});
 }
 f.apply.preservationAfter=structuredClone(f.after);return f;
}
