import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {reduceAssignmentEventsV2} from '../domain/assignment-kernel/reducer.js';
import type {EvidenceRefV1} from './evidence_ref.js';

export const IMAGE_EVIDENCE_RETENTION={maxBytes:1024**3,maxObjects:1000,maxAgeMs:7*24*3600_000,minFreeBytes:1024**3} as const;
type Policy={maxBytes:number;maxObjects:number;maxAgeMs:number;minFreeBytes:number};
type Row={hash:string;file:string;bytes:number;at:number;refs:EvidenceRefV1[]};
type State={at:number;rows:Map<string,Row>};
const states=new Map<string,State>();
function direct(root:string,file:string):void {
 const relative=path.relative(root,file);if(relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('image_retention_path_escape');
 for(let cursor=path.resolve(file);;){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw Error('image_retention_reparse_path');const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}
}
function objectFile(evidence:string,hash:string):string {return path.join(evidence,'objects','sha256',hash.slice(0,2),hash+'.bin');}
function scan(evidence:string,now:number):State {
 const rows=new Map<string,Row>(),refs=path.join(evidence,'refs');direct(evidence,refs);
 if(fs.existsSync(refs))for(const name of fs.readdirSync(refs)){
  if(!/^ev1_[A-Za-z0-9_-]{32}\.json$/.test(name))continue;
  const file=path.join(refs,name);direct(evidence,file);const ref=JSON.parse(fs.readFileSync(file,'utf8')) as EvidenceRefV1;
  const hash=ref.content_hash?.replace(/^sha256:/,'');if(ref.schema!=='revit-operator.evidence-ref.v1'||!hash||!/^[a-f0-9]{64}$/.test(hash))throw Error('image_retention_scan_incomplete');
  const expected=path.posix.join('evidence','objects','sha256',hash.slice(0,2),hash+'.bin');
  if(ref.artifact_location!==expected&&!(ref.artifact_location===expected+'.gz'&&!ref.media_type.startsWith('image/'))||!Number.isSafeInteger(ref.byte_count)||!Number.isFinite(Date.parse(ref.created_at_utc)))throw Error('image_retention_scan_incomplete');
  const object=path.resolve(workspaceParent(evidence),ref.artifact_location);direct(evidence,object);if(!fs.existsSync(object))continue;
  const row=rows.get(hash)??{hash,file:object,bytes:fs.statSync(object).size,at:0,refs:[]};
  row.refs.push(ref);row.at=Math.max(row.at,Date.parse(ref.created_at_utc)||now);rows.set(hash,row);
 }
 // Non-image objects cannot be deleted, even when identical bytes also have an image ref.
 return{at:now,rows:new Map([...rows].filter(([,r])=>r.refs.some(ref=>ref.media_type?.startsWith('image/'))))};
}
function workspaceParent(evidence:string):string {return path.dirname(evidence);}
function terminalAssignments(workspace:string):Set<string> {
 const result=new Set<string>(),goals=path.join(workspace,'artifacts','goals');direct(workspace,goals);
 if(!fs.existsSync(goals))return result;
 for(const name of fs.readdirSync(goals)){
  const file=path.join(goals,name,'goal.json');direct(workspace,file);if(!fs.existsSync(file))continue;
  try{
   const goal=JSON.parse(fs.readFileSync(file,'utf8'));if(!Array.isArray(goal.assignment_kernel_v2?.events))continue;
   const snapshot=reduceAssignmentEventsV2(goal.assignment_kernel_v2.events);
   if(snapshot.terminal&&snapshot.quiescent&&!snapshot.unresolved_unknown_operation_ids.length&&!snapshot.in_flight_provider_call_ids.length&&Object.values(snapshot.provider_calls).every(c=>c.usage))result.add(snapshot.current_binding.assignment_id);
  }catch{ /* malformed, interrupted or legacy state remains protected */ }
 }
 return result;
}
function appendAudit(evidence:string,row:unknown):void {
 const file=path.join(evidence,'image-retention.jsonl');direct(evidence,file);
 if(fs.existsSync(file)&&fs.statSync(file).size>1024**2){
  const oldest=file+'.3';if(fs.existsSync(oldest))fs.unlinkSync(oldest);
  for(let i=2;i>=1;i--)if(fs.existsSync(file+'.'+i))fs.renameSync(file+'.'+i,file+'.'+(i+1));fs.renameSync(file,file+'.1');
 }
 fs.appendFileSync(file,JSON.stringify(row)+'\n');
}
export function sweepImageEvidence(workspace:string,evidence:string,options:{now?:number;policy?:Policy;terminalAssignments?:Set<string>}={}){
 const now=options.now??Date.now(),policy=options.policy??IMAGE_EVIDENCE_RETENTION,state=scan(evidence,now),terminal=options.terminalAssignments??terminalAssignments(workspace);
 let bytes=[...state.rows.values()].reduce((n,r)=>n+r.bytes,0),objects=state.rows.size,removedBytes=0,removedObjects=0;
 const pinsFile=path.join(evidence,'retention-pins.json');direct(evidence,pinsFile);
 const pins=new Set<string>(fs.existsSync(pinsFile)?JSON.parse(fs.readFileSync(pinsFile,'utf8')).content_hashes??[]:[]);
 for(const row of [...state.rows.values()].sort((a,b)=>a.at-b.at)){
  const protectedRow=pins.has('sha256:'+row.hash)||row.refs.some(ref=>!ref.media_type?.startsWith('image/')||!ref.assignment_id||!terminal.has(ref.assignment_id)||['required','authoritative'].includes(ref.verification_relevance));
  if(protectedRow||now-row.at<=policy.maxAgeMs&&bytes<=policy.maxBytes&&objects<=policy.maxObjects)continue;
  direct(evidence,row.file);const raw=fs.readFileSync(row.file);if(createHash('sha256').update(raw).digest('hex')!==row.hash)throw Error('image_retention_digest_mismatch');
  // Preserve immutable refs, bindings and an explicit expiry audit. Never edit
  // a native observation/criterion or manufacture replacement image evidence.
  appendAudit(evidence,{at:new Date(now).toISOString(),event:'image_expired',content_hash:'sha256:'+row.hash,bytes:row.bytes,evidence_ids:row.refs.map(r=>r.evidence_id),reason:now-row.at>policy.maxAgeMs?'age':'storage_budget'});
  fs.unlinkSync(row.file);state.rows.delete(row.hash);bytes-=row.bytes;objects--;removedBytes+=row.bytes;removedObjects++;
 }
 states.set(evidence,state);while(states.size>8)states.delete(states.keys().next().value!);
 return{bytes,objects,removedBytes,removedObjects};
}
export function admitEvidenceImage(workspace:string,evidence:string,hash:string,bytes:number,policy:Policy=IMAGE_EVIDENCE_RETENTION):void {
 const now=Date.now();let state=states.get(evidence);
 if(!state||now-state.at>60_000){sweepImageEvidence(workspace,evidence,{policy});state=states.get(evidence)!;}
 let total=[...state.rows.values()].reduce((n,r)=>n+r.bytes,0),count=state.rows.size;
 if(!state.rows.has(hash)&&(total+bytes>policy.maxBytes||count+1>policy.maxObjects)){
  // Reserve this incoming image before the sweep; never exceed the cap merely
  // because all retained work is active, pinned, unknown or awaiting usage.
  const result=sweepImageEvidence(workspace,evidence,{policy:{...policy,maxBytes:Math.max(0,policy.maxBytes-bytes),maxObjects:policy.maxObjects-1}});total=result.bytes;count=result.objects;state=states.get(evidence)!;
 }
 if(!state.rows.has(hash)&&(total+bytes>policy.maxBytes||count+1>policy.maxObjects))throw Error('image_storage_budget_reached: active or required evidence is protected; archive completed work before capturing more');
 const disk=fs.statfsSync(evidence);if(disk.bavail*disk.bsize<policy.minFreeBytes+bytes)throw Error('image_storage_disk_headroom');
}
export function noteStoredEvidenceImage(evidence:string,ref:EvidenceRefV1):void {
 const state=states.get(evidence);if(!state)return;const hash=ref.content_hash.replace(/^sha256:/,''),row=state.rows.get(hash)??{hash,file:objectFile(evidence,hash),bytes:ref.byte_count,at:Date.parse(ref.created_at_utc),refs:[]};
 if(!row.refs.some(r=>r.evidence_id===ref.evidence_id))row.refs.push(ref);row.at=Math.max(row.at,Date.parse(ref.created_at_utc));state.rows.set(hash,row);
}
