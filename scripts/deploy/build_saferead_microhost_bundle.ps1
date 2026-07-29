[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InputManifestPath,
  [Parameter(Mandatory)][string]$OutputRoot,
  [Parameter(Mandatory)][string]$SignToolPath,
  [Parameter(Mandatory)][string]$SigningThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com'
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadMicrohost.psm1') -Force
$inputPath = (Resolve-Path -LiteralPath $InputManifestPath).Path
$input = ConvertTo-SafeReadObject $inputPath
if ($input.schemaVersion -ne 'safe-read-microhost-input/v1') { throw 'Input manifest must use safe-read-microhost-input/v1.' }
if (-not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool.exe not found: $SignToolPath" }
$inputDirectory = Split-Path -Parent $inputPath
$releaseId = [string]$input.releaseId
if ($releaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw 'Input releaseId is invalid.' }
$outputParent = (Resolve-Path -LiteralPath $OutputRoot).Path
$bundleRoot = Join-Path $outputParent ("SafeReadMicrohost-{0}" -f $releaseId)
if (Test-Path -LiteralPath $bundleRoot) { throw "Refusing to overwrite existing SafeRead bundle: $bundleRoot" }
$stage = Join-Path $outputParent (".SafeReadMicrohost-{0}.{1}.staging" -f $releaseId, [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $release = [ordered]@{ schemaVersion = 'safe-read-microhost-release/v1'; releaseId = $releaseId; allowedSignerThumbprints = @($input.allowedSignerThumbprints | ForEach-Object { ([string]$_).Replace(' ', '').ToUpperInvariant() }); targets = @() }
  if ($release.allowedSignerThumbprints.Count -eq 0) { throw 'Input requires allowedSignerThumbprints.' }
  $seen = @{}
  foreach ($sourceTarget in @($input.targets)) {
    $year = [string]$sourceTarget.revitYear
    if ($seen.ContainsKey($year)) { throw "Input repeats Revit year $year." }; $seen[$year] = $true
    $expected = Get-SafeReadExpectedTarget $year
    if ($sourceTarget.framework -ne $expected.Framework -or $sourceTarget.apiVersion -ne $expected.ApiVersion) { throw "Input target $year has incorrect framework or API version." }
    $targetRoot = Join-Path $stage ("targets\\{0}" -f $year)
    $payload = Join-Path $targetRoot 'payload'; $manifestDirectory = Join-Path $targetRoot 'manifest'
    New-Item -ItemType Directory -Force -Path $payload,$manifestDirectory | Out-Null
    $sourceDll = [string]$sourceTarget.sourceDll
    if (-not [IO.Path]::IsPathRooted($sourceDll)) { $sourceDll = Join-Path $inputDirectory $sourceDll }
    if (-not (Test-Path -LiteralPath $sourceDll -PathType Leaf)) { throw "Input target $year sourceDll is missing: $sourceDll" }
    $destinationDll = Join-Path $payload 'RevitBridge.SafeRead.Addin.dll'
    Copy-Item -LiteralPath $sourceDll -Destination $destinationDll
    # The file is signed in its immutable staging location before any final hash is computed.
    & $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $destinationDll
    if ($LASTEXITCODE -ne 0) { throw "signtool failed for SafeRead $year with exit code $LASTEXITCODE" }
    $templatePath = Join-Path $manifestDirectory 'RevitBridge.SafeRead.addin.template'
    [IO.File]::WriteAllText($templatePath, (New-SafeReadAddinTemplate $sourceTarget.identity), [Text.UTF8Encoding]::new($false))
    $release.targets += [ordered]@{
      revitYear = $year; framework = $expected.Framework; apiVersion = $expected.ApiVersion; identity = ConvertTo-SafeReadHashtable $sourceTarget.identity
      files = @(
        [ordered]@{ path = 'payload/RevitBridge.SafeRead.Addin.dll'; sha256 = Get-SafeReadSha256 $destinationDll; sizeBytes = (Get-Item -LiteralPath $destinationDll).Length },
        [ordered]@{ path = 'manifest/RevitBridge.SafeRead.addin.template'; sha256 = Get-SafeReadSha256 $templatePath; sizeBytes = (Get-Item -LiteralPath $templatePath).Length }
      )
    }
  }
  if ($seen.Count -ne 3) { throw 'Input must supply exactly 2023, 2024, and 2025 targets.' }
  $releasePath = Join-Path $stage 'release-manifest.json'
  [IO.File]::WriteAllText($releasePath, (ConvertTo-SafeReadCanonicalJson $release), [Text.UTF8Encoding]::new($false))
  $attestation = [ordered]@{ schemaVersion = 'safe-read-microhost-attestation/v1'; releaseId = $releaseId; releaseManifestSha256 = Get-SafeReadSha256 $releasePath; issuedFor = 'deployment-owner-pin-required' }
  $attestationPath = Join-Path $stage 'deployment-attestation.json'
  [IO.File]::WriteAllText($attestationPath, (ConvertTo-SafeReadCanonicalJson $attestation), [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $stage -Destination $bundleRoot
  Write-Host "SafeRead bundle created: $bundleRoot"
  Write-Host "External deployment attestation pin (SHA-256): $(Get-SafeReadSha256 (Join-Path $bundleRoot 'deployment-attestation.json'))"
} catch { if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }; throw }
