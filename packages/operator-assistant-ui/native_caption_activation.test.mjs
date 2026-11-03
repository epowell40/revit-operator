import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('explicit owned titlebar click activates normally; model areas, foreign windows and races stay guarded',{skip:process.platform!=='win32'},()=>{
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./native_caption_activation.test.ps1',import.meta.url))];
 if(process.env.OPERATOR_CAPTION_BEFORE_SOURCE)args.push('-Source',process.env.OPERATOR_CAPTION_BEFORE_SOURCE);
 const r=spawnSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS exact188 caption/);
});
