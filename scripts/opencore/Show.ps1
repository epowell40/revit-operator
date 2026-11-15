[CmdletBinding()]
param([switch]$NoBrowser)
. "$PSScriptRoot/Common.ps1"
trap {
    $_.Exception.Message | Set-Content -LiteralPath (Join-Path $OpenCoreState 'interface-launch.error.log') -Encoding UTF8
    throw
}
$runtimePath=Join-Path $OpenCoreState 'runtime.json'
if(!(Test-Path -LiteralPath $runtimePath)){throw 'Start standalone Operator with Start-OpenCore.cmd first.'}
$runtime=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
if(!$runtime.PSObject.Properties['sidecar']){throw 'Run the current Start-OpenCore.cmd to start the Operator interface.'}
Assert-OpenCoreProcess $runtime.sidecar | Out-Null
$listener=@(Get-NetTCPConnection -State Listen -LocalPort 3907 -ErrorAction SilentlyContinue)
if($listener.Count -ne 1 -or $listener[0].LocalAddress -ne '127.0.0.1' -or $listener[0].OwningProcess -ne $runtime.sidecar.pid){throw 'The Operator interface is not owned by this installation.'}
$identity=(Invoke-RestMethod 'http://127.0.0.1:3907/api/runtime-identity' -TimeoutSec 3).sidecarRuntime
$moduleHash=(& $runtime.sidecar.node "$PSScriptRoot/Runtime-Identity.mjs").Trim()
if($LASTEXITCODE -ne 0 -or $identity.pid -ne $runtime.sidecar.pid -or $identity.serverSourceSha256 -ne (Get-FileHash -LiteralPath $runtime.sidecar.entry).Hash.ToLowerInvariant() -or $identity.moduleSourcesSha256 -ne $moduleHash){throw 'The Operator runtime changed. Close Revit, stop this installation, and start it again.'}
if(!$NoBrowser){Start-Process 'http://127.0.0.1:3907/'}
