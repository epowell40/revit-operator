[CmdletBinding()]
param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Release",
  [string]$OutputDir = "",
  [string]$SigningThumbprint = "",
  [string]$SignToolPath = "",
  [string]$TimestampUrl = "http://ts.ssl.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$project = Join-Path $repoRoot "packages/operator-deploy/OperatorDeploy/OperatorDeploy.csproj"
$tests = Join-Path $repoRoot "packages/operator-deploy/OperatorDeploy.Tests/OperatorDeploy.Tests.csproj"
if (-not $OutputDir) { $OutputDir = Join-Path $repoRoot "local-work/operator-deploy" }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

dotnet test $tests -c $Configuration
if ($LASTEXITCODE -ne 0) { throw "OperatorDeploy tests failed with exit code $LASTEXITCODE" }

dotnet publish $project -c $Configuration -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=false -o $OutputDir
if ($LASTEXITCODE -ne 0) { throw "OperatorDeploy publish failed with exit code $LASTEXITCODE" }

$exe = Join-Path $OutputDir "OperatorDeploy.exe"
if (-not (Test-Path -LiteralPath $exe)) { throw "OperatorDeploy.exe was not produced at $exe" }

if ($SigningThumbprint -or $SignToolPath) {
  if (-not $SigningThumbprint -or -not $SignToolPath) { throw "Provide both -SigningThumbprint and -SignToolPath when signing is enabled." }
  if (-not (Test-Path -LiteralPath $SignToolPath)) { throw "signtool.exe not found: $SignToolPath" }
  & $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $exe
  if ($LASTEXITCODE -ne 0) { throw "signtool failed for OperatorDeploy.exe with exit code $LASTEXITCODE" }
  & $SignToolPath verify /pa /v $exe
  if ($LASTEXITCODE -ne 0) { throw "Authenticode verification failed for OperatorDeploy.exe" }
}

$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash
Write-Host "OperatorDeploy executable: $exe"
Write-Host "SHA-256: $hash"
