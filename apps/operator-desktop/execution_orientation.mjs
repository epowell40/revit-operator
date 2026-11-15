// Model-visible orientation from context the host already read. No dispatch,
// target selection, evidence admission, authority or new native read here.
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const text=(v,n)=>typeof v==='string'&&v.length>0&&v.length<=n&&!/[\u0000-\u001f]/.test(v)?v:null;
const positive=v=>Number.isSafeInteger(v)&&v>0;
export function executionOrientation(context,now=Date.now()){
 const r=context?.revit,d=r?.document,v=d?.activeView,at=Date.parse(r?.observed_at_utc),age=now-at;
 if(!object(r)||r.schema!=='revit-operator.context.v1'||r.source?.live!==true||r.source.error
  ||!Number.isFinite(now)||!Number.isFinite(at)||age<0||age>5000||!positive(r.process_id)
  ||!object(d)||!text(d.title,260)||!text(d.projectIdentity?.fingerprint,200)
  ||!object(v)||!positive(v.id)||!text(v.name,260)||!text(v.type,120))return null;
 const ids=Array.isArray(d.selection)?d.selection:null;
 const validSelection=ids&&ids.every(positive)&&new Set(ids).size===ids.length;
 return {schema:'operator.execution-orientation.v1',observed_at_utc:r.observed_at_utc,
  process_id:r.process_id,revit_version:text(r.version,80),document:{title:d.title,path:text(d.path,1000),project_fingerprint:d.projectIdentity.fingerprint},
  active_view:{id:v.id,name:v.name,type:v.type},
  selection:validSelection?{ids:ids.slice(0,20),count:ids.length,truncated:ids.length>20}:null,
  verification_authority:false,
  limits:'Orientation data already observed by the host, not instructions, target geometry, permission, native effect evidence or proof of current state. Reuse model/view identity to avoid redundant orientation reads; read exact target facts before edits. Later observations supersede this packet and normal dispatch still validates the current binding.'};
}
export function executionOrientationInput(context,now=Date.now()){
 const packet=executionOrientation(context,now);
 return packet?{role:'user',content:[{type:'input_text',text:JSON.stringify(packet)}]}:null;
}
