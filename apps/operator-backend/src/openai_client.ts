import OpenAI from "openai";
import {openAiConnection,resolveOpenAiDataPolicy,openAiResponseBody,assertCurrentOpenAiDataPolicy} from './openai_data_policy.js';

export function resolveOpenAiApiKey(): string {
  return (process.env.OPERATOR_OPENAI_API_KEY || process.env.OPENAI_API_KEY || "").trim();
}

export function createOpenAiClient(apiKey?: string): OpenAI {
  const resolvedApiKey = (apiKey || resolveOpenAiApiKey()).trim();
  const {baseURL,organization,project}=openAiConnection();
  const policy=resolveOpenAiDataPolicy();
  const transport=globalThis.fetch;
  const scopedFetch:typeof fetch=async(input,init)=>{
    assertCurrentOpenAiDataPolicy(policy);
    const target=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url),base=new URL(baseURL);
    const prefix=base.pathname.replace(/\/+$/,'')+'/';
    const headers=new Headers(input instanceof Request?input.headers:undefined);
    new Headers(init?.headers).forEach((value,key)=>headers.set(key,value));
    if(target.origin!==base.origin||!target.pathname.startsWith(prefix)
      ||(headers.get('OpenAI-Organization')??'')!==organization||(headers.get('OpenAI-Project')??'')!==project)
      throw Error('provider_data_policy_destination_mismatch');
    return transport(input,{...init,redirect:'error'});
  };

  const client = new OpenAI({
    apiKey: resolvedApiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(organization ? { organization } : {}),
    ...(project ? { project } : {}),
    ...(policy.storage==='host'?{fetch:scopedFetch}:{})
  });
  // Wrap the SDK method, retaining its APIPromise/streaming helpers. The SDK's
  // responses.stream also calls this create method. No custom model loop.
  const create=client.responses.create.bind(client.responses);
  client.responses.create=((body:any,options:any)=>create(openAiResponseBody(body,policy),options)) as typeof client.responses.create;
  const chat=client.chat.completions.create.bind(client.chat.completions);
  client.chat.completions.create=((body:any,options:any)=>{
    assertCurrentOpenAiDataPolicy(policy);
    if(policy.storage==='host'&&body?.store===true)throw Error('provider_data_policy_storage_invalid');
    return chat({...body,store:body.store??false},options);
  }) as typeof client.chat.completions.create;
  return client;
}
