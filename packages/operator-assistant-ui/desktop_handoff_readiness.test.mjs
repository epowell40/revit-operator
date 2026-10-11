import test from 'node:test';
import assert from 'node:assert/strict';
import {submitWorkReportForReview} from './work_report.mjs';
const binding={kernel_version:2,session_id:'session',goal_id:'assignment',run_id:'run',generation:3};
const proposal={claimed_completed:['Submitted external work.'],remaining_work:['Wait for settlement.'],uncertainties:[]};
test('host handoff precondition failure prevents retaining advisory completion',async()=>{let proposals=0,checks=0;await assert.rejects(submitWorkReportForReview(binding,proposal,async(_route,options)=>{const body=JSON.parse(options.body);if(body.action==='status')return{verification_policy:'advisory'};proposals++;return{ok:true};},{beforePropose:async()=>{checks++;throw Error('desktop_handoff_native_readiness_unproven')}}),/desktop_handoff_native_readiness_unproven/);assert.equal(checks,1);assert.equal(proposals,0)});
