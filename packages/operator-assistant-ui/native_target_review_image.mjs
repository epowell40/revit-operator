import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const under=(file,root)=>samePath(file,root)||(process.platform==='win32'?file.toLowerCase().startsWith((root+path.sep).toLowerCase()):file.startsWith(root+path.sep));
const sameFile=(a,b)=>a.dev!==0n&&a.ino!==0n&&a.dev===b.dev&&a.ino===b.ino;

/** Host-only native export reader. Roots are capture directories selected by
 * the host, not tool arguments. The exact authorized native receipt binds bytes.
 * This is deliberately narrower than general attachment/workspace file access. */
export function readNativeTargetReviewImage(native,captureRoots,hooks={}){
  let fd=null;
  try{
    const receipt=native?.canonical_attempt_settlement;
    if(receipt?.method!=='POST'||receipt.path!=='/revit/export-image'||receipt.requested_effect!=='read'||receipt.effect_state!=='none'
      ||!Number.isSafeInteger(native.viewId)||native.viewId<=0||!['full_view','visible_region'].includes(native.exportMode)
      ||typeof native.path!=='string'||!path.isAbsolute(native.path)||!Number.isSafeInteger(native.bytes)||native.bytes<=0||native.bytes>5*1024*1024
      ||typeof native.sha256!=='string'||!/^[a-f0-9]{64}$/.test(native.sha256))throw Error('native_image_receipt_invalid');
    const file=path.resolve(native.path),roots=captureRoots.map(root=>path.resolve(root));
    if(!roots.some(root=>under(file,root)))throw Error('native_image_outside_capture_root');
    const real=fs.realpathSync(file),realRoots=roots.flatMap(root=>{try{return[fs.realpathSync(root)];}catch{return[];}});
    if(!realRoots.some(root=>under(real,root)))throw Error('native_image_resolves_outside_capture_root');
    const approved=fs.statSync(real,{bigint:true});if(!approved.isFile()||approved.size!==BigInt(native.bytes))throw Error('native_image_file_invalid');
    hooks.afterResolve?.();
    fd=fs.openSync(real,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));hooks.afterOpen?.();
    const opened=fs.fstatSync(fd,{bigint:true});
    if(!sameFile(approved,opened)||!samePath(fs.realpathSync(file),real)||!sameFile(opened,fs.statSync(file,{bigint:true})))throw Error('native_image_identity_changed');
    const bytes=Buffer.alloc(native.bytes+1);let count=0;
    while(count<bytes.length){const n=fs.readSync(fd,bytes,count,bytes.length-count,null);if(!n)break;count+=n;}
    const data=bytes.subarray(0,count);
    if(count!==native.bytes||createHash('sha256').update(data).digest('hex')!==native.sha256)throw Error('native_image_pixels_changed');
    const mime=data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png'
      :data.length>=3&&data[0]===255&&data[1]===216&&data[2]===255?'image/jpeg':null;
    if(!mime)throw Error('native_image_format_invalid');
    return {available:true,image_base64:data.toString('base64'),mime_type:mime};
  }catch(error){return{available:false,reason:error instanceof Error?error.message:'native_image_unavailable'};}
  finally{if(fd!==null)try{fs.closeSync(fd);}catch{}}
}
