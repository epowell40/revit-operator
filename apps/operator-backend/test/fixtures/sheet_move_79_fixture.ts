import fs from 'node:fs';
export function sheetMove79Fixture(kind:'single'|'multi',withNativeZ=false){
 const f=JSON.parse(fs.readFileSync(`test/fixtures/sheet-move-readback-79-${kind}.json`,'utf8'));
 // Synthetic neighbor for the new native serialization contract. The retained
 // actual read remains immutable/UV-only and must continue to fail for nonzero Z.
 if(withNativeZ)for(const sheet of f.actual_sheets)for(const anchor of sheet.viewportGeometry){
  const native=f.native_apply.snapshots.find((s:any)=>s.id===anchor.viewportId);
  anchor.center.z=native?native.after.pointXyz[2]:0;
 }
 return f;
}
