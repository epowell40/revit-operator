import test from 'node:test';import assert from 'node:assert/strict';
import {boundedScheduleRowHeightsV2}from '../src/verification/schedule_row_heights_v2.js';
import {regularSchedulePresentationRequestV2,regularSchedulePresentationReadbackMatchesV2}from '../src/verification/regular_schedule_presentation_v2.js';
import {rowFixture}from './fixtures/schedule-row-height-synthetic.js';
import {nativePropertyComparisonV2}from '../src/verification/native_property_comparison_v2.js';
test('explicit header height requires native commit, complete preservation and a separate exact getter',()=>{
 const f=rowFixture();assert(regularSchedulePresentationRequestV2(f.input));assert(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read));
});
for(const [name,mutate]of Object.entries({
 stale:(f:any):any=>f.read.rowHeights.sections[0].rows[0].heightFeet=.036,
 collateral:(f:any):any=>{f.applied.rowHeightsAfter.sections[1].rows[1].heightFeet=.1;f.read.rowHeights.sections[1].rows[1].heightFeet=.1;},
 missing_before:(f:any):any=>delete f.applied.rowHeightsBefore,
 incomplete:(f:any):any=>f.read.rowHeights.complete=false,
 wrong_identity:(f:any):any=>f.read.rowHeights.uniqueId='other',
 missing_row:(f:any):any=>f.read.rowHeights.sections[0].rows.pop(),
 duplicate_row:(f:any):any=>f.read.rowHeights.sections[0].rows[1].rowNumber=0,
 missing_section:(f:any):any=>f.read.rowHeights.sections.pop(),
 false_validity:(f:any):any=>f.read.rowHeights.sections[0].validSection=false,
 wrong_receipt:(f:any):any=>f.applied.applied.rowHeights[0].afterHeightFeet=.036,
 failed:(f:any):any=>f.applied.applied.rowHeights[0].status='Failed',
 nonfinite:(f:any):any=>f.applied.applied.rowHeights[0].beforeHeightFeet=NaN,
 receipt_removed:(f:any):any=>f.applied.applied.rowHeights=[],
 changed_field:(f:any):any=>{f.applied.definitionAfter.fields[0].attributes.heading='OTHER';f.read.definition.fields[0].attributes.heading='OTHER';},
 changed_default:(f:any):any=>{f.applied.presentationReadback.showHeaders=false;f.read.presentation.showHeaders=false;},
 foreign_inventory:(f:any):any=>f.applied.transaction.modified_element_ids.push(77),
 rollback:(f:any):any=>f.applied.transaction.rolledBack=true,
 pending:(f:any):any=>f.applied.transaction.pending=true,
 mixed:(f:any):any=>f.input.body.filters=[],
}))test('row-height proof refuses '+name,()=>{const f=rowFixture();mutate(f);assert.equal(regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);});
for(const row of [{section:'Body',rowNumber:0,heightFeet:.1},{section:'Header',heightFeet:.1},{section:'Header',rowNumber:-1,heightFeet:.1},{section:'Header',rowNumber:0,heightFeet:0},{section:'Header',rowNumber:0,heightFeet:Infinity},{section:'other',rowNumber:0,heightFeet:.1},{section:'Header',rowNumber:0,heightFeet:.1,unknown:true}])
 test('malformed/unsupported row intent '+JSON.stringify(row),()=>assert.equal(boundedScheduleRowHeightsV2([row]),null));
test('distinct bounded sections supported; duplicate requested rows rejected',()=>{
 assert(boundedScheduleRowHeightsV2([{section:' footer ',rowNumber:2,heightFeet:.1},{section:'Summary',rowNumber:0,heightFeet:.2}]));
 const r={section:'Header',rowNumber:0,heightFeet:.1};assert.equal(boundedScheduleRowHeightsV2([r,r]),null);
});
test('worker gets expected/observed height mismatch rather than an unavailable generic proof label',()=>{
 const f=rowFixture(),readInput={method:'POST',path:'/revit/schedules',body:{action:'presentation',scheduleId:41}};
 assert.equal(nativePropertyComparisonV2(f.input,readInput,f.read).state,'matched');
 f.read.rowHeights.sections[0]!.rows[0]!.heightFeet=.036;
 assert.deepEqual(nativePropertyComparisonV2(f.input,readInput,f.read),{state:'mismatch',differences:[{subject:'schedule_row_height:41:header:0',expected:['heightFeet:0.048'],observed:['heightFeet:0.036']}],omitted:0});
 f.read.rowHeights.complete=false;assert.equal(nativePropertyComparisonV2(f.input,readInput,f.read).state,'incomplete');
 f.read.schedule.id=42;assert.equal(nativePropertyComparisonV2(f.input,readInput,f.read).state,'unavailable');
});
