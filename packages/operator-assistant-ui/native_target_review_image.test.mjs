import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash}from'node:crypto';
import {readNativeTargetReviewImage}from'./native_target_review_image.mjs';
const pixels=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAYAAACM/rhtAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAcSURBVFhH7cEBAQAAAIIg/69uSEABAAAAAAB8GhkoAAFF1RG0AAAAAElFTkSuQmCC','base64');
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'native-review-image-')),captures=path.join(root,'captures');fs.mkdirSync(captures);const file=path.join(captures,'unique - Sheet - M002.png');fs.writeFileSync(file,pixels);
 const native={path:file,bytes:pixels.length,sha256:createHash('sha256').update(pixels).digest('hex'),viewId:41,exportMode:'full_view',canonical_attempt_settlement:{method:'POST',path:'/revit/export-image',requested_effect:'read',effect_state:'none'}};
 return{root,captures,file,native,dispose:()=>fs.rmSync(root,{recursive:true,force:true})};}
test('host-native capture reader returns hash-bound actual bytes only from capture roots',()=>{const f=fixture();try{const r=readNativeTargetReviewImage(f.native,[f.captures]);assert.equal(r.available,true);assert.equal(r.mime_type,'image/png');assert.equal(r.image_base64,pixels.toString('base64'));}finally{f.dispose();}});
test('foreign paths, symlink escapes, malformed receipts and changed files never become reviewer pixels',()=>{const f=fixture();try{
 const outside=path.join(f.root,'outside');fs.mkdirSync(outside);const external=path.join(outside,'image.png');fs.writeFileSync(external,pixels);
 const link=path.join(f.captures,'escape');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');
 for(const bad of [{...f.native,path:external},{...f.native,path:path.join(link,'image.png')},{...f.native,path:'relative.png'},{...f.native,bytes:0},{...f.native,bytes:10_000_000},{...f.native,sha256:'a'.repeat(64)},{...f.native,canonical_attempt_settlement:{...f.native.canonical_attempt_settlement,effect_state:'unknown'}},{...f.native,exportMode:'actor_region'}])assert.equal(readNativeTargetReviewImage(bad,[f.captures]).available,false);
 fs.appendFileSync(f.file,'changed');assert.equal(readNativeTargetReviewImage(f.native,[f.captures]).available,false);
}finally{f.dispose();}});
test('file replacement between approval/open/read is refused even with identical bytes',()=>{for(const key of ['afterResolve','afterOpen']){const f=fixture();try{const r=readNativeTargetReviewImage(f.native,[f.captures],{[key]:()=>{fs.renameSync(f.file,f.file+'.old');fs.writeFileSync(f.file,pixels);}});assert.equal(r.available,false);assert.match(r.reason,/identity_changed/);}finally{f.dispose();}}});

test('native visible-region transport accepts bound bytes and retains capture-root, hash, settlement and file identity guards',()=>{
 const f=fixture();try{
  const native={...f.native,exportMode:'visible_region'};
  assert.equal(readNativeTargetReviewImage(native,[f.captures]).image_base64,pixels.toString('base64'));
  const outside=path.join(f.root,'foreign.png');fs.writeFileSync(outside,pixels);
  for(const bad of [{...native,path:outside},{...native,sha256:'b'.repeat(64)},{...native,canonical_attempt_settlement:{...native.canonical_attempt_settlement,effect_state:'unknown'}}])assert.equal(readNativeTargetReviewImage(bad,[f.captures]).available,false);
  const swapped=readNativeTargetReviewImage(native,[f.captures],{afterOpen:()=>{fs.renameSync(f.file,f.file+'.old');fs.writeFileSync(f.file,pixels);}});
  assert.equal(swapped.available,false);assert.match(swapped.reason,/identity_changed/);
 }finally{f.dispose();}
});
