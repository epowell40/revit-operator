import { createdViewIdsFromIdentitiesV2 } from './view_owned_detailing_v2.js';
type Row=Record<string,unknown>;
const row=(v:unknown):Row=>v&&typeof v==='object'&&!Array.isArray(v)?v as Row:{};
const id=(v:unknown):number|null=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0?v:null;
const enumEqual=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.trim().toLowerCase()===b.trim().toLowerCase();
/** All desired attributes must belong to the created view in one native get.
 * Names on unrelated views, echoed requests, and mutation self-reports cannot
 * establish this independent postcondition. */
export function createdPlanSatisfiedV2(request:Row,payload:unknown,identities:readonly string[]):boolean {
 let root=row(payload);
 if(root.isError===true||root.ok===false||root.success===false||root.error)return false;
 if(!('view' in root)&&!('views' in root)&&!('status' in root)&&Array.isArray(root.content)&&root.content.length===1){
  const block=row(root.content[0]);if(block.type!=='text'||typeof block.text!=='string'||block.text.length>1_000_000)return false;
  try{root=row(JSON.parse(block.text));}catch{return false;}
 }
 if(root.isError===true||root.ok===false||root.success===false||root.error||root.dryRun===true||request.dryRun===true)return false;
 const targets=createdViewIdsFromIdentitiesV2(identities);
 let view:Row;
 if(root.status==='Ok'&&root.action==='get'&&root.dryRun===false)view=row(root.view);
 else if(root.status==='ok'&&root.action==='list'&&root.truncated===false&&Array.isArray(root.views)&&root.returned===root.views.length){
  const matches=root.views.map(row).filter(v=>id(v.id)!==null&&targets.includes(v.id as number));
  if(matches.length!==1)return false;
  view={...matches[0],viewType:matches[0]!.type,viewTemplate:matches[0]!.viewTemplateName};
 }else return false;
 const target=id(view.id);
 if(!target||!targets.includes(target)||view.isTemplate!==false||!id(view.levelId))return false;
 const planType=String(request.planType??'floor').trim().toLowerCase();
 const type:Record<string,string>={floor:'FloorPlan',ceiling:'CeilingPlan',engineering:'FloorPlan',structural:'EngineeringPlan'};
 if(!type[planType]||view.viewType!==type[planType])return false;
 if(request.levelId!=null){if(!id(request.levelId)||view.levelId!==request.levelId)return false;}
 else if(request.levelName!=null){if(typeof request.levelName!=='string'||!request.levelName.trim()||!enumEqual(view.levelName,request.levelName))return false;}
 if(request.name!=null&&(typeof request.name!=='string'||view.name!==request.name.trim().slice(0,120).trim()))return false;
 if(request.scale!=null&&(typeof request.scale!=='number'||view.scale!==request.scale))return false;
 for(const field of ['detailLevel','discipline'])if(request[field]!=null&&!enumEqual(view[field],request[field]))return false;
 if(request.templateId!=null){if((!id(request.templateId)&&request.templateId!==-1)||view.viewTemplateId!==request.templateId)return false;}
 else if(request.templateName!=null&&!enumEqual(view.viewTemplate,request.templateName))return false;
 return true;
}
