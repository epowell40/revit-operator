import {createHash} from 'node:crypto';

/** Server configuration only. This controls Responses application state, not
 * abuse logs, cache residency, account eligibility, other providers or local deletion. */
export type OpenAiDataPolicy = {schema:'operator.openai-data-policy/v1';storage:'provider'|'host';account_alias:string;configuration_sha256:string};
export function openAiConnection(){return {
 baseURL:(process.env.OPERATOR_OPENAI_BASE_URL||process.env.OPENAI_BASE_URL||'https://api.openai.com/v1').trim(),
 organization:(process.env.OPERATOR_OPENAI_ORG||process.env.OPENAI_ORG||process.env.OPENAI_ORG_ID||'').trim(),
 project:(process.env.OPERATOR_OPENAI_PROJECT||process.env.OPENAI_PROJECT||process.env.OPENAI_PROJECT_ID||'').trim()
};}
export function resolveOpenAiDataPolicy():OpenAiDataPolicy {
 const storage=(process.env.OPERATOR_OPENAI_RESPONSE_STORAGE||'provider').trim();
 const alias=(process.env.OPERATOR_OPENAI_ACCOUNT_ALIAS||'unverified-account').trim();
 if(!['provider','host'].includes(storage)||! /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(alias))throw Error('provider_data_policy_configuration_invalid');
 const connection=openAiConnection();let url:URL;try{url=new URL(connection.baseURL);}catch{throw Error('provider_data_policy_endpoint_invalid');}
 if(storage==='host'&&(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&!(url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname))))throw Error('provider_data_policy_endpoint_invalid');
 const configuration_sha256=createHash('sha256').update(JSON.stringify([storage,alias,url.href.replace(/\/+$/,''),connection.organization,connection.project])).digest('hex');
 return {schema:'operator.openai-data-policy/v1',storage:storage as 'provider'|'host',account_alias:alias,configuration_sha256};
}
export function assertCurrentOpenAiDataPolicy(policy:OpenAiDataPolicy):void {
 if(policy.configuration_sha256!==resolveOpenAiDataPolicy().configuration_sha256)throw Error('provider_data_policy_changed_requires_new_task');
}
export function openAiResponseBody(body:any,policy:OpenAiDataPolicy):any {
 assertCurrentOpenAiDataPolicy(policy);
 if(!body||typeof body!=='object'||Array.isArray(body))throw Error('provider_data_policy_request_invalid');
 if(body.store!==undefined&&typeof body.store!=='boolean')throw Error('provider_data_policy_storage_invalid');
 if(policy.storage==='host'){
  if(body.store===true||body.previous_response_id!=null||body.conversation!=null||body.background===true)throw Error('provider_data_policy_host_context_required');
  if(!Array.isArray(body.input)&&typeof body.input!=='string')throw Error('provider_data_policy_host_context_required');
  if(Array.isArray(body.input)&&body.input.some((i:any)=>i?.type==='item_reference'))throw Error('provider_data_policy_host_context_required');
  if(body.include!==undefined&&(!Array.isArray(body.include)||!body.include.every((s:any)=>typeof s==='string')))throw Error('provider_data_policy_request_invalid');
  return {...body,store:false,include:[...new Set([...(body.include??[]),'reasoning.encrypted_content'])]};
 }
 return {...body,store:body.store??true};
}
