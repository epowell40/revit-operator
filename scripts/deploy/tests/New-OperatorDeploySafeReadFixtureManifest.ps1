[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$BundleRoot,
  [Parameter(Mandatory)][string]$ManifestPath,
  [Parameter(Mandatory)][string]$ReleaseVersion
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=(Resolve-Path -LiteralPath $RepositoryRoot).Path
$bundle=(Resolve-Path -LiteralPath $BundleRoot).Path
$manifest=[IO.Path]::GetFullPath($ManifestPath)
$manifestRoot=Split-Path -Parent $manifest
[IO.Directory]::CreateDirectory($manifestRoot)|Out-Null
$packageRoot=[IO.Path]::GetRelativePath($manifestRoot,$bundle).Replace('\','/')
if([IO.Path]::IsPathRooted($packageRoot)-or $packageRoot -eq '..' -or $packageRoot.StartsWith('../',[StringComparison]::Ordinal)){
  throw 'The SafeRead fixture package must be beneath the OperatorDeploy manifest directory.'
}

Import-Module (Join-Path $repository 'scripts\deploy\SafeReadPackageV2.psm1') -Force

function New-FileRecord([string]$Root,[string]$Path){
  $full=Join-Path $Root ($Path.Replace('/',[IO.Path]::DirectorySeparatorChar))
  [ordered]@{path=$Path;size=(Get-Item -LiteralPath $full).Length;sha256=(Get-SafeReadSha256 $full).Substring(7)}
}

$evidenceFiles=@(@('package-pins.json','release-manifest.json','source.snapshot.receipt.json')|Sort-Object|ForEach-Object{New-FileRecord $bundle $_})
$components=@([ordered]@{id='safe-read-evidence';kind='safe-read-evidence';version='real-fixture';required=$true;installScope='user';payloadPath=$packageRoot;installWhenRevitMissing=$true;preserveExisting=$false;files=$evidenceFiles})
$targetMappings=@()
foreach($year in '2023','2024','2025'){
  $componentId="safe-read-$year"
  $targetRoot=Join-Path $bundle "targets\$year"
  $prefix=$targetRoot.TrimEnd([char]92,[char]47)+[IO.Path]::DirectorySeparatorChar
  $files=@(Get-ChildItem -LiteralPath $targetRoot -File -Recurse|ForEach-Object{
    $relative=$_.FullName.Substring($prefix.Length).Replace('\','/')
    New-FileRecord $targetRoot $relative
  }|Sort-Object path)
  $components += [ordered]@{id=$componentId;kind='revit-addin';version='real-fixture';required=$true;installScope='user';payloadPath="$packageRoot/targets/$year";revitYear=$year;revitAddinProfileId='safe-read';installWhenRevitMissing=$true;preserveExisting=$false;files=$files}
  $targetMappings += [ordered]@{revitYear=$year;componentId=$componentId}
}

$operatorManifest=[ordered]@{
  schemaVersion=3
  releaseVersion=$ReleaseVersion
  generatedAtUtc='2026-07-29T12:00:00Z'
  sourceRevision='real-package-fixture'
  minimumWindowsVersion='10.0.17763'
  revitAddinProfiles=@([ordered]@{id='safe-read';manifestFileName='RevitOperator.SafeReadHost.addin';assemblyPath='payload/RevitOperator.SafeReadHost.dll';type='Application';name='Revit Operator Safe Read Host';fullClassName='RevitOperator.SafeReadHost.App';addInId='AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E';vendorId='BIMT';vendorDescription='BIMTools Revit Operator Safe Read Host'})
  safeReadAdmission=[ordered]@{schema='revit-operator.operator-deploy-safe-read.v1';profileId='safe-read';packageRoot=$packageRoot;evidenceComponentId='safe-read-evidence';targets=$targetMappings}
  components=$components
}
[IO.File]::WriteAllText($manifest,($operatorManifest|ConvertTo-Json -Depth 32),[Text.UTF8Encoding]::new($false))

[pscustomobject]@{
  manifestPath=$manifest
  manifestSha256=Get-SafeReadSha256 $manifest
  releaseVersion=$ReleaseVersion
  packageRoot=$packageRoot
  years=@('2023','2024','2025')
}
