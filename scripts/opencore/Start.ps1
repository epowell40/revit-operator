[CmdletBinding()]
param([switch]$NoRevit)
. "$PSScriptRoot/Common.ps1"
$key = Read-OpenCoreKey
$receiptPath = Join-Path $OpenCoreState 'install.json'
if (!(Test-Path -LiteralPath $receiptPath)) { throw 'Run Setup-OpenCore.cmd first.' }
$install = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if (!(Test-Path -LiteralPath $install.manifest) -or (Get-FileHash -LiteralPath $install.manifest).Hash -ne $install.manifestSha256) { throw 'The selected add-in has changed. Run setup again or restore the previous installation.' }
Assert-ClosedRevit
$dynamicReceipt=Get-Content -LiteralPath (Join-Path $OpenCoreState 'dynamic-runtime.json') -Raw | ConvertFrom-Json
$dynamicRoot=Join-Path (Split-Path $install.assembly) 'dynamic-runtime'
Assert-OpenCoreRuntime $dynamicReceipt $dynamicRoot
if (Get-NetTCPConnection -State Listen -LocalPort 7007,3907 -ErrorAction SilentlyContinue) { throw 'An Operator port (7007 or 3907) is already in use. Stop the other installation first; no existing process was stopped.' }
$envNames=@('OPENAI_API_KEY','OPERATOR_OPENAI_API_KEY','OPERATOR_CODEX_AUTH_FILE','OPERATOR_BRAIN','OPERATOR_TOKEN','OPERATOR_WORKSPACE_ROOT','OPERATOR_API_BASE_URL','OPERATOR_BACKEND_URL','OPERATOR_HOSTED_ENABLED','REVIT_OPERATOR_MODE','OPERATOR_UI_MODE','OPERATOR_BACKEND_AUTOSTART','OPERATOR_CODEX_BIN','OPERATOR_AUTH_MODE','OPERATOR_BACKEND_PORT','OPERATOR_CLIENT_CONFIG_PATH','OPERATOR_TOOL_EXPOSURE_PROFILE','OPERATOR_ASSIGNMENT_KERNEL_V2','OPERATOR_DESKTOP_ENABLE_INPUT','OPERATOR_DESKTOP_LAUNCHER_PATH','OPERATOR_DESKTOP_COMPUTER_PROVIDER','HOST','PORT','PATH','OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH','OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY','OPERATOR_DYNAMIC_RUNTIME_REVIT_YEAR','OPERATOR_TOKEN_FILE','OPERATOR_REVIT_URL','REVIT_OPERATOR_DYNAMIC_RUNTIME_LAUNCHER_SHA256','REVIT_OPERATOR_DYNAMIC_RUNTIME_WORKER_SHA256')
$saved=@{}; foreach($name in $envNames){$saved[$name]=[Environment]::GetEnvironmentVariable($name)}
$envNames+=@('OPERATOR_BEARER_TOKEN')
$saved['OPERATOR_BEARER_TOKEN']=$env:OPERATOR_BEARER_TOKEN
$env:OPERATOR_BEARER_TOKEN=$null
$backend=$null
$sidecar=$null
try {
    $workspace=Join-Path $OpenCoreState 'Workspace'
    New-Item -ItemType Directory -Force $workspace | Out-Null
    $tokenPath=Join-Path $workspace 'operator_token.txt'
    if (!(Test-Path -LiteralPath $tokenPath)) { [IO.File]::WriteAllText($tokenPath,[Guid]::NewGuid().ToString('N')) }
    $env:OPENAI_API_KEY=$key; $env:OPERATOR_OPENAI_API_KEY=$key
    $authFile=Join-Path $OpenCoreState 'api-auth.json'
    Write-OpenCoreText $authFile (@{OPENAI_API_KEY=$key} | ConvertTo-Json)
    $env:OPERATOR_CODEX_AUTH_FILE=$authFile
    $env:OPERATOR_DYNAMIC_RUNTIME_SUPERVISOR_PATH=Join-Path $dynamicRoot 'supervisor/DynamicRevitSandboxSupervisor.exe'
    $env:OPERATOR_DYNAMIC_RUNTIME_WORKER_DIRECTORY=Join-Path $dynamicRoot 'worker'
    $env:OPERATOR_DYNAMIC_RUNTIME_REVIT_YEAR=[string]$install.revitYear
    $env:OPERATOR_TOKEN_FILE=$tokenPath
    $env:OPERATOR_REVIT_URL='http://127.0.0.1:5000'
    $env:REVIT_OPERATOR_DYNAMIC_RUNTIME_LAUNCHER_SHA256=$null
    $env:REVIT_OPERATOR_DYNAMIC_RUNTIME_WORKER_SHA256=$null
    $env:OPERATOR_BRAIN='codex'
    $env:OPERATOR_TOKEN=(Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $env:OPERATOR_WORKSPACE_ROOT=$workspace
    $env:OPERATOR_API_BASE_URL='http://127.0.0.1:7007'; $env:OPERATOR_BACKEND_URL=$env:OPERATOR_API_BASE_URL
    $env:OPERATOR_HOSTED_ENABLED='false'; $env:REVIT_OPERATOR_MODE='local'
    $env:OPERATOR_AUTH_MODE='shared_token'; $env:OPERATOR_BACKEND_PORT='7007'
    $clientConfig=Join-Path $OpenCoreState 'operator-client.json'
    @{backend_url='http://127.0.0.1:7007/';auth_mode='shared_token';backend_autostart=$false} | ConvertTo-Json | Set-Content -LiteralPath $clientConfig -Encoding UTF8
    $env:OPERATOR_CLIENT_CONFIG_PATH=$clientConfig
    $env:OPERATOR_UI_MODE='embedded'; $env:OPERATOR_BACKEND_AUTOSTART='false'
    $env:OPERATOR_DESKTOP_LAUNCHER_PATH=Join-Path $PSScriptRoot 'Show.ps1'
    $env:OPERATOR_TOOL_EXPOSURE_PROFILE='general'; $env:OPERATOR_ASSIGNMENT_KERNEL_V2='1'
    $env:OPERATOR_DESKTOP_ENABLE_INPUT='1'; $env:OPERATOR_DESKTOP_COMPUTER_PROVIDER='backend'
    $env:HOST='127.0.0.1'; $env:PORT='3907'
    $env:OPERATOR_CODEX_BIN=$install.codex
    $env:PATH="$(Split-Path $install.node);$env:PATH"
    $backendDir=Join-Path $OpenCoreRoot 'apps/operator-backend'
    $entry=Join-Path $backendDir 'dist/src/index.js'
    $backend=Start-Process -FilePath $install.node -ArgumentList ('"'+$entry+'"') -WorkingDirectory $backendDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OpenCoreState 'backend.log') -RedirectStandardError (Join-Path $OpenCoreState 'backend.error.log')
    $ready=$false
    for($i=0;$i -lt 30;$i++) {
        if($backend.HasExited){throw 'The local backend exited. See .opencore/backend.error.log.'}
        try { $health=Invoke-WebRequest 'http://127.0.0.1:7007/health' -Headers @{'X-Operator-Token'=$env:OPERATOR_TOKEN} -UseBasicParsing -TimeoutSec 2; if($health.StatusCode -eq 200){$ready=$true;break} } catch {}
        Start-Sleep -Seconds 1
    }
    if(!$ready){throw 'The local backend did not become ready. See .opencore/backend.error.log.'}
    $uiDir=Join-Path $OpenCoreRoot 'apps/operator-desktop'
    $uiEntry=Join-Path $uiDir 'server.js'
    $sidecar=Start-Process -FilePath $install.node -ArgumentList ('"'+$uiEntry+'"') -WorkingDirectory $uiDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $OpenCoreState 'interface.log') -RedirectStandardError (Join-Path $OpenCoreState 'interface.error.log')
    $uiReady=$false
    for($i=0;$i -lt 30;$i++) {
        if($sidecar.HasExited){throw 'The Operator interface exited. See .opencore/interface.error.log.'}
        try {$identity=(Invoke-RestMethod 'http://127.0.0.1:3907/api/runtime-identity' -TimeoutSec 2).sidecarRuntime
          if($identity.pid -eq $sidecar.Id -and $identity.serverSourceSha256 -eq (Get-FileHash -LiteralPath $uiEntry).Hash.ToLowerInvariant()){$uiReady=$true;break}
        } catch {}
        Start-Sleep -Seconds 1
    }
    if(!$uiReady){throw 'The matching Operator interface did not become ready.'}
    $runtime=@{pid=$backend.Id;started=$backend.StartTime.ToUniversalTime().ToString('o');node=$install.node;entry=$entry;revitPid=$null;sidecar=@{pid=$sidecar.Id;started=$sidecar.StartTime.ToUniversalTime().ToString('o');node=$install.node;entry=$uiEntry}}
    Write-OpenCoreText (Join-Path $OpenCoreState 'runtime.json') ($runtime | ConvertTo-Json -Depth 4)
    & "$PSScriptRoot/Show.ps1" -NoBrowser
    $revit=$null
    if(!$NoRevit){$revit=Start-Process -FilePath $install.revitExe -PassThru}
    $runtime.revitPid=if($revit){$revit.Id}else{$null}
    Write-OpenCoreText (Join-Path $OpenCoreState 'runtime.json') ($runtime | ConvertTo-Json -Depth 4)
    Write-Host 'Local Operator is ready. In Revit, open RevitOperator > Operator. API usage is billed to your key.'
} catch {
    if($sidecar -and !$sidecar.HasExited){Stop-Process -Id $sidecar.Id}
    if($backend -and !$backend.HasExited){Stop-Process -Id $backend.Id}
    throw
} finally {
    $key=$null
    foreach($name in $envNames){[Environment]::SetEnvironmentVariable($name,$saved[$name])}
}
