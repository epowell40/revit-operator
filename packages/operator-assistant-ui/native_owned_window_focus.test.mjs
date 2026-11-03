import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
test('owned native point gains foreground once, rechecks identity, and rejects foreign/racing/failed focus', {skip:process.platform!=='win32'},()=>{
 const args=['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./native_owned_window_focus.test.ps1',import.meta.url))];
 if(process.env.OPERATOR_FOCUS_BEFORE_HOST)args.push('-BeforeHost',process.env.OPERATOR_FOCUS_BEFORE_HOST);
 const r=spawnSync('powershell.exe',args,{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/PASS owned foreground/);
});
