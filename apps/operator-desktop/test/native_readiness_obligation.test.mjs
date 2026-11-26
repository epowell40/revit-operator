import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('actual input-host readiness records Revit and unknown targets but excludes Outlook',{skip:process.platform!=='win32'},()=>{
 const r=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./native_readiness_obligation.test.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS target-aware/);
});
