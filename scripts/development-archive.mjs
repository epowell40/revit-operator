// Private development-evidence archive. No model/tool execution or network access.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {createHash,randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const sha=b=>createHash('sha256').update(b).digest('hex');
export const under=(base,p)=>{const r=path.relative(path.resolve(base),path.resolve(p));return r===''||!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r);};
export function direct(p){let cursor=path.resolve(p);while(true){if(fs.existsSync(cursor)&&fs.lstatSync(cursor).isSymbolicLink())throw Error('Reparse path refused: '+cursor);const parent=path.dirname(cursor);if(parent===cursor)break;cursor=parent;}}
export class Archive {
 constructor(store,{maxBytes=Infinity}={}){this.store=path.resolve(store);direct(this.store);fs.mkdirSync(this.store,{recursive:true});this.maximumBytes=maxBytes;this.occupiedBytes=fs.readdirSync(this.store).filter(n=>n.endsWith('.bin')).reduce((n,p)=>n+fs.statSync(path.join(this.store,p)).size,0);this.index=new Map();this.verified=new Set();this.catalog=path.join(this.store,'groups.jsonl');this.indexFile=path.join(this.store,'objects.jsonl');
  if(fs.existsSync(this.indexFile))for(const line of fs.readFileSync(this.indexFile,'utf8').trim().split('\n').filter(Boolean)){const e=JSON.parse(line);assert(/^[a-f0-9]{64}$/.test(e.h));this.index.set(e.h,e);}
  this.packName='pack-'+Date.now()+'-'+randomUUID()+'.bin';this.pack=path.join(this.store,this.packName);this.fd=fs.openSync(this.pack,'wx');this.offset=0;this.idx=fs.openSync(this.indexFile,'a');this.stats={sourceFiles:0,sourceBytes:0,uniqueObjects:0,storedBytes:0,deletedFiles:0,deletedLogicalBytes:0,credentialsRemoved:0};
 }
 put(bytes){const h=sha(bytes);let item=this.index.get(h);if(!item){const compressed=zlib.gzipSync(bytes,{level:3});if(this.occupiedBytes+compressed.length>this.maximumBytes)throw Error('Development archive byte budget reached; retire served evidence before another test');if(fs.statfsSync(this.store).bavail*fs.statfsSync(this.store).bsize<1_500_000_000+compressed.length)throw Error('Archive headroom guard');
   item={h,pack:this.packName,offset:this.offset,length:compressed.length,bytes:bytes.length,codec:'gzip'};let written=0;while(written<compressed.length)written+=fs.writeSync(this.fd,compressed,written,compressed.length-written,this.offset+written);this.offset+=compressed.length;
   fs.writeSync(this.idx,JSON.stringify(item)+'\n');this.index.set(h,item);this.stats.uniqueObjects++;this.stats.storedBytes+=compressed.length;this.occupiedBytes+=compressed.length;}
  if(!this.verified.has(h)){const data=this.get(h);assert.equal(data.length,bytes.length);assert.equal(sha(data),h);this.verified.add(h);}return h;
 }
 get(h){const e=this.index.get(h);assert(e&&e.codec==='gzip'&&path.basename(e.pack)===e.pack);const packed=Buffer.alloc(e.length),fd=fs.openSync(path.join(this.store,e.pack),'r');try{assert.equal(fs.readSync(fd,packed,0,e.length,e.offset),e.length);}finally{fs.closeSync(fd);}const raw=zlib.gunzipSync(packed);assert.equal(raw.length,e.bytes);assert.equal(sha(raw),h);return raw;}
 archiveTree(root,{allowedRoots,protectedPaths=[],excludeCredentials=false,remove=false}={}){
  root=path.resolve(root);assert(allowedRoots.some(b=>under(b,root)&&path.resolve(b).toLowerCase()!==root.toLowerCase()),'Explicit child of an approved root required');direct(root);
  const protectedHere=protectedPaths.filter(b=>under(root,b)||under(b,root));
  const protectedAt=p=>protectedHere.some(b=>under(b,p));assert(!protectedAt(root),'Protected work');const records=[],dirs=[],todo=[root];
  while(todo.length){const folder=todo.pop();assert(!fs.lstatSync(folder).isSymbolicLink());dirs.push(folder);for(const e of fs.readdirSync(folder,{withFileTypes:true})){const p=path.join(folder,e.name);if(protectedAt(p))continue;if(e.isSymbolicLink())throw Error('Reparse child refused: '+p);if(e.isDirectory()){todo.push(p);continue;}const st=fs.lstatSync(p);assert(st.isFile());
   const secret=excludeCredentials&&/^(?:auth\.json|credentials(?:\.json)?|.*\.token)$/i.test(e.name);
   let h=null;if(!secret){const bytes=fs.readFileSync(p);const after=fs.statSync(p);assert.equal(after.size,st.size);assert.equal(after.mtimeMs,st.mtimeMs);h=this.put(bytes);}
   records.push({p:path.relative(root,p),h,bytes:st.size,mtime:st.mtimeMs,mode:st.mode,links:st.nlink,credentialCopy:secret});this.stats.sourceFiles++;this.stats.sourceBytes+=st.size;
  }}
  fs.fsyncSync(this.fd);fs.fsyncSync(this.idx);
  const id=sha(Buffer.from(root)).slice(0,24)+'-'+Date.now(),manifestFile=id+'.manifest.json.gz';
  const manifest={schema:'operator.development-archive/v1',root,createdAt:new Date().toISOString(),records};const raw=Buffer.from(JSON.stringify(manifest));
  fs.writeFileSync(path.join(this.store,manifestFile),zlib.gzipSync(raw,{level:6}),{flag:'wx'});
  const verified=JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(this.store,manifestFile))).toString('utf8'));assert.deepEqual(verified,manifest);
  direct(root);for(const folder of dirs)assert(!fs.lstatSync(folder).isSymbolicLink());
  for(const r of records){const p=path.resolve(root,r.p);assert(under(root,p)&&!protectedAt(p));const st=fs.lstatSync(p);assert(!st.isSymbolicLink());assert.equal(st.size,r.bytes);assert.equal(st.mtimeMs,r.mtime);if(r.h)assert(this.verified.has(r.h));}
  const catalog={id,root,manifest:manifestFile,manifestSha256:sha(raw),files:records.length,bytes:records.reduce((a,r)=>a+r.bytes,0),verified:true,removed:false,at:new Date().toISOString()};
  fs.appendFileSync(this.catalog,JSON.stringify(catalog)+'\n');
  if(remove){direct(root);for(const folder of dirs)assert(!fs.lstatSync(folder).isSymbolicLink());for(const r of records){const p=path.resolve(root,r.p);assert(under(root,p)&&!protectedAt(p));const st=fs.lstatSync(p);assert(!st.isSymbolicLink());assert.equal(st.size,r.bytes);assert.equal(st.mtimeMs,r.mtime);try{fs.unlinkSync(p);}catch(e){if(e.code!=='EPERM')throw e;if(st.nlink>1){catalog.retainedReadonlyHardlinks=(catalog.retainedReadonlyHardlinks??0)+1;continue;}fs.chmodSync(p,0o666);fs.unlinkSync(p);}this.stats.deletedFiles++;this.stats.deletedLogicalBytes+=r.bytes;if(r.credentialCopy)this.stats.credentialsRemoved++;}
   for(const dir of dirs.sort((a,b)=>b.length-a.length))try{fs.rmdirSync(dir);}catch(e){if(!['ENOTEMPTY','EEXIST'].includes(e.code))throw e;}
   catalog.removed=true;catalog.fullyRemoved=!fs.existsSync(root);catalog.at=new Date().toISOString();fs.appendFileSync(this.catalog,JSON.stringify(catalog)+'\n');}
  return catalog;
 }
 close(){fs.fsyncSync(this.fd);fs.fsyncSync(this.idx);fs.closeSync(this.fd);fs.closeSync(this.idx);if(!this.offset)fs.unlinkSync(this.pack);}
}
export function restoreFile(store,source,{allowedRoots}={}){
 source=path.resolve(source);assert(allowedRoots.some(b=>under(b,source)),'Restore outside approved roots');direct(source);
 const groups=fs.readFileSync(path.join(store,'groups.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(g=>under(g.root,source)).reverse();
 for(const group of groups){const raw=zlib.gunzipSync(fs.readFileSync(path.join(store,group.manifest)));assert.equal(sha(raw),group.manifestSha256);const m=JSON.parse(raw),r=m.records.find(x=>path.resolve(m.root,x.p).toLowerCase()===source.toLowerCase());if(!r)continue;if(r.credentialCopy)throw Error('Expired credential copies are intentionally not archived');
  const index=new Map(fs.readFileSync(path.join(store,'objects.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(l=>{const x=JSON.parse(l);return[x.h,x];})),e=index.get(r.h);assert(e&&path.basename(e.pack)===e.pack);const b=Buffer.alloc(e.length),fd=fs.openSync(path.join(store,e.pack),'r');try{assert.equal(fs.readSync(fd,b,0,b.length,e.offset),b.length);}finally{fs.closeSync(fd);}const bytes=zlib.gunzipSync(b);assert.equal(bytes.length,r.bytes);assert.equal(sha(bytes),r.h);
  if(fs.existsSync(source)){assert.equal(sha(fs.readFileSync(source)),r.h,'Existing restore target differs');return {source,alreadyPresent:true,sha256:r.h};}
  fs.mkdirSync(path.dirname(source),{recursive:true});direct(path.dirname(source));const tmp=source+'.restore-'+randomUUID();fs.writeFileSync(tmp,bytes,{flag:'wx'});try{fs.linkSync(tmp,source);}finally{fs.unlinkSync(tmp);}fs.chmodSync(source,r.mode&0o777);fs.utimesSync(source,r.mtime/1000,r.mtime/1000);assert.equal(sha(fs.readFileSync(source)),r.h);return{source,sha256:r.h,bytes:r.bytes,group:group.id};
 }throw Error('No archived mapping for '+source);
}
