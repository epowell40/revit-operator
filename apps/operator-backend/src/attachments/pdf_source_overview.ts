// Staged general helper only. Not installed or active in binder20.
type Annotation = {
  source_index: number; subtype: string; contents: string; contents_truncated: boolean;
  rgb?: number[]; annotation_bounds?: { min_u: number; min_v: number; max_u: number; max_v: number };
};
type AnnotationProjection = {
  source_annotation_count: number; returned_annotation_count: number;
  hidden_annotation_count: number; omitted_annotation_count: number; items: readonly Annotation[];
};

/** Navigation context only; full detail remains available through the source reader. */
export function pdfSourceOverview(text: string, annotations: AnnotationProjection) {
  const part=(suffix:boolean)=>{let result='',bytes=0;
    const characters=Array.from(text);if(suffix)characters.reverse();
    for(const c of characters){const n=Buffer.byteLength(JSON.stringify(c))-2;if(bytes+n>500)break;
      result=suffix?c+result:result+c;bytes+=n;}return result;};
  const short=Buffer.byteLength(JSON.stringify(text),'utf8')-2<=1000;
  const head=short?text:part(false),tail=short?'':part(true);
  const excerpts = short ? [{ start_character: 0, text }]
    : [{ start_character: 0, text: head },{ start_character: text.length-tail.length, text: tail }];
  const items: Annotation[] = [];
  let bytes = 0;
  // Prioritize comment-bearing annotations for discovery only; pixel review
  // still includes every visible mark, including flattened/vector-only marks.
  const candidates = [...annotations.items].sort((a,b)=>Number(Boolean(b.contents))-Number(Boolean(a.contents)) || a.source_index-b.source_index);
  for (const a of candidates) {
    const item: Annotation = { source_index: a.source_index, subtype: a.subtype,
      contents: a.contents.slice(0,200), contents_truncated: a.contents_truncated || a.contents.length>200,
      ...(a.rgb ? {rgb:a.rgb} : {}), ...(a.annotation_bounds ? {annotation_bounds:a.annotation_bounds} : {}) };
    const n=Buffer.byteLength(JSON.stringify(item),'utf8')+1;
    if(items.length===12 || bytes+n>2600) continue;
    items.push(item);bytes+=n;
  }
  items.sort((a,b)=>a.source_index-b.source_index);
  return { mode: 'overview' as const, text_excerpts: excerpts,
    text_characters: text.length, returned_text_characters: excerpts.reduce((n,e)=>n+e.text.length,0),
    text_truncated: !short,
    annotations: { source_annotation_count: annotations.source_annotation_count,
      returned_annotation_count: items.length, hidden_annotation_count: annotations.hidden_annotation_count,
      omitted_annotation_count: annotations.omitted_annotation_count+annotations.items.length-items.length,
      geometry_scope: 'Navigation bounds only; full annotation vectors require detail', source_content_only:true, items },
    note: 'Overview is for finding work areas, not reading small labels, establishing route geometry or proving source completion. Empty annotations do not mean no marks. Request detail on the relevant page/region before acting; omitted text and annotations remain retrievable.' };
}
