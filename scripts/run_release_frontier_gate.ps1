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
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  try {
    $global:LASTEXITCODE = 0
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Name failed with exit code $LASTEXITCODE" }
  } finally {
    $timer.Stop()
    Write-Host ('FRONTIER_TIMING name="{0}" elapsed_seconds={1:N1}' -f $Name, $timer.Elapsed.TotalSeconds)
  }
}

function Resolve-AppRoot([string]$Root, [string]$Name) {
  $publicLayout = Join-Path $Root "apps/$Name"
  if (Test-Path -LiteralPath $publicLayout -PathType Container) { return $publicLayout }
  $privateLayout = Join-Path $Root $Name
  if (Test-Path -LiteralPath $privateLayout -PathType Container) { return $privateLayout }
  return $null
}

function Get-JavaScriptTests($Manifest) {
  # Optional in v1 so older manifests retain their existing behavior.
  $property = $Manifest.PSObject.Properties["javascript_tests"]
  if ($property) { return @($property.Value) }
  return @()
}

function Resolve-JavaScriptTest([string]$Root, [string]$Entry) {
  if ($Entry -cnotmatch '^(app|package)/([A-Za-z0-9._-]+)/(.+\.(?:mjs|cjs|js))$') {
    throw "Invalid JavaScript frontier test reference: $Entry"
  }
  $kind, $name, $relative = $Matches[1], $Matches[2], $Matches[3]
  if ($name -in @(".", "..") -or [System.IO.Path]::IsPathRooted($relative) -or $relative.Contains(":")) {
    throw "JavaScript frontier test must stay within its app or package: $Entry"
  }
  $base = if ($kind -ceq "app") { Resolve-AppRoot $Root $name } else { Join-Path $Root "packages/$name" }
  if (-not $base) { throw "JavaScript frontier app root is missing: $Entry" }
  $base = [System.IO.Path]::GetFullPath($base)
  $source = [System.IO.Path]::GetFullPath((Join-Path $base $relative))
  $prefix = $base.TrimEnd([char[]]@('\', '/')) + [System.IO.Path]::DirectorySeparatorChar
  if (-not $source.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "JavaScript frontier test escapes its app or package: $Entry"
  }
  if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "JavaScript frontier test is missing: $Entry" }
  return $source
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
    dynamic = @($Manifest.dynamic_runtime_test_classes)
    javascript = @(Get-JavaScriptTests $Manifest)
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
  Invoke-External "$Label benchmark/runtime separation" {
    & (Join-Path $Root "scripts/check_benchmark_runtime_boundary.ps1") -RepoRoot $Root
  }

  $backendRoot = Resolve-AppRoot $Root "operator-backend"
  $mcpRoot = Resolve-AppRoot $Root "mcp-server"
  $desktopRoot = Resolve-AppRoot $Root "operator-desktop"
  $dotnetRoot = Resolve-AppRoot $Root "revit-bridge-addin"
  if (-not $backendRoot -or -not $mcpRoot) { throw "$Label backend or MCP source root is missing." }

  $javascriptTests = @(Get-JavaScriptTests $manifest | ForEach-Object { Resolve-JavaScriptTest $Root ([string]$_) })
  if ($javascriptTests.Count -gt 0) {
    Invoke-External "$Label JavaScript frontier" {
      Push-Location $Root
      try { & node --test --test-concurrency=1 @javascriptTests } finally { Pop-Location }
    }
  }

  foreach ($testFile in @($manifest.backend_tests)) {
    $source = Join-Path $backendRoot "test/$testFile"
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "$Label backend frontier test is missing: $testFile" }
  }
  Invoke-External "$Label backend frontier" {
    Push-Location $backendRoot
    try {
      & npm run build
      if ($LASTEXITCODE -ne 0) { return }
      & node scripts/run-tests.mjs --jobs=4 "--frontier-manifest=$manifestPath"
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
      # The policy JSON is embedded into RevitBridge.Common while its matching
      # hash is compiled from generated C#. An incremental multi-target build
      # can leave one test TFM with new JSON and an old compiled constant.
      & dotnet build $testProject -c Release --no-incremental --nologo --disable-build-servers -p:UseSharedCompilation=false -m:1
      if ($LASTEXITCODE -ne 0) { return }
      & dotnet test $testProject -c Release --no-build --nologo --filter $filter
    }
  }

  if (-not $SkipDotNet) {
    $dynamicRoot = Resolve-AppRoot $Root "dynamic-revit-runtime"
    if (-not $dynamicRoot) { throw "$Label generated-code runtime source root is missing." }
    foreach ($class in @($manifest.dynamic_runtime_test_classes)) {
      if (-not (Test-Path -LiteralPath (Join-Path $dynamicRoot "DynamicRevitSandboxSupervisor.Tests/$class.cs"))) {
        throw "$Label generated-code frontier test is missing: $class"
      }
    }
    $dynamicProject = Join-Path $dynamicRoot "DynamicRevitSandboxSupervisor.Tests/DynamicRevitSandboxSupervisor.Tests.csproj"
    $dynamicFilter = @($manifest.dynamic_runtime_test_classes | ForEach-Object { "FullyQualifiedName~$_" }) -join '|'
    Invoke-External "$Label generated-code frontier" {
      & dotnet test $dynamicProject -c Release --nologo --filter $dynamicFilter --disable-build-servers -p:UseSharedCompilation=false -m:1
    }
  }

  Write-Host "PASS: $Label release frontier covers $(@($manifest.failure_families).Count) historical cross-process failure families."
}

$repoRoot = (& git rev-parse --show-toplevel | Select-Object -First 1)
if (-not $repoRoot) { throw "Not inside the Revit Operator repository." }
$repoRoot = [System.IO.Path]::GetFullPath($repoRoot)
$certificationRoot = $repoRoot
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "apps/operator-backend/src/tools/compile_tool_certification_evidence.ts"))) {
  $certificationRoot = Join-Path $repoRoot "public"
}
$certificationBackend = Resolve-AppRoot $certificationRoot "operator-backend"
if ($certificationBackend -and (Test-Path -LiteralPath (Join-Path $certificationBackend "src/tools/compile_tool_certification_evidence.ts"))) {
  Invoke-External "Public source certification freshness" {
    Push-Location $certificationBackend
    try { & npm run check:tool-certification-evidence } finally { Pop-Location }
  }
}
Invoke-Composition $repoRoot "Current composition"

$publicRoot = Join-Path $repoRoot "public"
if (-not $SkipPublic -and (Test-Path -LiteralPath (Join-Path $publicRoot ".git"))) {
  Invoke-Composition ([System.IO.Path]::GetFullPath($publicRoot)) "Public composition"
}

Write-Host ""
Write-Host "RELEASE FRONTIER GATE PASSED"
