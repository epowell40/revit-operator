[CmdletBinding(DefaultParameterSetName='Install')]
param(
  [Parameter(Mandatory,ParameterSetName='Install')][string]$BundleRoot,
  [Parameter(Mandatory,ParameterSetName='Install')][string]$AttestationPinSha256,
  [Parameter(Mandatory,ParameterSetName='Rollback')][string]$RollbackReleaseId,
  [Parameter(Mandatory)][string]$DestinationRoot,
  [Parameter(Mandatory)][string]$RevitAddinsRoot,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector,
  [scriptblock]$ManifestWriter
)

$ErrorActionPreference='Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

function Get-ContainedReleasePath([string]$ReleaseId) {
  Assert-SafeReadReleaseId $ReleaseId
  $candidate=[IO.Path]::GetFullPath((Join-Path $script:ReleasesRoot $ReleaseId))
  $prefix=$script:ReleasesRoot.TrimEnd([char]92,[char]47)+[IO.Path]::DirectorySeparatorChar
  if(-not $candidate.StartsWith($prefix,[StringComparison]::OrdinalIgnoreCase)){throw 'SafeRead release path escapes the releases root.'}
  $candidate
}

function Invoke-ManifestWrite([string]$Path,[string]$Content,[int]$Index,[string]$Phase) {
  if($ManifestWriter){& $ManifestWriter $Path $Content $Index $Phase}else{Write-SafeReadAtomicFile -Path $Path -Content $Content}
}

function Restore-ActivationFile($Snapshot,[int]$Index,[string]$Phase) {
  if($Snapshot.Existed){Write-SafeReadAtomicFile -Path $Snapshot.Path -Content $Snapshot.Content}
  elseif(Test-Path -LiteralPath $Snapshot.Path){Remove-Item -LiteralPath $Snapshot.Path -Force}
}

$destination=[IO.Path]::GetFullPath($DestinationRoot);New-Item -ItemType Directory -Force -Path $destination | Out-Null
$script:ReleasesRoot=[IO.Path]::GetFullPath((Join-Path $destination 'releases'));$pinsRoot=Join-Path $destination 'pins';$activationRoot=Join-Path $destination 'activation-staging'
New-Item -ItemType Directory -Force -Path $script:ReleasesRoot,$pinsRoot,$activationRoot | Out-Null
$activePath=Join-Path $destination 'active-release.json'

