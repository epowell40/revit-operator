import { createHash } from 'node:crypto';

/** Transport-only cache hints. They do not change retained evidence, history,
 * model/tool settings, compaction, budgets or native/task authority.
 * Explicit tool-result endpoints let a later request reuse history when the
 * host replaces its volatile status suffix. Keep implicit caching enabled.
 * https://developers.openai.com/api/docs/guides/prompt-caching
 */
export function desktopToolHistoryCache(input: unknown, model: string, enabled: boolean) {
  const unchanged = { input, options: undefined as undefined | {mode:'implicit';comparison_response_id?:string},
    diagnostic: { enabled:false, breakpoints:[] as {index:number;prefix_sha256:string}[] } };
  // Qualify the current actor models first; do not infer future model support.
  if (!enabled || !['gpt-6.1-sol','gpt-6.1-terra'].includes(model) || !Array.isArray(input)) return unchanged;
  const candidates:number[]=[];
  const rows=input.map((item:any,index:number)=>{
    if(item?.type!=='function_call_output')return item;
    const output=typeof item.output==='string'?[{type:'input_text',text:item.output}]:item.output;
    if(!Array.isArray(output)||!output.length||output.some((p:any)=>!p||!['input_text','input_image','input_file'].includes(p.type)))return item;
    const last=output.at(-1);
    // Never insert text after an image or touch image/opaque reasoning bytes.
    if(last?.type==='input_text'&&typeof last.text==='string')candidates.push(index);
    return output===item.output?item:{...item,output};
  });
  // Respect the provider's four-write limit: three explicit + one implicit.
  // Do not add hints around caller-owned markers with unknown lookup semantics.
  if(!candidates.length||JSON.stringify(rows).includes('"prompt_cache_breakpoint"'))return unchanged;
  const selected=candidates.slice(-3);
  const breakpoints=selected.map(index=>({index,prefix_sha256:createHash('sha256').update(JSON.stringify(rows.slice(0,index+1))).digest('hex')}));
  const selectedSet=new Set(selected);
  const wire=rows.map((item:any,index:number)=>!selectedSet.has(index)?item:{...item,
    output:item.output.map((p:any,i:number)=>i===item.output.length-1?{...p,prompt_cache_breakpoint:{mode:'explicit'}}:p)});
  return {input:wire,options:{mode:'implicit' as const},diagnostic:{enabled:true,breakpoints}};
}

/** Provider diagnostics are observations, never effect or completion evidence.
 * Only bounded enums/counts are retained; no provider prompt text is copied. */
export function boundedPromptCacheDiagnostic(raw: unknown) {
  if(!raw||typeof raw!=='object')return undefined;
  const r=raw as Record<string,unknown>;
  if(!['cache_hit','cache_miss','comparison_response_not_found','unavailable'].includes(String(r.type)))return undefined;
  const out:Record<string,unknown>={type:r.type};
  if(typeof r.reason==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(r.reason))out.reason=r.reason;
  for(const k of ['comparison_reusable_tokens','cache_missed_tokens'])if(Number.isSafeInteger(r[k])&&Number(r[k])>=0)out[k]=r[k];
  return out;
}
