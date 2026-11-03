import {createHash} from 'node:crypto';
import type {AssignmentSnapshotV2} from '../domain/assignment-kernel/snapshot.js';
import {projectDraftingPasses} from '../domain/assignment-kernel/work_plan_location.js';

/** A derived visual index of the existing journal. Clean source pixels remain
 * adjacent to the overlay. No independent status store or completion verdict. */
export async function addDraftingReferenceTracking(result:any,snapshot:AssignmentSnapshotV2|null){
  if(!snapshot?.work_plan||!Array.isArray(result?.content))return result;
  const {createCanvas,loadImage}=await import('@napi-rs/canvas');
  const content:any[]=[];let page:any=null;
  let imageBytes=result.content.reduce((n:number,i:any)=>n+(i.type==='image'?Buffer.from(i.data,'base64').length:0),0);
  for(const item of result.content){
    content.push(item);
    if(item.type==='text'){try{const m=JSON.parse(item.text);if(m.page&&m.image_geometry)page=m;}catch{}continue;}
    if(item.type!=='image'||!page)continue;
    const marks=snapshot.work_plan.items.flatMap(work=>{
      const location=work.location_history?.at(-1),source=location?.source;
      if(!source?.region||source.sha256!==page.sha256||source.page!==page.page||source.attachment_id!==page.attachment_id)return [];
      return [{item_id:work.item_id,region:source.region,passes:projectDraftingPasses(work,snapshot)}];
    }).filter(m=>m.passes.length);
    if(!marks.length)continue;
    const image=await loadImage(Buffer.from(item.data,'base64')),canvas=createCanvas(image.width,image.height),ctx=canvas.getContext('2d');
    ctx.drawImage(image,0,0);const t=page.image_geometry.pixel_to_normalized_page;
    const labels:any[]=[];
    for(const mark of marks){
      const r=mark.region,x=(r.min_u-t.u_offset)/t.u_per_pixel,y=(r.min_v-t.v_offset)/t.v_per_pixel;
      const w=(r.max_u-r.min_u)/t.u_per_pixel,h=(r.max_v-r.min_v)/t.v_per_pixel;
      if(x+w<0||y+h<0||x>=canvas.width||y>=canvas.height)continue;
      const label=mark.item_id+': '+mark.passes.map(p=>p.pass+' '+(p.needs_recheck?'recheck':p.stage)).join(', ');
      const color=mark.passes.some(p=>p.stage==='blocked')?'#bd3e36':mark.passes.some(p=>p.needs_recheck||p.stage==='attempted')?'#b77700':mark.passes.every(p=>p.stage==='checked')?'#187c46':'#236bb2';
      ctx.strokeStyle=color;ctx.lineWidth=3;ctx.strokeRect(x,y,w,h);
      ctx.font='16px sans-serif';const tx=Math.max(2,x+3),ty=Math.max(18,Math.min(canvas.height-5,y+19));
      ctx.fillStyle='rgba(255,255,255,0.9)';ctx.fillRect(tx-2,ty-16,Math.min(canvas.width-tx,ctx.measureText(label).width+4),20);
      ctx.fillStyle=color;ctx.fillText(label,tx,ty,canvas.width-tx);labels.push(mark);
    }
    if(!labels.length)continue;
    const png=canvas.toBuffer('image/png');
    if(png.length>8*1024*1024||imageBytes+png.length>24*1024*1024){
      content.push({type:'text',text:JSON.stringify({drafting_tracking:{overlay_omitted:'image_budget',marks:labels,
        notice:'Clean source pixels retained. Use a smaller readable crop for the highlighted reference.'}})});
      page=null;continue;
    }
    imageBytes+=png.length;
    content.push({type:'text',text:JSON.stringify({drafting_tracking:{source_sha256:page.sha256,page:page.page,marks:labels,
      clean_reference_image_sha256:createHash('sha256').update(Buffer.from(item.data,'base64')).digest('hex'),
      overlay_image_sha256:createHash('sha256').update(png).digest('hex'),
      legend:'Blue=drafted; amber=attempted/recheck; green=actor checked named pass only; red=blocked. Unmarked areas remain undiscovered, not complete. Whole drawing completion requires coverage sweeps. This overlay is tracking, not source content or native proof.'}})});
    content.push({type:'image',mimeType:'image/png',data:png.toString('base64')});page=null;
  }
  return {...result,content};
}
