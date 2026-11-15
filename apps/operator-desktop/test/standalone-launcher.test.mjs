import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
const common=fileURLToPath(new URL('../../../scripts/opencore/Common.ps1',import.meta.url));
test('ribbon child resolves Windows PowerShell built-ins under an inherited module path',{skip:process.platform!=='win32'},()=>{
 const exe=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
 const quote=s=>"'"+s.replaceAll("'","''")+"'";
 const script=`$env:PSModulePath='C:\\unused-inherited-modules'; . ${quote(common)}; $hash=Get-FileHash -LiteralPath ${quote(common)}; if($hash.Hash.Length -ne 64){throw 'Missing SHA256'}; if(!(Get-Command Get-FileHash).Module.Path.StartsWith($PSHOME,[StringComparison]::OrdinalIgnoreCase)){throw 'Wrong host module'}; Write-Output 'native-host-hash-pass'`;
 const r=spawnSync(exe,['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',timeout:20000,windowsHide:true});
 assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/native-host-hash-pass/);
});