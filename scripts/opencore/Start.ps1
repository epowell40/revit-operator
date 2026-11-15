[CmdletBinding()]
param([switch]$NoRevit)
. "$PSScriptRoot/Common.ps1"
$key = Read-OpenCoreKey
$receiptPath = Join-Path $OpenCoreState 'install.json'
if (!(Test-Path -LiteralPath $receiptPath)) { throw 'Run Setup-OpenCore.cmd first.' }
$install = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if (!(Test-Path -LiteralPath $install.manifest) -or (Get-FileHash -LiteralPath $install.manifest).Hash -ne $install.manifestSha256) { throw 'The selected add-in has changed. Run setup again or restore the previous installation.' }
Assert-ClosedRevit
if (Get-NetTCPConnection -State Listen -LocalPort 7007 -ErrorAction SilentlyContinue) { throw 'Port 7007 is already in use. Close the other local Operator backend first; no existing process was stopped.' }
$envNames=@('OPENAI_API_KEY','OPERATOR_OPENAI_API_KEY','OPERATOR_CODEX_AUTH_FILE','OPERATOR_BRAIN','OPERATOR_TOKEN','OPERATOR_WORKSPACE_ROOT','OPERATOR_API_BASE_URL','OPERATOR_BACKEND_URL','OPERATOR_HOSTED_ENABLED','REVIT_OPERATOR_MODE','OPERATOR_UI_MODE','OPERATOR_BACKEND_AUTOSTART','OPERATOR_CODEX_BIN','OPERATOR_AUTH_MODE','OPERATOR_BACKEND_PORT','OPERATOR_CLIENT_CONFIG_PATH','PATH')
$saved=@{}; foreach($name in $envNames){$saved[$name]=[Environment]::GetEnvironmentVariable($name)}
$backend=$null
try {
    $workspace=Join-Path $OpenCoreState 'Workspace'
    New-Item -ItemType Directory -Force $workspace | Out-Null
    $tokenPath=Join-Path $workspace 'operator_token.txt'
    if (!(Test-Path -LiteralPath $tokenPath)) { [IO.File]::WriteAllText($tokenPath,[Guid]::NewGuid().ToString('N')) }
    $env:OPENAI_API_KEY=$key; $env:OPERATOR_OPENAI_API_KEY=$key
    $authFile=Join-Path $OpenCoreState 'api-auth.json'
    Write-OpenCoreText $authFile (@{OPENAI_API_KEY=$key} | ConvertTo-Json)
    $env:OPERATOR_CODEX_AUTH_FILE=$authFile
    $env:OPERATOR_BRAIN='codex'
    $env:OPERATOR_TOKEN=(Get-Content -LiteralPath $tokenPath -Raw).Trim()
    $env:OPERATOR_WORKSPACE_ROOT=$workspace
    $env:OPERATOR_API_BASE_URL='http://127.0.0.1:7007'; $env:OPERATOR_BACKEND_URL=$env:OPERATOR_API_BASE_URL
    $env:OPERATOR_HOSTED_ENABLED='false'; $env:REVIT_OPERATOR_MODE='local'
    $env:OPERATOR_AUTH_MODE='shared_token'; $env:OPERATOR_BACKEND_PORT='7007'
    $clientConfig=Join-Path $OpenCoreState 'operator-client.json'
    @{backend_url='http://127.0.0.1:7007/';auth_mode='none';backend_autostart=$false} | ConvertTo-Json | Set-Content -LiteralPath $clientConfig -Encoding UTF8
    $env:OPERATOR_CLIENT_CONFIG_PATH=$clientConfig
    $env:OPERATOR_UI_MODE='pane'; $env:OPERATOR_BACKEND_AUTOSTART='false'
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
    $revit=$null
    if(!$NoRevit){$revit=Start-Process -FilePath $install.revitExe -PassThru}
    @{pid=$backend.Id;started=$backend.StartTime.ToUniversalTime().ToString('o');node=$install.node;entry=$entry;revitPid=if($revit){$revit.Id}else{$null}} | ConvertTo-Json | Set-Content (Join-Path $OpenCoreState 'runtime.json') -Encoding UTF8
    Write-Host 'Local Operator is ready. In Revit, open RevitOperator > Operator. API usage is billed to your key.'
} catch {
    if($backend -and !$backend.HasExited){Stop-Process -Id $backend.Id}
    throw
} finally {
    $key=$null
    foreach($name in $envNames){[Environment]::SetEnvironmentVariable($name,$saved[$name])}
}
