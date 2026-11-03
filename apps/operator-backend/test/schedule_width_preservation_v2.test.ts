import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import * as verification from '../src/verification/regular_schedule_presentation_v2.js';
import {scheduleWidthPreservationMatchesV2,scheduleWidthPreservationSummaryV2,isScheduleWidthOnlyRequestV2} from '../src/verification/schedule_width_preservation_v2.js';
import {regularScheduleUnrequestedPreservedIdsV2} from '../src/verification/regular_schedule_presentation_scope_v2.js';

function fixture():any {
 const field=(width:number)=>({fieldId:11,isHidden:false,semanticHash:'b'.repeat(64),attributes:{fieldId:11,name:'Number',parameterId:-1,fieldType:'Instance',isCalculated:false,isCombined:false,heading:'Number',parts:[],gridWidthFeet:width,sheetWidthFeet:width,style:{preservedStyleHash:'c'.repeat(64)}}});
 const definition=(width:number)=>({schema:'operator.regular_schedule_field_definition.v1',complete:true,scheduleId:41,uniqueId:'view:41',categoryId:-2003600,coverage:'native_field_binding_captured_attributes_filters_sort_defaults_parameters_v1',configurationHash:'a'.repeat(64),fieldOrder:[11],fields:[field(width)]});
 const content={schema:'operator.schedule_width_preservation.v1',complete:true,coverage:'host_members_table_text_cell_styles_placement_anchors_v1',scheduleId:41,uniqueId:'view:41',memberCount:2,members:[{id:50,uniqueId:'space:50'},{id:51,uniqueId:'space:51'}],placements:[{id:60,uniqueId:'placement:60',sheetId:70,sheetUniqueId:'sheet:70',point:[1,2,0]}],table:{complete:true,totalCells:8,textHash:'d'.repeat(64),unrequestedStyleHash:'e'.repeat(64)}};
 const p={schema:'operator.regular_schedule_presentation.v1',complete:true,fieldOrder:[11]};
 return {input:{method:'POST',path:'/revit/configure-schedule',body:{scheduleId:41,columnWidths:[{field:'Number',widthFeet:.09375}],dryRun:false}},
 applied:{status:'Success',dryRun:false,schedule:{id:41,uniqueId:'view:41'},transaction:{committed:true,modified_element_ids:[41],added_element_ids:[],deleted_element_ids:[]},changeTracking:{exhaustiveChangeInventory:true},definitionBefore:definition(.2),definitionAfter:definition(.09375),presentationReadback:p,targetContentBefore:structuredClone(content),targetContentAfter:structuredClone(content)},
 read:{status:'Ok',action:'presentation',read_only:true,schedule:{id:41,uniqueId:'view:41',kind:'schedule'},definition:definition(.09375),presentation:structuredClone(p),targetContent:structuredClone(content)}};
}
test('native producer supplies before, committed-after and independent target content via existing getters',()=>{
 const here=path.dirname(fileURLToPath(import.meta.url));
 const root=[path.resolve(here,'../../revit-bridge-addin'),path.resolve(here,'../../../revit-bridge-addin')].find(p=>fs.existsSync(p));
 const apply=fs.readFileSync(path.join(root!,'RevitBridge/Handlers/ConfigureScheduleHandler.cs'),'utf8');
 const read=fs.readFileSync(path.join(root!,'RevitBridge/Handlers/RegularSchedulePresentationScope.cs'),'utf8');
 assert.match(apply,/targetContentBefore/);assert.match(apply,/targetContentAfter/);assert.match(read,/targetContent =/);
 const producer=fs.readFileSync(path.join(root!,'RevitBridge/Handlers/ScheduleWidthPreservation.cs'),'utf8');
 assert.match(producer,/ReadAllCellsForPreservation\(schedule\)/);assert.match(producer,/FilteredElementCollector\(doc, schedule.Id\)/);
 assert.match(producer,/IncludeLinkedFiles/);assert.match(producer,/IsFilteredBySheet/);assert.match(producer,/Take\(5001\)/);assert.match(producer,/Take\(129\)/);
 assert.match(producer,/sheet.UniqueId/);assert.match(producer,/p.Point/);
 assert(!/GetRowHeight|GetColumnWidth|GetBoundingBox|\.Set\(|\.Save\(/.test(producer),'semantic capture neither mutates nor freezes legitimate reflow');
});
test('width verification refuses changed target values even when width and all other schedule checks pass',()=>{
 const f=fixture();assert.equal(verification.regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),true);
 f.applied.targetContentAfter.table.textHash='f'.repeat(64);f.read.targetContent.table.textHash='f'.repeat(64);
 assert.equal(verification.regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);
});
test('complete target content checks allow member enumeration order and report precise excluded obligations',()=>{
 const f=fixture();f.read.targetContent.members.reverse();
 assert.equal(scheduleWidthPreservationMatchesV2(f.input,f.applied,f.read),true);
 const summary=scheduleWidthPreservationSummaryV2(f.input,f.applied,f.read)!;
 assert.equal(summary.member_count,2);assert.equal(summary.table_cell_count,8);assert.equal(summary.placement_count,1);
 assert(summary.excluded.includes('visual_readability_and_clearance'));assert(summary.excluded.includes('underlying_unscheduled_parameter_values'));
});
for(const [name,mutate] of Object.entries({
 missing_before:(f:any)=>{delete f.applied.targetContentBefore;},missing_after:(f:any)=>{delete f.applied.targetContentAfter;},missing_current:(f:any)=>{delete f.read.targetContent;},
 incomplete:(f:any)=>{f.read.targetContent.complete=false;},truncated:(f:any)=>{f.read.targetContent.truncated=true;},foreign_scope:(f:any)=>{f.read.targetContent.coverage='linked_best_effort';},
 foreign_id:(f:any)=>{f.read.targetContent.scheduleId=42;},foreign_uid:(f:any)=>{f.read.targetContent.uniqueId='foreign';},
 missing_member:(f:any)=>{f.applied.targetContentAfter.members.pop();f.applied.targetContentAfter.memberCount--;f.read.targetContent=structuredClone(f.applied.targetContentAfter);},
 changed_uid:(f:any)=>{f.read.targetContent.members[0].uniqueId='replacement';},duplicate:(f:any)=>{f.read.targetContent.members[1]=structuredClone(f.read.targetContent.members[0]);},
 count:(f:any)=>{f.read.targetContent.memberCount=3;},read_error:(f:any)=>{f.read.targetContent.error='unavailable';},
 styles:(f:any)=>{f.applied.targetContentAfter.table.unrequestedStyleHash='f'.repeat(64);f.read.targetContent=structuredClone(f.applied.targetContentAfter);},
 cells:(f:any)=>{f.read.targetContent.table.totalCells++;},bad_hash:(f:any)=>{f.read.targetContent.table.textHash='echo';},
 anchor:(f:any)=>{f.applied.targetContentAfter.placements[0].point[0]++;f.read.targetContent=structuredClone(f.applied.targetContentAfter);},
 sheet:(f:any)=>{f.read.targetContent.placements[0].sheetUniqueId='different';},nonfinite:(f:any)=>{f.read.targetContent.placements[0].point[0]=Infinity;},
 member_cap:(f:any)=>{f.read.targetContent.members=Array.from({length:5001},(_,i)=>({id:i+1,uniqueId:'u'+i}));f.read.targetContent.memberCount=5001;},
 cell_cap:(f:any)=>{f.read.targetContent.table.totalCells=10001;},placement_cap:(f:any)=>{f.read.targetContent.placements=Array(129).fill(f.read.targetContent.placements[0]);}
}))test('target content refuses '+name,()=>{const f=fixture();mutate(f);assert.equal(scheduleWidthPreservationMatchesV2(f.input,f.applied,f.read),false);assert.equal(verification.regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),false);});
test('historical receipts keep narrow scope and do not gain target content verification',()=>{
 const f=fixture();delete f.applied.targetContentBefore;delete f.applied.targetContentAfter;
 assert.equal(verification.regularSchedulePresentationReadbackMatchesV2(f.input,f.applied,f.read),true);
 assert.equal(scheduleWidthPreservationSummaryV2(f.input,f.applied,f.read),undefined);
});
test('heading/hidden/order/mixed requests cannot inherit width-only preservation',()=>{
 for(const extra of [{appearance:{}},{fieldOrder:[11]},{filters:[]},{dryRun:true}])assert.equal(isScheduleWidthOnlyRequestV2({body:{...fixture().input.body,...extra}}),false);
 const f=fixture();f.input.body={scheduleId:41,fieldFormats:[{field:'Number',widthFeet:.09375}]};assert.equal(isScheduleWidthOnlyRequestV2(f.input),true);
 f.input.body.fieldFormats[0].heading='New';assert.equal(isScheduleWidthOnlyRequestV2(f.input),false);
});
test('unrequested schedule census projection requires all three complete native fingerprints even for a target-only event',()=>{
 const scope=()=>({schema:'operator.regular_schedule_presentation_scope.v1',complete:true,coverage:'configuration_cell_text_style_geometry_v1',targetId:41,targetUniqueId:'view:41',totalUnrequestedCells:8,unrequestedSchedules:[{scheduleId:42,uniqueId:'view:42',semanticHash:'a'.repeat(64)}],dependencies:[]});
 const a:any={presentationScopeBefore:scope(),presentationScopeAfter:scope()},r:any={scope:scope()};
 assert.deepEqual(regularScheduleUnrequestedPreservedIdsV2(41,'view:41',a,r),[42]);
 r.scope.unrequestedSchedules[0].semanticHash='b'.repeat(64);assert.equal(regularScheduleUnrequestedPreservedIdsV2(41,'view:41',a,r),null);
 r.scope={complete:true};assert.equal(regularScheduleUnrequestedPreservedIdsV2(41,'view:41',a,r),null);
});
