$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
. "$PSScriptRoot/../scripts/native_readiness_obligation.ps1"
$root=Join-Path ([IO.Path]::GetTempPath()) ('operator-readiness-'+[Guid]::NewGuid().ToString('N'))
$old=$env:OPERATOR_NATIVE_READINESS_FILE
$Action='click';$ExpectedRevitProcessId=0
function Check($v,$m){if(!$v){throw $m}}
try {
 $env:OPERATOR_NATIVE_READINESS_FILE=Join-Path $root 'task.json'
 Save-OperatorNativeReadinessObligation @{available=$true;processName='OUTLOOK'}
 Check (!(Test-Path $root)) 'Desktop-only input created a Revit obligation'
 Save-OperatorNativeReadinessObligation @{available=$true;processName='Revit'}
 Check (Test-Path $env:OPERATOR_NATIVE_READINESS_FILE) 'Revit input lost readiness obligation'
 [IO.File]::WriteAllText($env:OPERATOR_NATIVE_READINESS_FILE,'')
 Save-OperatorNativeReadinessObligation @{available=$true;processName='Revit'}
 Check ((Get-Item $env:OPERATOR_NATIVE_READINESS_FILE).Length -eq 0) 'Corrupt obligation erased'
 $env:OPERATOR_NATIVE_READINESS_FILE=Join-Path $root 'unknown.json'
 Save-OperatorNativeReadinessObligation @{available=$false;processName=''}
 Check (Test-Path $env:OPERATOR_NATIVE_READINESS_FILE) 'Unknown window failed open'
 $env:OPERATOR_NATIVE_READINESS_FILE=Join-Path (Join-Path $root 'task.json') 'impossible.json'
 $caught=$false;try {Save-OperatorNativeReadinessObligation @{available=$true;processName='Revit'}} catch {$caught=$true}
 Check $caught 'Persistence error allowed input'
 Write-Output 'PASS target-aware readiness persistence; no desktop input'
} finally {
 $env:OPERATOR_NATIVE_READINESS_FILE=$old
 $resolvedRoot=[IO.Path]::GetFullPath($root)
 $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
 if(!$resolvedRoot.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolvedRoot) -notmatch '^operator-readiness-[a-f0-9]{32}$'){throw 'Unsafe test cleanup path'}
 if(Test-Path -LiteralPath $resolvedRoot){Remove-Item -LiteralPath $resolvedRoot -Recurse -Force}
}
