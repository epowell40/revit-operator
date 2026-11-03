import fs from 'node:fs';
import {inlineAccessoryFixture} from './inline_accessory_readback.fixtures.js';
const locations=[new URL('./fixtures/inline-accessory-bookkeeping97.json',import.meta.url),new URL('../../test/fixtures/inline-accessory-bookkeeping97.json',import.meta.url)];
export function inlineBookkeepingFixture(){
  const f=inlineAccessoryFixture(),data=JSON.parse(fs.readFileSync(locations.find(p=>fs.existsSync(p))!,'utf8'));
  f.apply.preservationBefore.bookkeeping=data.before;
  f.scan.inlineAccessoryState.bookkeeping=data.after;
  f.apply.preservationAfter=structuredClone(f.scan.inlineAccessoryState);
  f.apply.transaction.added_element_ids.push(21);
  f.apply.transaction.modified_element_ids.push(11,80,90,91);
  f.apply.transaction.affected_element_ids.push(11,21,80,90,91);
  f.affected=f.apply.transaction.affected_element_ids.map((n:number)=>`element_id:${n}`).sort();
  return f;
}
