import {createHash} from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>'sha256:'+createHash('sha256').update(value,'utf8').digest('hex');

/** Generic review evidence is text-screened, unlike the separately retained
 * Responses transport record. Reference only the protocol's opaque reasoning
 * ciphertext; keep every readable field available to the normal secret screen.
 * The authenticated host has already retained the full response before returning
 * it to a reviewer. This is NOT a Responses input, compaction or replay transform.
 * No review verdict, native authority, or completion follows from this reference.
 */
export function reviewResponseEvidence(response){
  if(!object(response)||typeof response.id!=='string'||!/^resp_[A-Za-z0-9_-]+$/.test(response.id)||!Array.isArray(response.output))return response;
  const eligible=item=>object(item)&&item.type==='reasoning'
    &&typeof item.encrypted_content==='string'&&item.encrypted_content.length>=64
    &&/^[A-Za-z0-9_-]+={0,2}$/.test(item.encrypted_content)
    &&!Object.hasOwn(item,'encrypted_content_ref');
  if(!response.output.some(eligible))return response;
  const responseHash=digest(JSON.stringify(response));
  return {...response,output:response.output.map((item,index)=>{
    if(!eligible(item))return item;
    const {encrypted_content,...readable}=item;
    return {...readable,encrypted_content_ref:{
      schema:'operator.retained-provider-field.v1',
      response_id:response.id,response_sha256:responseHash,
      json_pointer:'/output/'+index+'/encrypted_content',
      sha256:digest(encrypted_content),utf8_bytes:Buffer.byteLength(encrypted_content,'utf8'),
      authority:'opaque_transport_only'
    }};
  })};
}
