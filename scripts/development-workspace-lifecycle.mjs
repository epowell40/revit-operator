import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {Archive,under,direct} from './development-archive.mjs';

/** Called only after the harness has stopped its owned processes and reduced
 * canonical events. Nonterminal/unknown work is retained, regardless of age. */
export const DEVELOPMENT_ARCHIVE_BUDGET={maxBytes:5*1024**3,maxGroups:1000};
export const DEVELOPMENT_WORKSPACE_BUDGET={maxBytes:10*1024**3,maxWorkspaces:8,minFreeBytes:5*1024**3,reservedBytes:1024**3};
/** Admission only: every existing workspace counts, including paused/unknown
 * experiments. This function never deletes work or rewrites canonical state. */
export function admitDevelopmentWorkspace({root,workspace,policy=DEVELOPMENT_WORKSPACE_BUDGET}){
 root=path.resolve(root);workspace=path.resolve(workspace);direct(root);direct(workspace);
 assert(path.dirname(workspace)===root,'Fresh workspace must be a direct child of its approved development root');
 for(const [key,value]of Object.entries(policy))assert(Number.isSafeInteger(value)&&value>=0,'Invalid workspace budget '+key);
 assert(['maxBytes','maxWorkspaces','minFreeBytes','reservedBytes'].every(key=>Number.isSafeInteger(policy[key])),'Complete workspace budget required');
 assert(!fs.existsSync(workspace),'Workspace must be fresh');
 const rows=[];let bytes=0;
 for(const entry of fs.readdirSync(root,{withFileTypes:true})){
  const candidate=path.join(root,entry.name),legacy=/^isolated-api-workspace(?:\d+)?$/.test(entry.name);
  if(!legacy&&!fs.existsSync(path.join(candidate,'.test-workspace.json')))continue;
  assert(entry.isDirectory()&&!entry.isSymbolicLink(),'Development workspace reparse/non-directory refused');direct(candidate);
  let size=0;const todo=[candidate];
  while(todo.length){const folder=todo.pop();for(const child of fs.readdirSync(folder,{withFileTypes:true})){
   const file=path.join(folder,child.name);assert(!child.isSymbolicLink(),'Development workspace reparse child refused');
   if(child.isDirectory())todo.push(file);else{const st=fs.lstatSync(file);assert(st.isFile(),'Unsupported development workspace entry');size+=st.size;}
  }}
  rows.push({workspace:candidate,bytes:size});bytes+=size;
 }
 assert(rows.length+1<=policy.maxWorkspaces,'Aggregate development workspace count budget reached; close/archive served work before another test');
 assert(bytes+policy.reservedBytes<=policy.maxBytes,'Aggregate development workspace byte budget reached; active/pending work stays protected');
 const disk=fs.statfsSync(root),free=disk.bavail*disk.bsize;
 assert(free>=policy.minFreeBytes+policy.reservedBytes,'Development workspace headroom budget reached');
 return{state:'admitted',root,workspace,existingWorkspaces:rows.length,expandedBytes:bytes,freeBytes:free,policy,rows};
}
export function finalizeDevelopmentWorkspace({workspace,allowedRoot,archiveStore,protectedPaths=[],outcome,activity,budget=DEVELOPMENT_ARCHIVE_BUDGET}){
 assert(['success','failure','cancellation','timeout'].includes(outcome),'Explicit test outcome required');
 assert(under(allowedRoot,workspace)&&path.resolve(workspace)!==path.resolve(allowedRoot),'Owned child workspace required');
 direct(workspace);direct(archiveStore);
 assert(!under(workspace,archiveStore),'Archive must live outside the expanded workspace');
 if(activity.processesAlive||!activity.terminal||!activity.quiescent||activity.unknown||activity.pendingUsage)
  return{state:'protected',outcome,reason:'active_or_pending_work',activity,workspace};
 const catalog=path.join(archiveStore,'groups.jsonl');
 if(fs.existsSync(catalog)){const groups=new Set(fs.readFileSync(catalog,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(g=>g.removed).map(g=>g.id));assert(groups.size<budget.maxGroups,'Development archive count budget reached; retire served evidence before another test');}
 const archive=new Archive(archiveStore,{maxBytes:budget.maxBytes});
 try{
  const result=archive.archiveTree(workspace,{allowedRoots:[allowedRoot],protectedPaths,excludeCredentials:true,remove:true});
  return{state:'archived',outcome,workspace,...result,stats:archive.stats};
 }finally{archive.close();}
}

export async function withDevelopmentWorkspace(options,run){
 let outcome='success',failed=false;
 try{return await run();}
 catch(error){failed=true;outcome=error?.name==='AbortError'?'cancellation':error?.name==='TimeoutError'?'timeout':'failure';throw error;}
 finally{try{const activity=await options.readActivity();options.onCleanup(finalizeDevelopmentWorkspace({...options,outcome,activity}));}
  catch(error){options.onCleanup({state:'cleanup_failed',outcome,error:String(error)});if(!failed)throw error;}}
}
