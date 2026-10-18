import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('real Windows host planner selects native work or owned modal and rejects stale, foreign, hidden and occluded frames',{skip:process.platform!=='win32'},()=>{
 const result=execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./visual_review_capture.test.ps1',import.meta.url))],{encoding:'utf8',timeout:30000});
 assert.match(result,/PASS 15 exact host capture planner scenarios/);
});
