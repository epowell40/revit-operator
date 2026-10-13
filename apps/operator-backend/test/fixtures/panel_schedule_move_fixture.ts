import fs from 'node:fs';
/** Exact old receipt stays immutable and unqualified: it lacks sheet ownership.
 * This explicitly synthetic neighbor exercises the new native owner field;
 * live qualification must supply a fresh native receipt. */
export function panelMoveFixtureV2(withOwner=true){
 const f=JSON.parse(fs.readFileSync('test/fixtures/panel-schedule-move-readback-53.json','utf8'));
 if(withOwner)for(const s of f.native_apply.snapshots){s.before.ownerViewId=f.actual_sheet.sheetId;s.after.ownerViewId=f.actual_sheet.sheetId;}
 return f;
}
export const selectedPanelV2=(f:any)=>f.actual_sheet.placedSchedules.find((p:any)=>p.instanceId===f.input.body.ids[0]);
