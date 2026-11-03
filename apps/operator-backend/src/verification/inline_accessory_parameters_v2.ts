import {payloadDigestV2} from '@revitoperator/payload-digest-v2';
type Row=Record<string,any>;
const equal=(a:unknown,b:unknown)=>payloadDigestV2(a).digest===payloadDigestV2(b).digest;
/** Preserve sorted writable data. A split may copy writable IFC_GUID; distinct
 * native UniqueId is checked separately. Only seven observed elevation/alias
 * fields tolerate <=1e-12 internal feet roundoff, never arbitrary Double data. */
export function inlineSplitParametersMatchV2(before:string,after:string,isNew:boolean):boolean {
  const parse=(text:string):Row[]=>{
    if(typeof text!=='string'||text.length>128000)throw new Error('parameter bound');
    const rows=JSON.parse(text);if(!Array.isArray(rows)||rows.length>2048)throw new Error('parameter array');
    let previous=-Infinity;
    for(const row of rows){
      if(!row||Array.isArray(row)||Object.keys(row).length!==3||!Object.hasOwn(row,'id')||!Object.hasOwn(row,'storage')||!Object.hasOwn(row,'value')
        ||!Number.isSafeInteger(row.id)||row.id===0||row.id<=previous||!['String','Double','Integer','ElementId','None'].includes(row.storage)
        ||(row.value!==null&&typeof row.value!=='string'))throw new Error('parameter shape');
      previous=row.id;
    }return rows;
  };
  const b=parse(before),a=parse(after);
  if(b.length!==a.length)return false;
  return b.every((p,i)=>{
    const n=a[i]!;if(p.id!==n.id)return false;
    if([-1141029,-1140240,-1141026,-1141020,-1140239,-1141021,-1114132].includes(p.id)){
      const finite=(v:unknown):v is string=>typeof v==='string'&&/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(v)&&Number.isFinite(Number(v));
      return p.storage==='Double'&&n.storage==='Double'&&finite(p.value)&&finite(n.value)&&Math.abs(Number(p.value)-Number(n.value))<=1e-12;
    }
    if(p.id!==-1019000||!isNew)return equal(p,n);
    return p.storage==='String'&&n.storage==='String'&&typeof p.value==='string'&&typeof n.value==='string'
      && /^[0-3][0-9A-Za-z_$]{21}$/.test(p.value)&&/^[0-3][0-9A-Za-z_$]{21}$/.test(n.value);
  });
}

