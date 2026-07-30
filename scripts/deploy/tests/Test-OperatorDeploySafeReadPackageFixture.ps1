[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$OutputRoot,
  [string]$CrashHarnessPath
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$repository=(Resolve-Path -LiteralPath $RepositoryRoot).Path
$output=[IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($output)|Out-Null
$modulePath=Join-Path $repository 'scripts\deploy\SafeReadPackageV2.psm1'
Import-Module $modulePath -Force

function Invoke-Harness([string]$Operation,[string]$ManifestPath,[string]$ReceiptPath,[string]$ReceiptSha256,[string]$PackagePinSha256,[string]$KillPoint='no-kill',[bool]$BundleOnly=$false){
  $input=[ordered]@{
    LocalAppData=$profileLocal
    AppData=$profileRoaming
    Desktop=$profileDesktop
    ProgramFiles=(Join-Path $profileRoot 'program-files')
    CommonAppData=(Join-Path $profileRoot 'program-data')
    Operation=$Operation
    ManifestPath=if([string]::IsNullOrWhiteSpace($ManifestPath)){$null}else{$ManifestPath}
    SafeReadAdmissionReceiptPath=if([string]::IsNullOrWhiteSpace($ReceiptPath)){$null}else{$ReceiptPath}
    SafeReadAdmissionReceiptSha256=if([string]::IsNullOrWhiteSpace($ReceiptSha256)){$null}else{$ReceiptSha256}
    SafeReadPackagePinSha256=if([string]::IsNullOrWhiteSpace($PackagePinSha256)){$null}else{$PackagePinSha256}
    BundleOnly=$BundleOnly
    KillPoint=$KillPoint
  }
  $encoded=[Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($input|ConvertTo-Json -Compress)))
  & dotnet $CrashHarnessPath $encoded
  if($LASTEXITCODE -ne 0){throw "OperatorDeploy crash harness operation '$Operation' failed with exit $LASTEXITCODE."}
}

$buildRoot=Join-Path $output 'package-build'
$buildReceiptPath=Join-Path $output 'package-build.receipt.json'
[IO.Directory]::CreateDirectory($buildRoot)|Out-Null
& (Join-Path $repository 'scripts\deploy\tests\Invoke-SafeReadRealPackageFixture.ps1') -RepositoryRoot $repository -OutputRoot $buildRoot -ReceiptPath $buildReceiptPath|Out-Host
$buildReceipt=Get-Content -LiteralPath $buildReceiptPath -Raw|ConvertFrom-Json
$bundleRoot=[IO.Path]::GetFullPath([string]$buildReceipt.bundleRoot)
$operatorRoot=Split-Path -Parent $bundleRoot
$packageRoot=Split-Path -Leaf $bundleRoot
$releaseVersion='operator-safe-read-real-v1'
$profileRoot=Join-Path $output 'profile'
$profileLocal=Join-Path $profileRoot 'local'
$profileRoaming=Join-Path $profileRoot 'roaming'
$profileDesktop=Join-Path $profileRoot 'desktop'
$finalReleaseRoot=Join-Path $profileLocal "RevitOperator\releases\$releaseVersion"
[IO.Directory]::CreateDirectory((Split-Path -Parent $finalReleaseRoot))|Out-Null
[IO.Directory]::CreateDirectory($profileRoaming)|Out-Null
[IO.Directory]::CreateDirectory($profileDesktop)|Out-Null

$operatorManifestPath=Join-Path $operatorRoot "$releaseVersion.manifest.json"
& (Join-Path $repository 'scripts\deploy\tests\New-OperatorDeploySafeReadFixtureManifest.ps1') `
  -RepositoryRoot $repository `
  -BundleRoot $bundleRoot `
  -ManifestPath $operatorManifestPath `
  -ReleaseVersion $releaseVersion|Out-Host

$coordination=Join-Path $output 'coordination'
[IO.Directory]::CreateDirectory($coordination)|Out-Null
$admissionPath=Join-Path $coordination "$releaseVersion.admission.receipt.v2.json"
& (Join-Path $repository 'scripts\deploy\tests\Test-SafeReadAdmissionRealPackageFixture.ps1') `
  -Prepare `
  -BundleRoot $bundleRoot `
  -AttestationPinSha256 ([string]$buildReceipt.attestationPinSha256) `
  -ManifestAssemblyRoot $finalReleaseRoot `
  -CoordinationRoot $coordination `
  -ReceiptPath $admissionPath `
  -OperatorDeployManifestPath $operatorManifestPath|Out-Host
$admissionSha256=Get-SafeReadSha256 $admissionPath

if([string]::IsNullOrWhiteSpace($CrashHarnessPath)){
  $CrashHarnessPath=Join-Path $repository 'packages\operator-deploy\OperatorDeploy.Tests\CrashHarness\bin\Release\net8.0-windows\win-x64\OperatorDeploy.CrashHarness.dll'
}
$CrashHarnessPath=(Resolve-Path -LiteralPath $CrashHarnessPath).Path
Invoke-Harness 'update' $operatorManifestPath $admissionPath $admissionSha256 ([string]$buildReceipt.attestationPinSha256)
Invoke-Harness 'validate' '' '' '' ''

$statePath=Join-Path $profileLocal 'RevitOperator\deployment\state.json'
$state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
if([int]$state.schemaVersion -ne 3 -or [string]$state.currentRelease -cne $releaseVersion -or @($state.safeReadAdmissions).Count -ne 1){throw 'OperatorDeploy real package fixture did not persist one schema-v3 admission binding.'}
foreach($year in '2023','2024','2025'){
  $manifestPath=Join-Path $profileRoaming "Autodesk\Revit\Addins\$year\RevitOperator.SafeReadHost.addin"
  if(-not(Test-Path -LiteralPath $manifestPath -PathType Leaf)){throw "OperatorDeploy real package fixture omitted Revit $year activation."}
  $expectedAssembly=Join-Path $finalReleaseRoot "safe-read-$year\payload\RevitOperator.SafeReadHost.dll"
  if((Get-Content -LiteralPath $manifestPath -Raw) -notlike "*$expectedAssembly*"){throw "OperatorDeploy Revit $year manifest is detached from the final admitted assembly path."}
}

[pscustomobject]@{
  releaseVersion=$releaseVersion
  operatorManifestPath=$operatorManifestPath
  operatorManifestSha256=Get-SafeReadSha256 $operatorManifestPath
  admissionReceiptPath=$admissionPath
  admissionReceiptSha256=$admissionSha256
  packagePinSha256=[string]$buildReceipt.attestationPinSha256
  installedStatePath=$statePath
  years=@('2023','2024','2025')
  packageToInstalledValidation=$true
}