if($PSCmdlet.ParameterSetName -eq 'Rollback'){
  $releaseRoot=Get-ContainedReleasePath $RollbackReleaseId
  if(-not(Test-Path -LiteralPath $releaseRoot -PathType Container)){throw "SafeRead rollback release does not exist: $RollbackReleaseId"}
  $resolved=(Resolve-Path -LiteralPath $releaseRoot).Path
  if($resolved -cne $releaseRoot){throw 'SafeRead rollback release resolves outside its canonical version path.'}
  # ResolveLinkTarget is unavailable in Windows PowerShell 5.1. Rollback is
  # safer when it rejects every reparse point instead of trying to follow one.
  $releaseDirectory=[IO.DirectoryInfo]::new($releaseRoot)
  if(($releaseDirectory.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'SafeRead rollback release may not be a link or reparse point.'}
  $pinPath=Join-Path $pinsRoot "$RollbackReleaseId.json"
  if(-not(Test-Path -LiteralPath $pinPath -PathType Leaf)){throw "SafeRead rollback pin is missing: $RollbackReleaseId"}
  $pin=(ConvertTo-SafeReadObject $pinPath).attestationPinSha256
  $receipt=Assert-SafeReadBundle -BundleRoot $releaseRoot -AttestationPinSha256 $pin -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
}else{
  $sourceReceipt=Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
  $releaseRoot=Get-ContainedReleasePath $sourceReceipt.ReleaseId
  if(Test-Path -LiteralPath $releaseRoot){throw "SafeRead release already installed: $($sourceReceipt.ReleaseId)"}
  $copyStage=Join-Path $script:ReleasesRoot ('.{0}.{1}.staging' -f $sourceReceipt.ReleaseId,[guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $copyStage | Out-Null
  try{
    Get-ChildItem -LiteralPath (Resolve-Path -LiteralPath $BundleRoot).Path -Force|ForEach-Object{Copy-Item -LiteralPath $_.FullName -Destination $copyStage -Recurse -Force}
    [void](Assert-SafeReadBundle -BundleRoot $copyStage -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector)
    Move-Item -LiteralPath $copyStage -Destination $releaseRoot
    $receipt=Assert-SafeReadBundle -BundleRoot $releaseRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
    [IO.File]::WriteAllText((Join-Path $pinsRoot "$($receipt.ReleaseId).json"),(ConvertTo-SafeReadCanonicalJson ([ordered]@{attestationPinSha256=$AttestationPinSha256})),[Text.UTF8Encoding]::new($false))
  }catch{if(Test-Path -LiteralPath $copyStage){Remove-Item -LiteralPath $copyStage -Recurse -Force};throw}
}

# Render and validate all three final manifests before any live activation file changes.
$activationStage=Join-Path $activationRoot ('{0}.{1}' -f $receipt.ReleaseId,[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $activationStage | Out-Null
$prepared=@()
foreach($target in @($receipt.Targets|Sort-Object revitYear)){
  $year=[string]$target.revitYear
  $template=Join-Path $releaseRoot "targets\$year\manifest\RevitOperator.SafeReadHost.addin.template"
  $assembly=Join-Path $releaseRoot "targets\$year\payload\RevitOperator.SafeReadHost.dll"
  $content=New-SafeReadInstalledManifest -TemplatePath $template -AssemblyPath $assembly
  $stagedPath=Join-Path $activationStage "$year\RevitOperator.SafeReadHost.addin";New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stagedPath)|Out-Null
  [IO.File]::WriteAllText($stagedPath,$content,[Text.UTF8Encoding]::new($false));[void](Assert-SafeReadManifestXml -Path $stagedPath -ExpectedAssembly $assembly)
  $livePath=Join-Path ([IO.Path]::GetFullPath($RevitAddinsRoot)) "$year\RevitOperator.SafeReadHost.addin"
  $prepared += [pscustomobject]@{Year=$year;Path=$livePath;Content=$content;Assembly=$assembly}
}
if($prepared.Count -ne 3){throw 'SafeRead activation staging did not produce all three manifests.'}

$snapshots=@($prepared|ForEach-Object{[pscustomobject]@{Path=$_.Path;Existed=Test-Path -LiteralPath $_.Path;Content=if(Test-Path -LiteralPath $_.Path){Get-Content -LiteralPath $_.Path -Raw}else{$null}}})
$activeSnapshot=[pscustomobject]@{Path=$activePath;Existed=Test-Path -LiteralPath $activePath;Content=if(Test-Path -LiteralPath $activePath){Get-Content -LiteralPath $activePath -Raw}else{$null}}
try{
  for($index=0;$index -lt $prepared.Count;$index++){
    $entry=$prepared[$index];New-Item -ItemType Directory -Force -Path (Split-Path -Parent $entry.Path)|Out-Null
    Invoke-ManifestWrite $entry.Path $entry.Content $index 'activate'
    [void](Assert-SafeReadManifestXml -Path $entry.Path -ExpectedAssembly $entry.Assembly)
  }
  Write-SafeReadAtomicFile -Path $activePath -Content (ConvertTo-SafeReadCanonicalJson ([ordered]@{releaseId=$receipt.ReleaseId;releaseManifestSha256=$receipt.ReleaseManifestSha256}))
}catch{
  for($index=$snapshots.Count-1;$index -ge 0;$index--){Restore-ActivationFile $snapshots[$index] $index 'rollback'}
  Restore-ActivationFile $activeSnapshot -1 'pointer-rollback'
  throw
}
Write-Host "SafeRead package active release: $($receipt.ReleaseId)"
