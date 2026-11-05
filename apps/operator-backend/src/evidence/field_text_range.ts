/** A page of one retained string, after ordinary scope/hash checks. This is
 * supporting text navigation, never native or collection-completeness proof. */
export function selectFieldTextRange(value:unknown,range:{path:string;start:number;length:number},maxBytes:number){
 if(typeof value!=='string')throw Error('text_range.path must select an existing string, not missing/null/object/array');
 const bytes=Buffer.from(value,'utf8');if(bytes.toString('utf8')!==value)throw Error('text_range.path contains an invalid Unicode scalar');
 const {start,length}=range,total=bytes.length;
 if(start>total)throw Error('text_range.start exceeds selected string byte length');
 const boundary=(end:number)=>{while(end>start&&end<total&&(bytes[end]!&0xc0)===0x80)end--;return end;};
 if(start<total&&(bytes[start]!&0xc0)===0x80)throw Error('text_range.start must be a UTF-8 character boundary');
 const cap=Math.min(total,start+length);let lo=start,hi=cap,end=start;
 while(lo<=hi){const mid=Math.floor((lo+hi)/2),candidate=boundary(mid),text=bytes.subarray(start,candidate).toString('utf8');
  if(Buffer.byteLength(JSON.stringify(text),'utf8')<=maxBytes){end=Math.max(end,candidate);lo=mid+1;}else hi=mid-1;}
 if(start<total&&end===start)throw Error('text_range.length cannot hold the next UTF-8 character within the unchanged byte budget');
 const selection=bytes.subarray(start,end).toString('utf8'),more=end<total;
 return{selection,text_pagination:{path:range.path,start,requested_length:length,returned_utf8_bytes:end-start,total_utf8_bytes:total,
  next_start:more?end:null,has_more:more,field_complete:start===0&&!more,byte_limited:end<cap}};
}
