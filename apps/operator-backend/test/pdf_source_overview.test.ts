import assert from 'node:assert/strict';
import test from 'node:test';
import { pdfSourceOverview } from '../src/attachments/pdf_source_overview.js';
const projection=(items:any[]=[])=>({source_annotation_count:items.length,returned_annotation_count:items.length,hidden_annotation_count:0,omitted_annotation_count:0,items});
test('overview preserves short source and distinguishes absent annotations from no marks',()=>{
 const r=pdfSourceOverview('Sheet E101',projection());assert.equal(r.text_excerpts[0].text,'Sheet E101');
 assert.equal(r.text_truncated,false);assert.match(r.note,/Empty annotations do not mean no marks/);
 assert.match(r.note,/before acting/);assert.equal(r.annotations.source_content_only,true);
});
test('dense annotations preserve source identities, visible bounds and explicit omissions without route vectors',()=>{
 const items=Array.from({length:64},(_,i)=>({source_index:i+1,subtype:'Line',contents:'Comment '+i+' '.repeat(500),contents_truncated:false,
  annotation_bounds:{min_u:.1,min_v:.2,max_u:.3,max_v:.4},vertices:[{u:.1,v:.2},{u:.3,v:.4}]}));
 const r=pdfSourceOverview('a'.repeat(3000),{...projection(items),source_annotation_count:70,hidden_annotation_count:2,omitted_annotation_count:4});
 assert(r.annotations.items.length<=12);assert.equal(r.annotations.omitted_annotation_count,4+64-r.annotations.items.length);
 assert.equal(r.annotations.hidden_annotation_count,2);assert.equal(r.annotations.source_annotation_count,70);
 assert(r.annotations.items.every(a=>a.contents_truncated));assert(!JSON.stringify(r).includes('vertices'));
 assert.equal(r.text_excerpts[1].start_character,2500);assert.equal(r.returned_text_characters,1000);
 assert(r.text_truncated);assert(Buffer.byteLength(JSON.stringify(r))<4500);
});
test('overview comment ordering cannot silently drop vector-only annotation counts or mutate retained details',()=>{
 const items=[{source_index:1,subtype:'Line',contents:'',contents_truncated:false},{source_index:2,subtype:'Text',contents:'Move this',contents_truncated:false}];
 const before=JSON.stringify(items);const r=pdfSourceOverview('',projection(items));
 assert.equal(JSON.stringify(items),before);assert.deepEqual(r.annotations.items.map(a=>a.source_index),[1,2]);
 assert.equal(r.annotations.omitted_annotation_count,0);assert.equal(r.returned_text_characters,0);
});
test('unicode output respects byte bounds and comments report truncation',()=>{
 const items=Array.from({length:64},(_,i)=>({source_index:i+1,subtype:'Text',contents:'漢'.repeat(500),contents_truncated:false}));
 const source='😀漢'.repeat(10000);const r=pdfSourceOverview(source,projection(items));assert(Buffer.byteLength(JSON.stringify(r.annotations.items))<2600);
 assert(Buffer.byteLength(JSON.stringify(r))<4500);assert(r.text_excerpts.every(e=>!/[\uD800-\uDBFF]$/.test(e.text)));
 assert.equal(source.slice(r.text_excerpts[1].start_character),r.text_excerpts[1].text);
 assert(r.annotations.omitted_annotation_count>0);assert(r.annotations.items.every(a=>a.contents_truncated));
});
