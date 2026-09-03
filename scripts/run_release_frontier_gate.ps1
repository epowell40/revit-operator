[CmdletBinding()]
param(
  [switch]$SkipPublic,
  [switch]$SkipDotNet
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Invoke-External([string]$Name, [scriptblock]$Action) {
  Write-Host ""
  Write-Host "== $Name =="
  $global:LASTEXITCODE = 0
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
}

function Resolve-AppRoot([string]$Root, [string]$Name) {
  $publicLayout = Join-Path $Root "apps/$Name"
  if (Test-Path -LiteralPath $publicLayout -PathType Container) { return $publicLayout }
  $privateLayout = Join-Path $Root $Name
  if (Test-Path -LiteralPath $privateLayout -PathType Container) { return $privateLayout }
  return $null
}

function Assert-ManifestCoverage($Manifest) {
  if ([string]$Manifest.schema -cne "revit-operator.release-frontier/v1") {
    throw "Release-frontier manifest schema is invalid."
  }
  $lists = @{
    backend = @($Manifest.backend_tests)
    mcp = @($Manifest.mcp_tests)
    desktop = @($Manifest.desktop_tests)
    dotnet = @($Manifest.dotnet_test_classes)
  }
  $ids = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
  foreach ($family in @($Manifest.failure_families)) {
    $id = [string]$family.id
    if (-not $id -or -not $ids.Add($id) -or @($family.coverage).Count -lt 2) {
      throw "Release-frontier failure families must have unique IDs and at least two boundary checks."
    }
    foreach ($entry in @($family.coverage)) {
      $parts = ([string]$entry).Split(':', 2)
      if ($parts.Count -ne 2 -or -not $lists.ContainsKey($parts[0]) -or $lists[$parts[0]] -cnotcontains $parts[1]) {
        throw "Release-frontier coverage '$entry' is not present in its executable test list."
      }
    }
  }
  if ($ids.Count -lt 12) { throw "Release-frontier manifest has insufficient historical failure-family coverage." }
}

function Invoke-Composition([string]$Root, [string]$Label) {
  $manifestPath = Join-Path $Root "scripts/release_frontier.v1.json"
  if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "$Label release-frontier manifest is missing." }
  $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  Assert-ManifestCoverage $manifest

  Invoke-External "$Label architecture authorities" {
    & (Join-Path $Root "scripts/check_assignment_kernel_boundary.ps1") -RepoRoot $Root
  }

  $backendRoot = Resolve-AppRoot $Root "operator-backend"
  $mcpRoot = Resolve-AppRoot $Root "mcp-server"
  $desktopRoot = Resolve-AppRoot $Root "operator-desktop"
  $dotnetRoot = Resolve-AppRoot $Root "revit-bridge-addin"
  if (-not $backendRoot -or -not $mcpRoot) { throw "$Label backend or MCP source root is missing." }

  foreach ($testFile in @($manifest.backend_tests)) {
    $source = Join-Path $backendRoot "test/$testFile"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "$Label backend frontier test is missing: $testFile" }
  }
  Invoke-External "$Label backend frontier" {
    Push-Location $backendRoot
    try {
      & npm run build
      if ($LASTEXITCODE -ne 0) { return }
      $compiled = @($manifest.backend_tests | ForEach-Object { Join-Path "dist/test" ([string]$_).Replace(".ts", ".js") })
      & node --test --test-concurrency=1 @compiled
    } finally { Pop-Location }
  }

  foreach ($testFile in @($manifest.mcp_tests)) {
    $source = Join-Path $mcpRoot "src/$testFile"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "$Label MCP frontier test is missing: $testFile" }
  }
  Invoke-External "$Label MCP frontier" {
    Push-Location $mcpRoot
    try {
      & npm run build
      if ($LASTEXITCODE -ne 0) { return }
      $compiled = @($manifest.mcp_tests | ForEach-Object { Join-Path "dist" ([string]$_).Replace(".ts", ".js") })
      & node --test @compiled
    } finally { Pop-Location }
  }

  if ($desktopRoot) {
    foreach ($testFile in @($manifest.desktop_tests)) {
      $source = Join-Path $desktopRoot ([string]$testFile)
      if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "$Label Desktop frontier test is missing: $testFile" }
    }
    Invoke-External "$Label Desktop/Sidecar frontier" {
      Push-Location $desktopRoot
      try {
        & node --check server.js
        if ($LASTEXITCODE -ne 0) { return }
        & node --test --test-concurrency=1 @($manifest.desktop_tests)
      } finally { Pop-Location }
    }
  }

  if (-not $SkipDotNet -and $dotnetRoot) {
    $testProject = Join-Path $dotnetRoot "RevitBridge.Common.Tests/RevitBridge.Common.Tests.csproj"
    $filter = @($manifest.dotnet_test_classes | ForEach-Object { "FullyQualifiedName~$_" }) -join '|'
    Invoke-External "$Label native frontier" {
      & dotnet test $testProject -c Release --nologo --filter $filter
    }
  }

  Write-Host "PASS: $Label release frontier covers $(@($manifest.failure_families).Count) historical cross-process failure families."
}

$repoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1)
if (-not $repoRoot) { throw "Not inside the Revit Operator repository." }
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)
Invoke-Composition $repoRoot "Current composition"

$publicRoot = Join-Path $repoRoot "public"
if (-not $SkipPublic -and (Test-Path -LiteralPath (Join-Path $publicRoot ".git"))) {
  Invoke-Composition ([System.IO.Path]::GetFullPath($publicRoot)) "Public composition"
}

Write-Host ""
Write-Host "RELEASE FRONTIER GATE PASSED"
