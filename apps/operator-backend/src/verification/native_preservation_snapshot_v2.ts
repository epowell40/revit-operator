import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {parseNativeAttemptSettlement,NATIVE_ATTEMPT_SETTLEMENT_SCHEMA} from '../assignments/native_attempt_settlement.js';
const maximum=2_000_000;
const placementMaximum=64_000_000,maximumSegments=32,maximumEnvelope=3_000_000;
const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const keys=(v:any,names:string[])=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).sort().join(',')===[...names].sort().join(',');
const sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function segmented(value:any):any{
 if(!keys(value,['schema','encoding','uncompressedBytes','sha256','segments'])||value.encoding!=='segmented-gzip-base64'
  ||!Number.isSafeInteger(value.uncompressedBytes)||value.uncompressedBytes<=maximum||value.uncompressedBytes>placementMaximum
  ||!sha(value.sha256)||!Array.isArray(value.segments)||value.segments.length!==Math.ceil(value.uncompressedBytes/maximum)
  ||value.segments.length>maximumSegments||Buffer.byteLength(JSON.stringify(value))>maximumEnvelope)throw Error('native_snapshot_segments_invalid');
 const parts:Buffer[]=[];let total=0;
 for(let i=0;i<value.segments.length;i++){
  const p=value.segments[i],expected=Math.min(maximum,value.uncompressedBytes-i*maximum);
  if(!keys(p,['index','uncompressedBytes','sha256','data'])||p.index!==i||p.uncompressedBytes!==expected||!sha(p.sha256)
   ||typeof p.data!=='string'||!p.data.length||p.data.length>maximumEnvelope||p.data.length%4!==0
   ||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(p.data))throw Error('native_snapshot_segment_invalid');
  const packed=Buffer.from(p.data,'base64');if(packed.toString('base64')!==p.data)throw Error('native_snapshot_base64_invalid');
  const bytes=gunzipSync(packed,{maxOutputLength:maximum});
  if(bytes.length!==expected||hash(bytes)!==p.sha256)throw Error('native_snapshot_segment_digest_invalid');
  total+=bytes.length;if(total>placementMaximum)throw Error('native_snapshot_segments_oversized');parts.push(bytes);
 }
 const bytes=Buffer.concat(parts,total);if(total!==value.uncompressedBytes||hash(bytes)!==value.sha256)throw Error('native_snapshot_digest_invalid');
 return decode(bytes);
}
function decode(bytes:Buffer):any{
 const decoded=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
 if(!decoded||typeof decoded!=='object'||Array.isArray(decoded)||Object.hasOwn(decoded,'encoding')||Object.hasOwn(decoded,'data')
  ||Object.hasOwn(decoded,'uncompressedBytes')||['operator.native_preservation_json.v1','operator.native_preservation_json.v2'].includes(decoded.schema))throw Error('native_snapshot_nested_invalid');
 return decoded;
}
/** Representation only. Call after retained native provenance/digest validation;
 * decoded fields acquire no authority and still require the full comparator. */
function snapshot(value:any):any {
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('native_snapshot_missing');
 if(value.schema==='operator.native_preservation_json.v2')return segmented(value);
 if(value.schema!=='operator.native_preservation_json.v1') {
  if(Object.hasOwn(value,'encoding')||Object.hasOwn(value,'data')||Object.hasOwn(value,'uncompressedBytes')||Buffer.byteLength(JSON.stringify(value))>maximum)throw Error('native_snapshot_invalid');
  return value;
 }
 if(Object.keys(value).sort().join(',')!=='data,encoding,schema,sha256,uncompressedBytes'
  ||value.encoding!=='gzip-base64'||!Number.isSafeInteger(value.uncompressedBytes)||value.uncompressedBytes<2||value.uncompressedBytes>maximum
  ||typeof value.sha256!=='string'||!(/^[a-f0-9]{64}$/).test(value.sha256)
  ||typeof value.data!=='string'||value.data.length===0||value.data.length>900000||value.data.length%4!==0
  ||!(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/).test(value.data))throw Error('native_snapshot_encoding_invalid');
 const packed=Buffer.from(value.data,'base64');if(packed.toString('base64')!==value.data)throw Error('native_snapshot_base64_invalid');
 const bytes=gunzipSync(packed,{maxOutputLength:maximum});
 if(bytes.length!==value.uncompressedBytes||createHash('sha256').update(bytes).digest('hex')!==value.sha256)throw Error('native_snapshot_digest_invalid');
 return decode(bytes);
}
export function expandNativeAccessoryPreservationV2(payload:any):any {
 if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('native_preservation_payload_invalid');
 return {...payload,preservationBefore:snapshot(payload.preservationBefore),preservationAfter:snapshot(payload.preservationAfter)};
}
/** Only after checking the RAW read receipt, binding, scope and digest. */
export function expandNativeAccessoryReadbackV2(payload:unknown):any{
 const p=payload as any;
 if(p?.schema!=='operator.native_preservation_json.v2'||!Object.hasOwn(p,'canonical_attempt_settlement'))return snapshot(payload);
 // RevitHttpServer decorates the completed response after the handler packs it.
 // This is transport metadata, not a substitute for the caller's RAW native
 // receipt/digest/binding checks. Keep it in the decoded record for provenance.
 const {canonical_attempt_settlement:metadata,...packed}=p;
 if(!metadata||metadata.schema!==NATIVE_ATTEMPT_SETTLEMENT_SCHEMA||Buffer.byteLength(JSON.stringify(metadata))>16_384)
  throw Error('native_snapshot_read_metadata_invalid');
 const settlement=parseNativeAttemptSettlement(metadata);
 if(!settlement||settlement.requested_effect!=='read'||settlement.effect_state!=='none'||settlement.effect_authority!=='native_host'
  ||!settlement.request_dispatched||settlement.method!=='POST'||settlement.path!=='/revit/get-connectors')throw Error('native_snapshot_read_metadata_invalid');
 return {...snapshot(packed),canonical_attempt_settlement:metadata};
}
