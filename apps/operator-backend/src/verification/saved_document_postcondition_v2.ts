import path from 'node:path';
import { nativeArtifactReceiptEffectV1 } from '@revitoperator/assignment-kernel-v2-contracts';
import { nativeArtifactPostconditionV2 } from './native_artifact_contract_v2.js';

const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const normalized=(v:unknown)=>typeof v==='string'&&v.length>0&&v.length<=2000&&!/[\u0000-\u001f]/.test(v)
  ?path.win32.normalize(v).replaceAll('\\','/').toLowerCase():null;

/** Exact saved-output proof, not proof of the model's requested content or visual quality.
 * SaveAs may rotate the native path-keyed session. The validated same-document
 * receipt owns that transition; the separate read must match its AFTER identity. */
export function savedDocumentPostconditionV2(applyInput:unknown, receiptValue:unknown, payload:unknown, verificationInput:unknown):boolean {
 const receipt=object(receiptValue), read=object(payload), saved=object(receipt.save_document), after=object(saved.after), before=object(saved.before);
 const input=object(applyInput), request=object(input.body??input), verification=object(verificationInput), readRequest=object(verification.body);
 if(nativeArtifactReceiptEffectV1(receiptValue,'POST','/revit/save-as','apply')!=='applied'
   ||saved.same_document!==true||saved.project_binding_changed!==false
   ||before.project_fingerprint!==after.project_fingerprint
   ||typeof request.filePath!=='string'||request.filePath.length>2000||typeof before.path!=='string'||typeof after.path!=='string'
   ||verification.method!=='POST'||verification.path!=='/revit/inspect-exported-files'
   ||!Array.isArray(readRequest.paths)||readRequest.paths.length!==1||normalized(readRequest.paths[0])!==normalized(after.path)
   ||!path.win32.isAbsolute(after.path)||!nativeArtifactPostconditionV2(receiptValue,payload))return false;
 const expected=normalized(path.win32.isAbsolute(request.filePath)?request.filePath:path.win32.resolve(path.win32.dirname(before.path),request.filePath));
 const actual=normalized(after.path), document=object(read.saved_document), files=read.files;
 if(!expected||expected!==actual||normalized(document.path)!==actual
   ||document.session_id!==after.session_id||document.project_fingerprint!==after.project_fingerprint
   ||document.is_modified!==false||document.is_modifiable!==false||typeof document.is_family_document!=='boolean'
   ||path.win32.extname(after.path).toLowerCase()!==(document.is_family_document?'.rfa':'.rvt')
   ||!Array.isArray(files)||files.length!==1||object(files[0]).stable_read!==true)return false;
 return true;
}
