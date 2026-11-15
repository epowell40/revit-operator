import path from 'node:path';
import fs from 'node:fs';
import {createHash} from 'node:crypto';

const core=['assignment_id','session_id','run_id','generation'];
const sameBinding=(a,b)=>core.every(k=>a?.[k]!==undefined&&a[k]===b?.[k])
 &&['principal_id','document_fingerprint'].every(k=>b?.[k]===undefined||a?.[k]===b[k]);
const samePath=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.win32.normalize(a).toLowerCase()===path.win32.normalize(b).toLowerCase();
const fail=message=>{throw Object.assign(new Error(message),{status:409});};

/** Independent stable disk identity for a user-initiated open, not native
 * evidence. Stream large models without buffering them in the UI server. */
export async function readStableModelFileForOpen(filePath,{duringRead}={}){
 const handle=await fs.promises.open(filePath,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
 try{
  const before=await handle.stat({bigint:true}),real=await fs.promises.realpath(filePath);
  if(!before.isFile()||before.size<1n||before.size>BigInt(Number.MAX_SAFE_INTEGER))fail('The model is not a nonempty regular file.');
  const digest=createHash('sha256');let invoked=false;
  for await(const chunk of handle.createReadStream({autoClose:false})){digest.update(chunk);if(duringRead&&!invoked){invoked=true;await duringRead();}}
  const after=await handle.stat({bigint:true}),atPath=await fs.promises.stat(filePath,{bigint:true});
  if(!['dev','ino','size','mtimeNs','ctimeNs'].every(k=>before[k]===after[k]&&before[k]===atPath[k])||real!==await fs.promises.realpath(filePath))
   fail('The model changed while its opening identity was read.');
  return{path:filePath,size_bytes:Number(before.size),sha256:digest.digest('hex'),stable_read:true};
 }finally{await handle.close();}
}

/** Application-opening metadata only. Caller supplies an existing canonical
 * publication and independent stable disk facts, never actor prose or a year
 * from the link. The existing native receipt validator remains authoritative.
 * This does not dispatch native work, settle an effect or prove task success. */
export function planSavedRevitModelOpen({binding,snapshot,filePath,file,validateReceipt}){
 if(typeof filePath!=='string'||filePath.length>2000||/[\x00-\x1f"<>|]/.test(filePath)
   ||! /^[A-Za-z]:[\\/]/.test(filePath)||path.win32.extname(filePath).toLowerCase()!=='.rvt')fail('A local saved Revit model path is required.');
 if(!sameBinding(snapshot?.current_binding,binding)||snapshot?.terminal!==true||snapshot.quiescent!==true
   ||snapshot.execution_control?.state==='paused'||snapshot.provider_usage_hold
   ||['in_flight_operation_ids','in_flight_provider_call_ids','unresolved_unknown_operation_ids'].some(k=>!Array.isArray(snapshot[k])||snapshot[k].length))
   fail('Wait for the bound assignment and all effects/usage to settle before opening its model.');
 if(typeof validateReceipt!=='function'||!file||!samePath(file.path,filePath)||file.stable_read!==true
   ||!Number.isSafeInteger(file.size_bytes)||file.size_bytes<1||typeof file.sha256!=='string'||file.sha256.length!==64||! /^[a-f0-9]{64}$/.test(file.sha256))fail('The saved model could not be read as one stable file.');
 const matches=[];
 for(const op of Object.values(snapshot.operations??{})){
  const result=op?.result,r=result?.native_artifact_receipt;
  if(!sameBinding(op.binding,binding)||!sameBinding(result?.binding,binding)||op.requested_effect!=='apply'
    ||op.request_identity?.method!=='POST'||op.request_identity?.path!=='/revit/save-as'
    ||op.dispatch_state!=='dispatched'||op.persistent_effect!=='applied'||result.authority!=='native-host'
    ||result.status!=='succeeded'||result.dispatch_state!=='dispatched'||result.persistent_effect!=='applied')continue;
  let effect;try{effect=validateReceipt(r,'POST','/revit/save-as','apply');}catch{continue;}
  if(effect!=='applied'||typeof r.saved_revit_version!=='string'||r.saved_revit_version.length!==4||! /^20[2-3][0-9]$/.test(r.saved_revit_version))continue;
  if(r.outputs?.length!==1||!samePath(r.save_document?.after?.path,filePath))continue;
  const saved=r.outputs[0];
  if(samePath(saved.path,filePath)&&saved.sha256===file.sha256&&saved.size_bytes===file.size_bytes&&saved.stable_read===true)
   matches.push({year:r.saved_revit_version,operation:op.operation_id});
 }
 if(!matches.length)fail('No matching native SaveAs version is available for these model bytes. Open the model explicitly in its producing Revit version.');
 if(new Set(matches.map(m=>m.year)).size!==1)fail('Saved model version evidence conflicts; no application was launched.');
 const year=matches[0].year;
 return{executable:`C:\\Program Files\\Autodesk\\Revit ${year}\\Revit.exe`,args:[filePath],revit_version:year,
  source_operation_ids:matches.map(m=>m.operation),sha256:file.sha256,size_bytes:file.size_bytes,
  scope:'Native saved-file application hint only; not model-content, effect or whole-task verification.'};
}
