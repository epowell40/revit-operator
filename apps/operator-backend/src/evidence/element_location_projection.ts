type Row = Record<string, any>;
const vector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n));

/** Presentation only, called after the connector graph's native trust checks.
 * Insertion points are distinct from ports. Preserve partial/legacy uncertainty. */
export function projectElementLocation(value: unknown): Row {
  if (value === undefined) return {status:'not_reported'};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {status:'unavailable'};
  const v=value as Row;
  if (v.status==='unavailable') return {status:'unavailable'};
  if (!['observed','partial'].includes(v.status) || !['point','line','curve'].includes(v.kind)
    || v.coordinateSpace!=='document_internal' || v.lengthUnits!=='feet') return {status:'unavailable'};
  const r:Row={status:v.status,kind:v.kind};
  for(const key of ['point','start','end']) if(v[key]!==undefined) {
    if(!vector(v[key])) return {status:'unavailable'};
    r[key]=v[key];
  }
  if(v.rotationRadians!==undefined) {
    if(typeof v.rotationRadians!=='number'||!Number.isFinite(v.rotationRadians))return {status:'unavailable'};
    r.rotationRadians=v.rotationRadians;
  }
  for(const key of ['pointStatus','startStatus','endStatus','rotationStatus'])if(v[key]==='unavailable')r[key]='unavailable';
  if(v.kind==='point') {
    if(v.status==='observed'&&(!r.point||r.rotationRadians===undefined))return {status:'unavailable'};
  } else {
    if(typeof v.isBound!=='boolean')return {status:'unavailable'};
    r.isBound=v.isBound;
    r.scope=v.kind==='line'?'location_centerline':'endpoints_only_not_full_curve';
    if(!v.isBound)r.endpointsStatus='unavailable_unbounded';
    if(v.status==='observed'&&(!v.isBound||!r.start||!r.end))return {status:'unavailable'};
  }
  return r;
}
