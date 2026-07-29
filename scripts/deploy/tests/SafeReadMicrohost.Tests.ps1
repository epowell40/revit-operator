$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'SafeReadPackageV2.Pester.ps1')
return

$deployRoot = Split-Path -Parent $PSScriptRoot
$verify = Join-Path $deployRoot 'verify_saferead_microhost_bundle.ps1'
$install = Join-Path $deployRoot 'install_saferead_microhost_bundle.ps1'

function New-SyntheticSafeReadBundle {
  param([Parameter(Mandatory)][string]$Root, [string]$ReleaseId = 'safe-read-test-1')
  $module = Join-Path $deployRoot 'SafeReadMicrohost.psm1'; Import-Module $module -Force
  New-Item -ItemType Directory -Path $Root -Force | Out-Null
  $targets = @()
  foreach ($year in '2023','2024','2025') {
    $targetRoot = Join-Path $Root "targets\\$year"; $payload = Join-Path $targetRoot 'payload'; $manifest = Join-Path $targetRoot 'manifest'
    New-Item -ItemType Directory -Force -Path $payload,$manifest | Out-Null
    $dll = Join-Path $payload 'RevitBridge.SafeRead.Addin.dll'; [IO.File]::WriteAllText($dll, "synthetic-$year", [Text.UTF8Encoding]::new($false))
    $identity = [pscustomobject]@{ Name = 'RevitOperator SafeRead'; AddInId = ('11111111-1111-1111-1111-{0}' -f $year.PadLeft(12,'0')); FullClassName = 'RevitBridge.SafeRead.App'; VendorId = 'com.revitoperator.saferead'; VendorDescription = 'Synthetic SafeRead' }
    $template = Join-Path $manifest 'RevitBridge.SafeRead.addin.template'; [IO.File]::WriteAllText($template, (New-SafeReadAddinTemplate $identity), [Text.UTF8Encoding]::new($false))
    $expected = Get-SafeReadExpectedTarget $year
    $targets += [ordered]@{ revitYear = $year; framework = $expected.Framework; apiVersion = $expected.ApiVersion; identity = ConvertTo-SafeReadHashtable $identity; files = @(
      [ordered]@{ path='payload/RevitBridge.SafeRead.Addin.dll'; sha256=Get-SafeReadSha256 $dll; sizeBytes=(Get-Item -LiteralPath $dll).Length },
      [ordered]@{ path='manifest/RevitBridge.SafeRead.addin.template'; sha256=Get-SafeReadSha256 $template; sizeBytes=(Get-Item -LiteralPath $template).Length }
    ) }
  }
  $release = [ordered]@{ schemaVersion='safe-read-microhost-release/v1'; releaseId=$ReleaseId; allowedSignerThumbprints=@('TESTSIGNER'); targets=$targets }
  $releasePath = Join-Path $Root 'release-manifest.json'; [IO.File]::WriteAllText($releasePath, (ConvertTo-SafeReadCanonicalJson $release), [Text.UTF8Encoding]::new($false))
  $attestationPath = Join-Path $Root 'deployment-attestation.json'; $attestation = [ordered]@{ schemaVersion='safe-read-microhost-attestation/v1'; releaseId=$ReleaseId; releaseManifestSha256=Get-SafeReadSha256 $releasePath; issuedFor='test' }
  [IO.File]::WriteAllText($attestationPath, (ConvertTo-SafeReadCanonicalJson $attestation), [Text.UTF8Encoding]::new($false))
  [pscustomobject]@{ Root=$Root; Pin=Get-SafeReadSha256 $attestationPath }
}

function Assert-ThrowsLike {
  param([Parameter(Mandatory)][scriptblock]$Action, [Parameter(Mandatory)][string]$Pattern)
  try { & $Action } catch {
    if ($_.Exception.Message -like $Pattern) { return }
    throw "Expected failure like '$Pattern', got '$($_.Exception.Message)'."
  }
  throw "Expected failure like '$Pattern', but the action succeeded."
}

