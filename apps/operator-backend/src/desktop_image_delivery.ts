import fs from 'node:fs';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {ensureWorkspaceLayout} from './workspace.js';

/** Actual prepared Responses image inputs. Delivery is not interpretation,
 * capture freshness, native correctness, or completion evidence. */
export function imageInputManifest(input:unknown) {
  const images:{sha256:string;bytes:number;media_type:string;position:string}[]=[];
  const visit=(value:any,position:string,depth:number)=>{
    if(depth>12||!value||typeof value!=='object')return;
    if(['input_image','computer_screenshot'].includes(value.type)&&typeof value.image_url==='string'){
      const m=/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(value.image_url);
      if(m){const bytes=Buffer.from(m[2]!,'base64');if(bytes.length&&bytes.toString('base64')===m[2])images.push({sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,media_type:m[1]!,position});}
      return;
    }
    if(Array.isArray(value))value.forEach((v,i)=>visit(v,position+'.'+i,depth+1));
    else for(const key of ['content','input','output'])if(value[key]&&typeof value[key]==='object')visit(value[key],position+'.'+key,depth+1);
  };
  visit(input,'input',0);return images;
}
type Binding={session_id:string;assignment_id:string;run_id:string;generation:number};
const canonicalBinding=(b:Binding)=>({session_id:b.session_id,assignment_id:b.assignment_id,run_id:b.run_id,generation:b.generation});
function receiptPath(binding:Binding,hash:string){
  if(!/^[a-f0-9]{64}$/.test(hash))throw Error('image_delivery_hash_invalid');
  const key=createHash('sha256').update(JSON.stringify(canonicalBinding(binding))).digest('hex');
  return path.join(ensureWorkspaceLayout().runs,'desktop-image-delivery',key,hash+'.json');
}
export function retainImageInputDelivery(binding:Binding,response:any){
  if(response?.status!=='completed'||response.model_call_receipt?.success!==true||!response.id||!Array.isArray(response.input_images))return;
  for(const image of response.input_images){
    const file=receiptPath(binding,image.sha256);fs.mkdirSync(path.dirname(file),{recursive:true});
    const tmp=file+'.'+randomUUID()+'.tmp';
    fs.writeFileSync(tmp,JSON.stringify({binding:canonicalBinding(binding),...image,response_id:response.id,started_at:response.model_call_receipt.started_at_utc,
      delivered_at:new Date().toISOString(),authority:'provider_input_delivery_only'}),{flag:'wx'});fs.renameSync(tmp,file);
  }
}
export function readImageInputDelivery(binding:Binding,hash:string){
  const file=receiptPath(binding,hash);if(!fs.existsSync(file))throw Error('drafting_image_not_delivered');
  const receipt=JSON.parse(fs.readFileSync(file,'utf8'));
  if(JSON.stringify(receipt.binding)!==JSON.stringify(canonicalBinding(binding))||receipt.sha256!==hash)throw Error('drafting_image_binding_mismatch');
  return receipt;
}
