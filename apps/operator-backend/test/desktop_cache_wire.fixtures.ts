import assert from 'node:assert/strict';

// Cache annotations are wire metadata; continuity tests still compare every
// retained text, image, call and opaque compaction byte independently.
export function assertCacheAnnotatedInputs(actual:any[], expected:any[], expectedMarkers:number){
 let markers=0;
 const normalize=(rows:any[],wire:boolean)=>rows.map(row=>{
  if(row?.type!=='function_call_output')return row;
  const output=typeof row.output==='string'?[{type:'input_text',text:row.output}]:row.output;
  assert(Array.isArray(output));
  return {...row,output:output.map((part:any,index:number)=>{
   if(!Object.hasOwn(part,'prompt_cache_breakpoint'))return part;
   assert(wire);assert.equal(part.type,'input_text');assert.equal(index,output.length-1);
   assert.deepEqual(part.prompt_cache_breakpoint,{mode:'explicit'});markers++;
   const {prompt_cache_breakpoint,...content}=part;return content;
  })};
 });
 assert.deepEqual(normalize(actual,true),normalize(expected,false));
 assert.equal(markers,expectedMarkers);
}
