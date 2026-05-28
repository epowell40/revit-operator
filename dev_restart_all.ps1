param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Debug",

  [int]$RevitYear = 2024,

  [switch]$SkipRevitDeploy,
  [switch]$SkipBackend,
  [switch]$SkipMcp
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$workspaceRoot = Join-Path $env:LOCALAPPDATA "RevitOperator\\Workspace"
$logsDir = Join-Path $workspaceRoot "logs"
if (!(Test-Path $logsDir)) { New-Item -ItemType Directory -Force -Path $logsDir | Out-Null }

function Log([string]$message) {
  Write-Output $message
}

function Ensure-OperatorToken {
  if (-not $env:OPERATOR_TOKEN) {
    try {
      $tokenFile = Join-Path $workspaceRoot "operator_token.txt"
      if (Test-Path $tokenFile) {
        $t = (Get-Content -Raw $tokenFile).Trim()
        if ($t) { $env:OPERATOR_TOKEN = $t }
      }
    } catch {}
  }

  if (-not $env:OPERATOR_TOKEN) {
    $env:OPERATOR_TOKEN = [guid]::NewGuid().ToString("N")
    try {
      $tokenFile = Join-Path $workspaceRoot "operator_token.txt"
      Set-Content -Path $tokenFile -Value $env:OPERATOR_TOKEN -Encoding ASCII
    } catch {}
    Log ("Generated OPERATOR_TOKEN: " + $env:OPERATOR_TOKEN)
  }
}

function Stop-McpServer {
  try {
    $procs = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'"
    $targets = $procs | Where-Object {
      ($_.CommandLine -as [string]) -and ($_.CommandLine.ToLowerInvariant().Contains("mcp-server\\dist\\server.js") -or $_.CommandLine.ToLowerInvariant().Contains("mcp-server/dist/server.js"))
    }
    foreach ($p in $targets) {
      try {
        Log ("Stopping MCP server pid " + $p.ProcessId + " ...")
        Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
      } catch {}
    }
  } catch {}
}

function Start-McpServer {
  $outLog = Join-Path $logsDir "mcp-server.out.log"
  $errLog = Join-Path $logsDir "mcp-server.err.log"

  $cwd = $repoRoot
  $args = @("mcp-server/dist/server.js")

  Log "Starting MCP server (background)..."
  $p = Start-Process -FilePath "node" -ArgumentList $args -WorkingDirectory $cwd -PassThru -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog
  try {
    $pidFile = Join-Path $workspaceRoot "mcp-server.pid"
    Set-Content -Path $pidFile -Value $p.Id -Encoding ASCII
  } catch {}
  Log ("MCP server pid=" + $p.Id)
}

function Ensure-NpmBuild($dir, $label) {
  if (!(Test-Path $dir)) { throw "$label folder not found: $dir" }
  Push-Location $dir
  try {
    if (!(Test-Path "node_modules")) {
      Log ("{0}: npm install" -f $label)
      npm install | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "${label}: npm install failed with exit code $LASTEXITCODE" }
    }
    Log ("{0}: npm run build" -f $label)
    npm run build | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "${label}: npm run build failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
  }
}

Ensure-OperatorToken

if (-not $SkipBackend) {
  Ensure-NpmBuild (Join-Path $repoRoot "operator-backend") "operator-backend"
}
if (-not $SkipMcp) {
  Ensure-NpmBuild (Join-Path $repoRoot "mcp-server") "mcp-server"
}

if (-not $SkipRevitDeploy) {
  $buildBundleScript = Join-Path $repoRoot "scripts\deploy\build_revit_dropin_bundle.ps1"
  $installBundleScript = Join-Path $repoRoot "scripts\deploy\install_revit_dropin_bundle.ps1"
  if ((Test-Path $buildBundleScript) -and (Test-Path $installBundleScript)) {
    $bundleRoot = Join-Path $repoRoot ("local-work\revit-dropin-bundle-{0}" -f $RevitYear)
    & $buildBundleScript -Configuration $Configuration -RevitYear $RevitYear -OutputDir ("local-work/revit-dropin-bundle-{0}" -f $RevitYear) | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "Revit add-in bundle build failed with exit code $LASTEXITCODE" }

    $revit = Get-Process -Name Revit -ErrorAction SilentlyContinue
    if ($revit) {
      Write-Warning "Revit is running; built add-in bundle but skipped deploy (DLLs are locked). Close Revit and rerun dev_restart_all.ps1 to deploy."
    } else {
      & $installBundleScript -BundleRoot $bundleRoot -RevitYear $RevitYear | Out-Host
      if ($LASTEXITCODE -ne 0) { throw "Revit add-in bundle install failed with exit code $LASTEXITCODE" }
    }
  } else {
    Write-Warning "Revit bundle scripts not found; skipping add-in deploy."
  }
}

if (-not $SkipBackend) {
  $backendScript = Join-Path $repoRoot "start_operator_backend.ps1"
  if (Test-Path $backendScript) {
    Log "Restarting operator backend..."
    & $backendScript -Restart | Out-Host
  } else {
    Write-Warning "Backend script not found: $backendScript"
  }
}

if (-not $SkipMcp) {
  Stop-McpServer
  Start-McpServer
}

try {
  $headers = @{ "X-Operator-Token" = $env:OPERATOR_TOKEN }
  $health = Invoke-RestMethod -Method Get -Headers $headers "http://127.0.0.1:7007/health"
  Log ("Backend health: " + ($health | ConvertTo-Json -Compress))
} catch {
  Write-Warning "Backend health check failed; open Revit and/or run ./start_operator_backend.ps1 -Restart"
}

Log "Done. You can open Revit and test."
