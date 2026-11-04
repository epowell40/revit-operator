import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export const CODEX_ISOLATION_RETENTION = {maxAgeMs:24*3600_000,maxEntries:4,maxBytes:512*1024*1024,minFreeBytes:1024*1024*1024} as const;
type Policy={maxAgeMs:number;maxEntries:number;maxBytes:number;minFreeBytes:number};
// Observe every ancestor once, including absent paths; avoid an exists/stat race
// and redundant metadata round trips. Permission and other I/O errors still throw.
function direct(p:string):void {for(let current=path.resolve(p);;){if(fs.lstatSync(current,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('codex_isolation_reparse_path');const parent=path.dirname(current);if(parent===current)break;current=parent;}}
function child(base:string,p:string):boolean {const r=path.relative(base,p);return !!r&&r!=='..'&&!r.startsWith('..'+path.sep)&&!path.isAbsolute(r);}
function alive(pid:number):boolean {if(!Number.isSafeInteger(pid)||pid<1)return true;try{process.kill(pid,0);return true;}catch(e:any){return e.code!=='ESRCH';}}
function size(p:string):number {const st=fs.lstatSync(p);if(st.isSymbolicLink())return 0;if(st.isFile())return st.size;return fs.readdirSync(p).reduce((n,k)=>n+size(path.join(p,k)),0);}
function remove(base:string,p:string):void {if(!child(base,p))throw Error('codex_isolation_cleanup_escape');direct(path.dirname(p));const st=fs.lstatSync(p);if(st.isSymbolicLink()){try{fs.unlinkSync(p);}catch(e:any){if(!['EPERM','EISDIR'].includes(e.code))throw e;fs.rmdirSync(p);}return;}if(st.isDirectory()){for(const k of fs.readdirSync(p))remove(base,path.join(p,k));fs.rmdirSync(p);}else{try{fs.unlinkSync(p);}catch(e:any){if(e.code!=='EPERM'||st.nlink>1)throw e;fs.chmodSync(p,0o600);fs.unlinkSync(p);}}}
async function removeAsync(base:string,p:string):Promise<void> {
 if(!child(base,p))throw Error('codex_isolation_cleanup_escape');
 const st=await fs.promises.lstat(p);
 if(st.isDirectory()&&!st.isSymbolicLink()){
  const names=await fs.promises.readdir(p);
  for(let i=0;i<names.length;i+=8)await Promise.all(names.slice(i,i+8).map(k=>removeAsync(base,path.join(p,k))));
  await fs.promises.rmdir(p);
 }else try{await fs.promises.unlink(p);}catch(e:any){if(e.code!=='EPERM'||st.nlink>1)throw e;await fs.promises.chmod(p,0o600);await fs.promises.unlink(p);}
}
export function pruneCodexIsolation(baseRoot:string,policy:Policy=CODEX_ISOLATION_RETENTION,now=Date.now()) {
 const base=path.resolve(baseRoot,'ephemeral-v2');direct(base);fs.mkdirSync(base,{recursive:true});
 const rows:Array<{root:string;at:number;bytes:number;active:boolean}>=[];
 for(const e of fs.readdirSync(base,{withFileTypes:true})){
  if(!e.isDirectory()||!/^[a-f0-9-]{36}$/.test(e.name))continue;
  const root=path.join(base,e.name);direct(root);let meta:any;try{meta=JSON.parse(fs.readFileSync(path.join(root,'isolation.json'),'utf8'));}catch{continue;}
  if(meta.schema!=='operator.ephemeral-codex-isolation/v1'||!Number.isFinite(meta.createdAt))continue;
  rows.push({root,at:meta.closedAt??meta.createdAt,bytes:size(root),active:(!meta.closedAt||meta.closing===true)&&alive(meta.pid)});
 }
 rows.sort((a,b)=>b.at-a.at);let retainedBytes=0,retained=0,removed=0;
 for(const row of rows){if(!row.active&&(now-row.at>policy.maxAgeMs||retained>=policy.maxEntries||retainedBytes+row.bytes>policy.maxBytes)){remove(base,row.root);removed++;}else{retained++;retainedBytes+=row.bytes;}}
 return {base,retained,retainedBytes,removed};
}
export function acquireCodexIsolation(baseRoot:string,workspaceHash:string,options:{policy?:Policy;freeBytes?:()=>number}={}) {
 const policy=options.policy??CODEX_ISOLATION_RETENTION;
 if(!/^[a-f0-9]{24}$/.test(workspaceHash))throw Error('codex_isolation_workspace_identity');
 const pruned=pruneCodexIsolation(baseRoot,policy);
 const free=options.freeBytes?.()??(()=>{const s=fs.statfsSync(pruned.base);return s.bavail*s.bsize;})();
 if(free<policy.minFreeBytes||pruned.retainedBytes>policy.maxBytes)throw Error('codex_isolation_disk_headroom');
 const root=path.join(pruned.base,randomUUID()),createdAt=Date.now(),meta={schema:'operator.ephemeral-codex-isolation/v1',pid:process.pid,workspaceHash,createdAt};
 fs.mkdirSync(root);fs.writeFileSync(path.join(root,'isolation.json'),JSON.stringify(meta),{flag:'wx',mode:0o600});
 let releasing:Promise<void>|null=null;
 return {root,release:()=>releasing??=(async()=>{direct(root);const current=JSON.parse(fs.readFileSync(path.join(root,'isolation.json'),'utf8'));if(current.pid!==process.pid||current.createdAt!==createdAt||current.workspaceHash!==workspaceHash)throw Error('codex_isolation_release_owner_changed');
  fs.writeFileSync(path.join(root,'isolation.json'),JSON.stringify({...meta,closedAt:Date.now(),closing:true}),{mode:0o600});
  await removeAsync(pruned.base,root);
 })()};
}
