[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$productionRoot = Split-Path -Parent $PSCommandPath
$proofRoot = Split-Path -Parent $productionRoot
$publicRoot = Split-Path -Parent (Split-Path -Parent $proofRoot)
$sourceRoot = Join-Path $publicRoot 'apps\revit-safe-read-host\src\RevitOperator.SafeReadCertifiedExecution'
$sourcePath = Join-Path $sourceRoot 'RevitCertifiedExecution.cs'
$expectedPath = Join-Path $productionRoot 'production.expected.json'
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)

if (-not [System.IO.Path]::IsPathFullyQualified($OutputPath)) {
    throw 'OutputPath must be absolute.'
}
if (Test-Path -LiteralPath $outputFull) {
    throw "OutputPath already exists: $outputFull"
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
    throw "Fixed certified kernel source is missing: $sourcePath"
}
if (-not (Test-Path -LiteralPath $expectedPath -PathType Leaf)) {
    throw "Fixed production expected inventory is missing: $expectedPath"
}
foreach ($year in @('2023', '2024', '2025')) {
    $revitApi = "C:\Program Files\Autodesk\Revit $year\RevitAPI.dll"
    if (-not (Test-Path -LiteralPath $revitApi -PathType Leaf)) {
        throw "Fixed installed Revit API reference is missing: $revitApi"
    }
}

$parent = Split-Path -Parent $outputFull
[System.IO.Directory]::CreateDirectory($parent) | Out-Null
. (Join-Path $proofRoot 'tests\TestSupport.ps1')

# Every security-relevant input is fixed here.  There is deliberately no source,
# reference, policy, expected-inventory, or compiler override parameter.
New-ProofFixtureManifest `
    -ProofRoot $proofRoot `
    -SourceRoot $sourceRoot `
    -ReferenceRoot $proofRoot `
    -ManifestPath $outputFull `
    -ExpectedPath $expectedPath `
    -CompileFiles @('RevitCertifiedExecution.cs') `
    -UseInstalledRevit

[pscustomobject]@{
    SchemaVersion = 1
    ManifestPath = $outputFull
    SourcePath = $sourcePath
    ExpectedPath = $expectedPath
    RevitYears = @('2023', '2024', '2025')
}
