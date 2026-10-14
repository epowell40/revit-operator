import {sheetMove79Fixture} from './sheet_move_79_fixture.js';
/** Synthetic placement-frame neighbor. Historical box-center receipts remain
 * immutable. A fresh Revit run must provide actual projection-frame evidence. */
export function viewportProjectionFixture(kind:'single'|'multi'){
 const f=sheetMove79Fixture(kind,true);
 for(const s of f.native_apply.snapshots){
  const before=s.before,after=s.after;
  before.kind=after.kind='ViewportProjectionOrigin';
  before.pointXyz=[before.pointXyz[0]+.10979044223993,before.pointXyz[1]-.131339995624456,0];
  after.pointXyz=before.pointXyz.map((n:number,i:number)=>n+[f.input.body.vectorX,f.input.body.vectorY,f.input.body.vectorZ][i]);
  for(const a of [before,after])Object.assign(a,{basisXXyz:[1,0,0],basisYXyz:[0,1,0],basisZXyz:[0,0,1]});
  const sheet=f.actual_sheets.find((p:any)=>p.sheetId===before.ownerViewId),v=sheet.viewportGeometry.find((v:any)=>v.viewportId===s.id);
  v.placementAnchor=structuredClone(after);
 }
 return f;
}
