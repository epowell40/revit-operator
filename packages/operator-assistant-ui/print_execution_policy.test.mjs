import assert from "node:assert/strict";
import test from "node:test";
import { needsPrinterCapableLane, PRINT_EXECUTION_GUIDANCE, PDF_EXPORT_TOOL_GUIDANCE } from "./print_execution_policy.mjs";

test("printer and plot requests retain desktop capability, including PDF drivers", () => {
  for (const text of ["Print M000 using the available printer.", "Print M000 using Microsoft Print to PDF.", "Plot the selected sheets.", "Verify the existing print file; do not print again."]) {
    assert.equal(needsPrinterCapableLane(text), true, text);
  }
  for (const text of ["Export M000 to PDF.", "Inspect the model fingerprint.", "Update the blueprint title.", "", null]) {
    assert.equal(needsPrinterCapableLane(text), false, String(text));
  }
});

test("printer guidance preserves effect uncertainty and requested delivery semantics", () => {
  assert.match(PRINT_EXECUTION_GUIDANCE, /Do not substitute PDF export/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /trusted receipt proves not_started/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /never retry an uncertain or pending attempt/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /Honor requests not to print/);
  assert.match(PDF_EXPORT_TOOL_GUIDANCE, /not a printer-driver/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /word print alone does not require a driver/);
  assert.match(PRINT_EXECUTION_GUIDANCE, /Preserve explicit named-printer and physical-print requests/);
});
import { waitForLocalArtifact } from './print_execution_policy.mjs';

const ready = (size, stamp = 'a') => ({ok:true,exists:true,is_file:true,path:'M000.pdf',size_bytes:size,last_write_time_utc:stamp});
function clock() { let t=0; return { now:()=>t, sleep:async ms=>{t+=ms;} }; }
test('pending zero-byte print becomes stable without another print', async()=>{
 const c=clock(); let reads=0;
 const result=await waitForLocalArtifact(()=>{reads++;return c.now()<2000?ready(0):ready(3677924);},c);
 assert.equal(result.readiness,'stable_nonempty'); assert.equal(result.waited_ms,4000);
 assert.equal(result.content_verified,false); assert.ok(reads>1);
});
test('changed timestamp restarts stability even with equal size',async()=>{
 const c=clock(); const result=await waitForLocalArtifact(()=>ready(100,c.now()<1500?'a':'b'),c);
 assert.equal(result.waited_ms,3500);
});
test('missing and zero files time out without claiming content success',async()=>{
 for(const missing of [false,true]) { const c=clock(); const r=await waitForLocalArtifact(()=>({...ready(0),exists:!missing}),{...c,timeoutMs:3000}); assert.equal(r.readiness,'timeout');assert.equal(r.content_verified,false);assert.equal(r.waited_ms,3000); }
});
test('cancellation and directories never count as ready',async()=>{
 const c=clock(); const r=await waitForLocalArtifact(()=>ready(100),{...c,cancelled:()=>c.now()>=500});assert.equal(r.readiness,'cancelled');assert.equal(r.waited_ms,500);
 const d=await waitForLocalArtifact(()=>({...ready(100),is_file:false}),clock());assert.equal(d.readiness,'unavailable');
});
