import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
test('production pointer and Escape classifier stop without further input',{skip:process.platform!=='win32'},()=>{
 const p=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./computer_pointer.test.ps1',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(p.status,0,p.stderr);assert.match(p.stdout,/PASS Escape edges/);
});
