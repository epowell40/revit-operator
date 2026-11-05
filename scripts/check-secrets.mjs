import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

export const GITLEAKS_VERSION=JSON.parse(fs.readFileSync(new URL('./gitleaks-release.json',import.meta.url),'utf8')).version;
const MAX_SCAN_BYTES=1024**3;
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const run=(binary,args,options)=>spawnSync(binary,args,{...options,encoding:'utf8',windowsHide:true,timeout:240_000,maxBuffer:16*1024**2});

/** Scan current tracked regular-file bytes, including staged additions. No
 * provider calls; no raw scanner output, values, history, or ignored local files
 * are published. Missing tools, partial scans and uncertain failures fail closed. */
export function checkTrackedSecrets(root,{execute=run,scanner=process.env.GITLEAKS_PATH,
  reviewedMatches=JSON.parse(fs.readFileSync(new URL('./secret-scan-reviewed-matches.json',import.meta.url),'utf8')).matches}={}){
  let temp;
  try{
    root=path.resolve(root);
    if(!Array.isArray(reviewedMatches)||reviewedMatches.length>500||reviewedMatches.some(r=>
      typeof r.file!=='string'||path.isAbsolute(r.file)||r.file.split('/').includes('..')
      ||!/^[a-z0-9-]{1,100}$/.test(r.rule)||!/^[a-f0-9]{64}$/.test(r.span_sha256)||typeof r.reason!=='string'||!r.reason.trim()))throw Error('reviewed matches');
    const git=execute('git',['-C',root,'rev-parse','--show-toplevel'],{});
    if(git.status!==0||!samePath(path.resolve(git.stdout.trim()),root))throw Error('root');
    scanner=scanner||path.join(import.meta.dirname,'../local-work/tools',`gitleaks-${GITLEAKS_VERSION}`,process.platform==='win32'?'gitleaks.exe':'gitleaks');
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>
      ['path','systemroot','windir','temp','tmp','lang','lc_all'].includes(key.toLowerCase())));
    const version=execute(scanner,['version'],{env});
    if(version.status!==0||version.stdout.trim().replace(/^v/,'')!==GITLEAKS_VERSION)
      return{code:2,message:`Secret scan unavailable: install pinned Gitleaks${GITLEAKS_VERSION} with scripts/install-gitleaks.mjs. No scan passed.`};
    const listing=execute('git',['-C',root,'ls-files','--stage','-z'],{});
    if(listing.status!==0)throw Error('listing');
    temp=fs.mkdtempSync(path.join(os.tmpdir(),'operator-secret-scan-'));
    const content=path.join(temp,'content');fs.mkdirSync(content);
    const config=path.join(temp,'scanner.toml');fs.writeFileSync(config,'[extend]\nuseDefault = true\n');
    let count=0,bytes=0,submodules=0;
    for(const row of listing.stdout.split('\0').filter(Boolean)){
      const match=/^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(row);
      if(!match||match[2]!=='0')throw Error('unmerged');
      if(match[1]==='160000'){submodules++;continue;}
      if(!['100644','100755'].includes(match[1]))throw Error('nonregular');
      const relative=match[3],file=path.resolve(root,relative),rel=path.relative(root,file);
      if(rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||!rel)throw Error('path');
      if(!samePath(fs.realpathSync(file),file)||!fs.lstatSync(file).isFile())throw Error('link');
      const size=fs.statSync(file).size,disk=fs.statfsSync(temp);
      if(bytes+size>MAX_SCAN_BYTES||disk.bavail*disk.bsize<1024**3+size)throw Error('capacity');
      const data=fs.readFileSync(file);bytes+=data.length;
      if(bytes>MAX_SCAN_BYTES)throw Error('capacity');
      const dest=path.join(content,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.writeFileSync(dest,data,{flag:'wx'});count++;
    }
    if(!count)throw Error('empty');
    const report=path.join(temp,'findings.json');
    const result=execute(scanner,['dir',content,'--config',config,'--gitleaks-ignore-path',temp,
      '--ignore-gitleaks-allow','--redact=100','--no-banner','--no-color','--max-target-megabytes=0',
      '--timeout=180','--exit-code=7','--report-format=json','--report-path',report],{env,cwd:temp});
    if(result.status!==0&&result.status!==7)throw Error('scanner');
    if(fs.statSync(report).size>16*1024**2)throw Error('report capacity');
    const findings=JSON.parse(fs.readFileSync(report,'utf8'));
    if(!Array.isArray(findings)||findings.length>10_000)throw Error('report');
    if(result.status===7){
      if(!findings.length)throw Error('empty findings');
      const locations=findings.map(f=>{
        if(typeof f.File!=='string'||typeof f.RuleID!=='string'||!/^[a-z0-9-]{1,100}$/.test(f.RuleID)
          ||!Number.isSafeInteger(f.StartLine)||f.StartLine<1||!Number.isSafeInteger(f.EndLine)||f.EndLine<f.StartLine)throw Error('finding');
        const relative=path.relative(content,path.resolve(temp,f.File));
        if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('finding path');
        const canonical=relative.replaceAll('\\','/').replace(/^(operator-backend|mcp-server|revit-bridge-addin)\//,'apps/$1/');
        const lines=fs.readFileSync(path.join(content,relative),'utf8').replaceAll('\r\n','\n').split('\n');
        if(f.EndLine>lines.length)throw Error('finding range');
        const span=createHash('sha256').update(lines.slice(f.StartLine-1,f.EndLine).join('\n')).digest('hex');
        const reviewed=reviewedMatches.some(r=>r.file===canonical&&r.rule===f.RuleID&&r.span_sha256===span);
        return{file:relative,rule:f.RuleID,line:f.StartLine,reviewed};
      });
      const unresolved=locations.filter(r=>!r.reviewed);
      if(unresolved.length)return{code:1,message:`Secret scan blocked: ${unresolved.length} potential credentials found. Scanner values and raw output were withheld. Review locally before release.`,locations:unresolved};
      return{code:0,message:`Secret scan passed: ${count} current tracked files; ${locations.length} exact reviewed non-credential spans, ${submodules} submodules require separate scans. No history, ignored/untracked or binary/archive assurance.`};
    }
    if(findings.length)throw Error('report');
    return{code:0,message:`Secret scan passed: ${count} current tracked files (${bytes} bytes); ${submodules} submodules require separate scans. Git history, ignored/untracked files and binary/archive contents are not qualified.`};
  }catch{
    return{code:2,message:'Secret scan incomplete or failed. Raw scanner/git output withheld; no clean result asserted.'};
  }finally{
    if(temp){
      if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('operator-secret-scan-'))throw Error('Refusing scanner snapshot cleanup.');
      fs.rmSync(temp,{recursive:true,force:true});
    }
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const result=checkTrackedSecrets(process.argv[2]||'.');console.log(result.message);process.exitCode=result.code;
}
