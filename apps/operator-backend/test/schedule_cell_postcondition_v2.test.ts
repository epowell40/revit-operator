import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {updatedScheduleCellReadbackMatches as compare} from '../src/verification/schedule_cell_postcondition_v2.js';
import { scheduleCellNativeReadbackV2 } from './fixtures/schedule_cell_readback_v2.js';
const native: any = scheduleCellNativeReadbackV2;
const request={targetField:'Current Rating',rowField:'Name',rowKey:'MAIN1',value:'1600 A'},ids=['element_id:1662159'];
const clone=()=>structuredClone(native);
test('exact retained MAIN1 native target/row/field/formatted value is demonstrable',()=>assert(compare(request,native,ids)));
test('wrong target, wrong row and matching number on another field never pass',()=>{
 assert(!compare(request,{...clone(),id:1662160},ids));assert(!compare({...request,rowKey:'MAIN2'},native,ids));
 const p=clone();p.parameterDetails[1].name='Unrelated';assert(!compare(request,p,ids));
});
test('explicit unit request cannot pass equal raw value with different display units',()=>{
 const p=clone();p.parameterDetails[1].valueString='1600 CFM';assert(!compare(request,p,ids));
 assert(!compare({...request,value:'1600'}, {...p,parameterDetails:[p.parameterDetails[0],{...p.parameterDetails[1],valueString:'3200 CFM'}]},ids));
});
test('numeric schedule transcription uses displayed value and may inherit existing field units',()=>{
 assert(compare({...request,value:'1,600'},native,ids));
 const p=clone();p.parameterDetails[1].value='1600';p.parameterDetails[1].valueString='3200 A';assert(!compare({...request,value:'1600'},p,ids));
});
test('ambiguous native fields, absent affected identity and wrapper echoes are not proof',()=>{
 const p=clone();p.parameterDetails.push(p.parameterDetails[1]);assert(!compare(request,p,ids));
 assert(!compare(request,native,[]));assert(!compare(request,native,[...ids,'element_id:1662160']));
 assert(!compare(request,{request:native},ids));assert(!compare(request,{diagnostics:native},ids));
});
test('literal row matching and unparseable values remain conservative',()=>{
 assert(!compare({...request,rowKey:'MAIN'},native,ids));assert(!compare({...request,value:'1600??'},native,ids));
 const p=clone();delete p.parameterDetails;assert(!compare(request,p,ids));
});
