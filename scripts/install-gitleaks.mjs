// Explicit developer/CI setup only. Ordinary checks never download executables.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const pin=JSON.parse(fs.readFileSync(new URL('./gitleaks-release.json',import.meta.url),'utf8'));
const asset=pin.assets[`${process.platform}-${process.arch}`];
if(!asset)throw Error('Unsupported scanner platform; provide the pinned scanner explicitly.');
const target=path.resolve(process.argv[2]||path.join(import.meta.dirname,'../local-work/tools',`gitleaks-${pin.version}`));
fs.mkdirSync(target,{recursive:true});
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'operator-gitleaks-install-'));
try{
  const response=await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${pin.version}/${asset.name}`,{signal:AbortSignal.timeout(120_000)});
  if(!response.ok)throw Error('Pinned scanner download failed.');
  const chunks=[];let size=0;
  for await(const chunk of response.body){size+=chunk.length;if(size>32*1024**2)throw Error('Scanner archive exceeds32MiB.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);
  if(createHash('sha256').update(bytes).digest('hex')!==asset.sha256)throw Error('Pinned scanner archive digest mismatch.');
  const archive=path.join(temp,asset.name);fs.writeFileSync(archive,bytes,{flag:'wx'});
  const name=process.platform==='win32'?'gitleaks.exe':'gitleaks';
  const unpack=spawnSync('tar',['-xf',archive,'-C',temp,name],{windowsHide:true,stdio:'pipe',timeout:30_000});
  if(unpack.status!==0)throw Error('Pinned scanner extraction failed.');
  const executable=path.join(temp,name),stat=fs.lstatSync(executable);
  if(!stat.isFile()||stat.isSymbolicLink())throw Error('Invalid scanner archive entry.');
  fs.copyFileSync(executable,path.join(target,name));
  if(process.platform!=='win32')fs.chmodSync(path.join(target,name),0o700);
  fs.writeFileSync(path.join(target,'install-receipt.json'),JSON.stringify({version:pin.version,archiveSha256:asset.sha256,
    executableSha256:createHash('sha256').update(fs.readFileSync(executable)).digest('hex')},null,2));
  console.log(path.join(target,name));
}finally{
  if(path.dirname(temp)!==path.resolve(os.tmpdir())||!path.basename(temp).startsWith('operator-gitleaks-install-'))throw Error('Refusing scanner staging cleanup.');
  fs.rmSync(temp,{recursive:true,force:true});
}
