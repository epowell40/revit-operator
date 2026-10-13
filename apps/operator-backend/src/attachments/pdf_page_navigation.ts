// Source navigation helper. Source label candidates are not model identities.
type TextItem={str?:unknown;transform?:unknown};
type Viewport={width:number;height:number;convertToViewportPoint:(x:number,y:number)=>number[]};
export function pdfPageNavigation(items:readonly TextItem[],viewport:Viewport,pageLabel:unknown) {
 const candidates:Array<{source_text_index:number;text:string;baseline_anchor:{u:number;v:number}}> = [];
 for(let index=0;index<items.length;index++) {
  const item=items[index],label=typeof item.str==='string'?item.str.trim():'';
  if(!/^[A-Z]{1,3}[-.]?\d{2,4}(?:[.-]\d{1,3})?$/.test(label))continue;
  const transform=item.transform;
  if(!Array.isArray(transform)||transform.length!==6||!transform.every(v=>typeof v==='number'&&Number.isFinite(v)))continue;
  const point=viewport.convertToViewportPoint(transform[4],transform[5]),u=point[0]/viewport.width,v=point[1]/viewport.height;
  if(!Number.isFinite(u)||!Number.isFinite(v)||u<0||u>1||v<0||v>1)continue;
  candidates.push({source_text_index:index+1,text:label,baseline_anchor:{u,v}});
 }
 // Put common footer/titleblock locations in the bounded navigation set,
 // without treating that ranking as evidence of the current sheet identity.
 const selected=[...candidates].sort((a,b)=>(b.baseline_anchor.u+b.baseline_anchor.v)-(a.baseline_anchor.u+a.baseline_anchor.v)
  || a.source_text_index-b.source_text_index).slice(0,16).sort((a,b)=>a.source_text_index-b.source_text_index);
 return {declared_pdf_page_label:typeof pageLabel==='string'?pageLabel.slice(0,120):null,
  sheet_identity:'unresolved_until_source_review',view_identity:'unresolved_until_source_and_model_correspondence',
  label_candidates:selected,label_candidate_count:candidates.length,omitted_label_candidates:Math.max(0,candidates.length-selected.length),
  candidate_selection:'Bottom/right anchors favored when bounded; candidates may be panel names or references, never an inferred sheet identity.',
  coordinate_scope:'Full displayed page; u right, v down. Anchors are text baselines, not target geometry.',
  notice:'Keep source filename/hash/page and crop-to-page transform with this image. These extracted labels may refer to other sheets (for example an index); visually establish the current sheet/view from the full-page overview or titleblock detail and retain its model correspondence. No candidates does not mean no identity. Source labels never authorize a model target.'};
}