Describe 'SafeRead microhost black-box bundle verification' {
  BeforeEach {
    $testRoot = Join-Path $TestDrive ([guid]::NewGuid().ToString('N'))
    $bundle = New-SyntheticSafeReadBundle -Root $testRoot
    $validSignature = { param($Path) [pscustomobject]@{ Status='Valid'; Thumbprint='TESTSIGNER' } }
  }
  It 'accepts all three supported targets and the SafeRead DLL name' {
    & $verify -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $validSignature
  }
  It 'rejects a missing declared file' {
    Remove-Item -LiteralPath (Join-Path $bundle.Root 'targets\\2023\\payload\\RevitBridge.SafeRead.Addin.dll')
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $validSignature } '*missing or extra*'
  }
  It 'rejects an extra payload file' {
    [IO.File]::WriteAllText((Join-Path $bundle.Root 'targets\\2024\\payload\\unexpected.dll'), 'x')
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $validSignature } '*missing or extra*'
  }
  It 'rejects a post-attestation payload tamper' {
    [IO.File]::AppendAllText((Join-Path $bundle.Root 'targets\\2025\\payload\\RevitBridge.SafeRead.Addin.dll'), 'tamper')
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $validSignature } '*hash mismatch*'
  }
  It 'rejects mixed-year framework metadata' {
    $manifest = Get-Content -LiteralPath (Join-Path $bundle.Root 'release-manifest.json') -Raw | ConvertFrom-Json
    $manifest.targets[0].framework = 'net8.0-windows'; [IO.File]::WriteAllText((Join-Path $bundle.Root 'release-manifest.json'), ($manifest | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
    $attestationPath = Join-Path $bundle.Root 'deployment-attestation.json'; $attestation = Get-Content -LiteralPath $attestationPath -Raw | ConvertFrom-Json; $attestation.releaseManifestSha256 = Get-SafeReadSha256 (Join-Path $bundle.Root 'release-manifest.json'); [IO.File]::WriteAllText($attestationPath, ($attestation | ConvertTo-Json -Depth 12 -Compress), [Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 (Get-SafeReadSha256 $attestationPath) -SignatureVerifier $validSignature } '*mixed year/framework/API*'
  }
  It 'rejects a stale deployment-owned attestation pin' {
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 ('0' * 64) -SignatureVerifier $validSignature } '*attestation pin*'
  }
  It 'rejects a signer outside the release allowlist' {
    $wrongSigner = { param($Path) [pscustomobject]@{ Status='Valid'; Thumbprint='NOT-ALLOWED' } }
    Assert-ThrowsLike { & $verify -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $wrongSigner } '*allowlist*'
  }
  It 'rolls back atomically and coexists with the main manifest' {
    $destination = Join-Path $TestDrive 'installed'; $addinRoot = Join-Path $TestDrive 'RevitAddins'
    New-Item -ItemType Directory -Force -Path (Join-Path $addinRoot '2023') | Out-Null
    $mainManifest = Join-Path $addinRoot '2023\\RevitBridge.addin'; [IO.File]::WriteAllText($mainManifest, '<main/>')
    & $install -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addinRoot -SignatureVerifier $validSignature
    $second = New-SyntheticSafeReadBundle -Root (Join-Path $TestDrive 'bundle2') -ReleaseId 'safe-read-test-2'
    & $install -BundleRoot $second.Root -AttestationPinSha256 $second.Pin -DestinationRoot $destination -RevitAddinsRoot $addinRoot -SignatureVerifier $validSignature
    & $install -RollbackReleaseId 'safe-read-test-1' -DestinationRoot $destination -RevitAddinsRoot $addinRoot -SignatureVerifier $validSignature
    $active = Get-Content -LiteralPath (Join-Path $destination 'active-release.json') -Raw | ConvertFrom-Json
    if ($active.releaseId -ne 'safe-read-test-1') { throw 'Rollback did not restore safe-read-test-1.' }
    if ((Get-Content -LiteralPath $mainManifest -Raw) -ne '<main/>') { throw 'Main RevitBridge.addin was changed.' }
    if (-not (Test-Path -LiteralPath (Join-Path $addinRoot '2023\\RevitBridge.SafeRead.addin'))) { throw 'SafeRead manifest was not installed.' }
  }
}
