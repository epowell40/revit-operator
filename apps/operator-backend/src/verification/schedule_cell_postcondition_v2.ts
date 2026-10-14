// Exact schedule-field comparison; prior receipts are never regraded.
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const space=(v:string)=>v.trim().replace(/\s+/g,' ');
function displayMatches(wanted:string,raw:unknown,formatted:unknown):boolean {
 const actual=typeof formatted==='string'&&formatted.trim()?formatted:typeof raw==='string'?raw:'';
 if(!actual.trim())return false;
 if(space(wanted)===space(actual))return true;
 // Schedule-cell writes use visible units. Only a purely numeric request may
 // inherit the field's displayed units; never compare a unit-bearing request
 // with an equal internal-unit number or remove its explicit unit suffix.
 const numeric=/^[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/;
 if(!numeric.test(wanted.trim()))return false;
 const displayed=space(actual).match(/^([+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)(?:\s+[A-Za-z][A-Za-z0-9/²³^ .-]*)?$/);
 if(!displayed)return false;
 return Number(wanted.replaceAll(',',''))===Number(displayed[1].replaceAll(',',''));
}
/** Must be called only on a fresh authoritative native read admitted by the kernel. */
export function updatedScheduleCellReadbackMatches(input:unknown,payload:unknown,affected:readonly string[]):boolean {
 const wrapper=object(input),request=object(wrapper.body??input),row=object(payload);
 if(typeof request.targetField!=='string'||typeof request.rowField!=='string'||typeof request.rowKey!=='string'
  ||typeof request.value!=='string'||!request.value.trim())return false;
 const targets=affected.filter(x=>/^element_id:[1-9][0-9]*$/.test(x));
 if(targets.length!==1||affected.length!==1||String(row.id)!==targets[0].slice('element_id:'.length))return false;
 const parameters=object(row.parameters);
 const rowValue=Object.entries(parameters).filter(([name])=>name.trim().toLowerCase()===String(request.rowField).trim().toLowerCase());
 if(rowValue.length!==1||typeof rowValue[0][1]!=='string'||space(rowValue[0][1])!==space(request.rowKey))return false;
 const details=Array.isArray(row.parameterDetails)?row.parameterDetails.map(object):[];
 const fields=details.filter(p=>typeof p.name==='string'&&p.name.trim().toLowerCase()===String(request.targetField).trim().toLowerCase());
 if(fields.length!==1)return false;
 return displayMatches(request.value,fields[0].value,fields[0].valueString);
}
