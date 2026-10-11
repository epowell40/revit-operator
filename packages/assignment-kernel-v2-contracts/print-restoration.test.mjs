import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeArtifactReceiptEffectV1, nativePrintSettingsRestorationVerifiedV1} from './native-artifact.js';
const fields=['PrinterName','PrintToFile','CombinedFile','PrintToFileName','PrintRange','CopyNumber','PrintOrderReverse'];
const receipt=()=>({schema:'revit-operator.native-artifact-receipt.v1',method:'POST',path:'/revit/print',phase:'apply',status:'complete',print_settings_restored:true,
 expected_output_paths:['C:/output/a.pdf'],expected_export_calls:1,export_calls:[true],outputs:[{path:'C:/output/a.pdf',size_bytes:42,sha256:'a'.repeat(64),fresh_output:true}],
 print_settings_restoration_readback:fields.map((field,i)=>({field,before:i,after:i,read_succeeded:true,matches:true,error:null}))});
const effect=r=>nativeArtifactReceiptEffectV1(r,'POST','/revit/print','apply');
test('complete native readback supports restoration only alongside artifact proof',()=>{
 const r=receipt();assert.equal(nativePrintSettingsRestorationVerifiedV1(r),true);assert.equal(effect(r),'applied');
 r.outputs[0].fresh_output=false;assert.equal(effect(r),null);
});
for(const [name,mutate] of [
 ['contradictory values',r=>r.print_settings_restoration_readback[0].after='changed'],
 ['duplicate field',r=>r.print_settings_restoration_readback[1].field='PrinterName'],
 ['missing field',r=>r.print_settings_restoration_readback.pop()],
 ['unreadable value',r=>r.print_settings_restoration_readback[0].read_succeeded=false],
 ['read error',r=>r.print_settings_restoration_readback[0].error='getter failed'],
 ['failure flag',r=>r.print_settings_restored=false],
 ['null record',r=>r.print_settings_restoration_readback=null],
 ['object values',r=>Object.assign(r.print_settings_restoration_readback[0],{before:{},after:{}})]
])test(name+' cannot prove restoration or applied artifact effect',()=>{const r=receipt();mutate(r);assert.equal(nativePrintSettingsRestorationVerifiedV1(r),false);assert.equal(effect(r),null)});
test('legacy receipt is not upgraded into independently observed settings proof',()=>{
 const r=receipt();delete r.print_settings_restoration_readback;
 assert.equal(effect(r),'applied');assert.equal(nativePrintSettingsRestorationVerifiedV1(r),false);
});
