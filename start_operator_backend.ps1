param(
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$repoRoot = $PSScriptRoot
$backendDir = Join-Path $repoRoot "operator-backend"

if (!(Test-Path $backendDir)) {
  throw "operator-backend folder not found at $backendDir"
}

Push-Location $backendDir
try {
  if (-not $env:OPERATOR_TOKEN) {
    try {
      $tokenFile = Join-Path $env:LOCALAPPDATA "RevitOperator\\Workspace\\operator_token.txt"
      if (Test-Path $tokenFile) {
        $t = (Get-Content -Raw $tokenFile).Trim()
        if ($t) { $env:OPERATOR_TOKEN = $t }
      }
    } catch {}
  }

  if (-not $env:OPERATOR_TOKEN) {
    $env:OPERATOR_TOKEN = [guid]::NewGuid().ToString("N")
    try {
      $tokenFile = Join-Path $env:LOCALAPPDATA "RevitOperator\\Workspace\\operator_token.txt"
      $tokenDir = Split-Path -Parent $tokenFile
      if (!(Test-Path $tokenDir)) { New-Item -ItemType Directory -Force -Path $tokenDir | Out-Null }
      Set-Content -Path $tokenFile -Value $env:OPERATOR_TOKEN -Encoding ASCII
    } catch {}
    Write-Host ("Generated OPERATOR_TOKEN for this session: " + $env:OPERATOR_TOKEN)
  }

  # Leave OPERATOR_BRAIN unset when the caller did not provide it so the
  # backend env loader can honor operator-backend/.env.local. With no file
  # override, the backend's normal empty/auto selection behavior is unchanged.

  if (-not $env:OPERATOR_DEV_MODE) {
    $env:OPERATOR_DEV_MODE = "1"
  }

  $port = 7007
  if ($env:OPERATOR_BACKEND_PORT) {
    $parsed = 0
    if ([int]::TryParse($env:OPERATOR_BACKEND_PORT, [ref]$parsed) -and $parsed -gt 0) {
      $port = $parsed
    }
  }

  if (!(Test-Path "dist\\src\\index.js")) {
    npm install
    npm run build
  }

  $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -ne $c) {
    if ($Restart) {
      Write-Host "Operator backend already listening on :$port (pid $($c.OwningProcess)); restarting..."
      try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue } catch {}
      Start-Sleep -Milliseconds 250
    } else {
      Write-Host "Operator backend already listening on :$port (pid $($c.OwningProcess))"
      return
    }
  }

  Start-Process -FilePath node -ArgumentList "dist/src/index.js" -WorkingDirectory $backendDir -WindowStyle Hidden
  Start-Sleep -Milliseconds 250
  try {
    $headers = @{ "X-Operator-Token" = $env:OPERATOR_TOKEN }
    $health = Invoke-RestMethod -Method Get -Headers $headers ("http://localhost:{0}/health" -f $port)
    Write-Host ("Operator backend started. health=" + ($health | ConvertTo-Json -Compress))
  } catch {
    Write-Host "Operator backend started (health check failed; it may still be warming up)."
  }
} finally {
  Pop-Location
}
