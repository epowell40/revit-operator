[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$OutputRoot,
  [string]$CrashHarnessPath
)
$ErrorActionPreference='Stop'
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
$powershell=(Get-Command powershell.exe -ErrorAction Stop).Source
$root=[IO.Path]::GetFullPath($OutputRoot)
[IO.Directory]::CreateDirectory($root)|Out-Null

function Invoke-Edition([string]$Label,[string]$Exe,[string[]]$Arguments){
  $output=@(& $Exe @Arguments 2>&1)
  if($LASTEXITCODE -ne 0){throw "$Label failed with exit $LASTEXITCODE`: $([string]::Join(' | ',@($output)))"}
  $output|ForEach-Object{Write-Host $_}
}

function Assert-ReceiptV2([string]$Path,[string]$ExpectedManifestRoot){
  $receipt=Get-Content -LiteralPath $Path -Raw|ConvertFrom-Json
  if([string]$receipt.schema -cne 'revit-operator.safe-read-admission-receipt.v2'){throw "Admission receipt is not schema v2: $Path"}
  if([string]$receipt.operatorDeploy.schema -cne 'revit-operator.operator-deploy-safe-read-layout.v1'){throw "Admission receipt omits the OperatorDeploy layout: $Path"}
  if(@($receipt.operatorDeploy.targets).Count -ne 3){throw "Admission receipt does not bind exactly three OperatorDeploy targets: $Path"}
  if([IO.Path]::GetFullPath([string]$receipt.manifestAssemblyRoot) -cne [IO.Path]::GetFullPath($ExpectedManifestRoot)){throw "Admission receipt is detached from the C# final release root: $Path"}
}

function Assert-IdenticalReceiptBytes([string]$Left,[string]$Right,[string]$Label){
  $leftBytes=[IO.File]::ReadAllBytes($Left);$rightBytes=[IO.File]::ReadAllBytes($Right)
  if([Convert]::ToBase64String($leftBytes) -cne [Convert]::ToBase64String($rightBytes)){throw "$Label produced different canonical receipt-v2 bytes."}
}

function Invoke-CSharpBundleValidation([string]$Label,[string]$ProfileRoot,[string]$ManifestPath,[string]$ReceiptPath,[string]$ReceiptSha256,[string]$PackagePinSha256){
  $input=[ordered]@{
    LocalAppData=(Join-Path $ProfileRoot 'local')
    AppData=(Join-Path $ProfileRoot 'roaming')
    Desktop=(Join-Path $ProfileRoot 'desktop')
    ProgramFiles=(Join-Path $ProfileRoot 'program-files')
    CommonAppData=(Join-Path $ProfileRoot 'program-data')
    Operation='validate'
    ManifestPath=$ManifestPath
    SafeReadAdmissionReceiptPath=$ReceiptPath
    SafeReadAdmissionReceiptSha256=$ReceiptSha256
    SafeReadPackagePinSha256=$PackagePinSha256
    BundleOnly=$true
    KillPoint='no-kill'
  }
  $encoded=[Convert]::ToBase64String([Text.UTF8Encoding]::new($false).GetBytes(($input|ConvertTo-Json -Compress)))
  & dotnet $CrashHarnessPath $encoded
  if($LASTEXITCODE -ne 0){throw "$Label failed OperatorDeploy C# bundle validation with exit $LASTEXITCODE."}
}

$buildScript=Join-Path $PSScriptRoot 'Invoke-SafeReadRealPackageFixture.ps1'
$admissionFixture=Join-Path $PSScriptRoot 'Test-SafeReadAdmissionRealPackageFixture.ps1'
$operatorManifestFixture=Join-Path $PSScriptRoot 'New-OperatorDeploySafeReadFixtureManifest.ps1'
if([string]::IsNullOrWhiteSpace($CrashHarnessPath)){
  $CrashHarnessPath=Join-Path $RepositoryRoot 'packages\operator-deploy\OperatorDeploy.Tests\CrashHarness\bin\Release\net8.0-windows\win-x64\OperatorDeploy.CrashHarness.dll'
}
$CrashHarnessPath=(Resolve-Path -LiteralPath $CrashHarnessPath).Path
$ps7Root=Join-Path $root 'ps7-build';$ps7ReceiptPath=Join-Path $root 'ps7-build.receipt.json'
[IO.Directory]::CreateDirectory($ps7Root)|Out-Null
Invoke-Edition 'PS7 package build' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps7Root,'-ReceiptPath',$ps7ReceiptPath)
$ps7Receipt=Get-Content -LiteralPath $ps7ReceiptPath -Raw|ConvertFrom-Json
$ps7ReleaseVersion='operator-cross-ps7-v2';$ps7ProfileRoot=Join-Path $root ('ps7 CSharp '+[char]0x00DC+' profile');$ps7ManifestRoot=Join-Path $ps7ProfileRoot "local\RevitOperator\releases\$ps7ReleaseVersion"
[IO.Directory]::CreateDirectory((Split-Path -Parent $ps7ManifestRoot))|Out-Null
$ps7OperatorManifest=Join-Path $ps7Root "$ps7ReleaseVersion.manifest.json"
& $operatorManifestFixture -RepositoryRoot $RepositoryRoot -BundleRoot ([string]$ps7Receipt.bundleRoot) -ManifestPath $ps7OperatorManifest -ReleaseVersion $ps7ReleaseVersion|Out-Host
$ps7AdmissionBy5=Join-Path $root 'ps7-package.admission-v2.ps5.json';$ps7AdmissionBy7=Join-Path $root 'ps7-package.admission-v2.ps7.json'
Invoke-Edition 'PS5 receipt-v2 preparation for PS7 package' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy5,'-OperatorDeployManifestPath',$ps7OperatorManifest)
Invoke-Edition 'PS7 receipt-v2 preparation for PS7 package' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy7,'-OperatorDeployManifestPath',$ps7OperatorManifest)
$ps7AdmissionHash5=(Get-FileHash -LiteralPath $ps7AdmissionBy5 -Algorithm SHA256).Hash;$ps7AdmissionHash7=(Get-FileHash -LiteralPath $ps7AdmissionBy7 -Algorithm SHA256).Hash
if($ps7AdmissionHash5 -cne $ps7AdmissionHash7){throw 'PS5 and PS7 produced different canonical admission receipts for the PS7 package.'}
Assert-IdenticalReceiptBytes $ps7AdmissionBy5 $ps7AdmissionBy7 'PS7-built package'
Assert-ReceiptV2 $ps7AdmissionBy5 $ps7ManifestRoot;Assert-ReceiptV2 $ps7AdmissionBy7 $ps7ManifestRoot
Invoke-Edition 'PS5 verification of PS7 receipt-v2 from PS7' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy7,'-OperatorDeployManifestPath',$ps7OperatorManifest)
Invoke-Edition 'PS7 verification of PS7 receipt-v2 from PS5' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-BundleRoot',[string]$ps7Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps7Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps7ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps7AdmissionBy5,'-OperatorDeployManifestPath',$ps7OperatorManifest)
Invoke-CSharpBundleValidation 'PS5 receipt-v2 for PS7 package' $ps7ProfileRoot $ps7OperatorManifest $ps7AdmissionBy5 ('sha256:'+$ps7AdmissionHash5.ToLowerInvariant()) ([string]$ps7Receipt.attestationPinSha256)
Invoke-CSharpBundleValidation 'PS7 receipt-v2 for PS7 package' $ps7ProfileRoot $ps7OperatorManifest $ps7AdmissionBy7 ('sha256:'+$ps7AdmissionHash7.ToLowerInvariant()) ([string]$ps7Receipt.attestationPinSha256)

$ps5Root=Join-Path $root 'ps5-build';$ps5ReceiptPath=Join-Path $root 'ps5-build.receipt.json'
[IO.Directory]::CreateDirectory($ps5Root)|Out-Null
Invoke-Edition 'PS5 package build' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$buildScript,'-RepositoryRoot',$RepositoryRoot,'-OutputRoot',$ps5Root,'-ReceiptPath',$ps5ReceiptPath)
$ps5Receipt=Get-Content -LiteralPath $ps5ReceiptPath -Raw|ConvertFrom-Json
$ps5ReleaseVersion='operator-cross-ps5-v2';$ps5ProfileRoot=Join-Path $root ('ps5 CSharp '+[char]0x00DC+' profile');$ps5ManifestRoot=Join-Path $ps5ProfileRoot "local\RevitOperator\releases\$ps5ReleaseVersion"
[IO.Directory]::CreateDirectory((Split-Path -Parent $ps5ManifestRoot))|Out-Null
$ps5OperatorManifest=Join-Path $ps5Root "$ps5ReleaseVersion.manifest.json"
& $operatorManifestFixture -RepositoryRoot $RepositoryRoot -BundleRoot ([string]$ps5Receipt.bundleRoot) -ManifestPath $ps5OperatorManifest -ReleaseVersion $ps5ReleaseVersion|Out-Host
$ps5AdmissionBy5=Join-Path $root 'ps5-package.admission-v2.ps5.json';$ps5AdmissionBy7=Join-Path $root 'ps5-package.admission-v2.ps7.json'
Invoke-Edition 'PS5 receipt-v2 preparation for PS5 package' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy5,'-OperatorDeployManifestPath',$ps5OperatorManifest)
Invoke-Edition 'PS7 receipt-v2 preparation for PS5 package' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-Prepare','-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy7,'-OperatorDeployManifestPath',$ps5OperatorManifest)
$ps5AdmissionHash5=(Get-FileHash -LiteralPath $ps5AdmissionBy5 -Algorithm SHA256).Hash;$ps5AdmissionHash7=(Get-FileHash -LiteralPath $ps5AdmissionBy7 -Algorithm SHA256).Hash
if($ps5AdmissionHash5 -cne $ps5AdmissionHash7){throw 'PS5 and PS7 produced different canonical admission receipts for the PS5 package.'}
Assert-IdenticalReceiptBytes $ps5AdmissionBy5 $ps5AdmissionBy7 'PS5-built package'
Assert-ReceiptV2 $ps5AdmissionBy5 $ps5ManifestRoot;Assert-ReceiptV2 $ps5AdmissionBy7 $ps5ManifestRoot
Invoke-Edition 'PS7 verification of PS5 receipt-v2 from PS5' $pwsh @('-NoLogo','-NoProfile','-NonInteractive','-File',$admissionFixture,'-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy5,'-OperatorDeployManifestPath',$ps5OperatorManifest)
Invoke-Edition 'PS5 verification of PS5 receipt-v2 from PS7' $powershell @('-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$admissionFixture,'-BundleRoot',[string]$ps5Receipt.bundleRoot,'-AttestationPinSha256',[string]$ps5Receipt.attestationPinSha256,'-ManifestAssemblyRoot',$ps5ManifestRoot,'-CoordinationRoot',$root,'-ReceiptPath',$ps5AdmissionBy7,'-OperatorDeployManifestPath',$ps5OperatorManifest)
Invoke-CSharpBundleValidation 'PS5 receipt-v2 for PS5 package' $ps5ProfileRoot $ps5OperatorManifest $ps5AdmissionBy5 ('sha256:'+$ps5AdmissionHash5.ToLowerInvariant()) ([string]$ps5Receipt.attestationPinSha256)
Invoke-CSharpBundleValidation 'PS7 receipt-v2 for PS5 package' $ps5ProfileRoot $ps5OperatorManifest $ps5AdmissionBy7 ('sha256:'+$ps5AdmissionHash7.ToLowerInvariant()) ([string]$ps5Receipt.attestationPinSha256)

[pscustomobject]@{ps7Build=$ps7Receipt;ps5Build=$ps5Receipt;receiptSchema='revit-operator.safe-read-admission-receipt.v2';ps7PackageAdmissionSha256=('sha256:'+$ps7AdmissionHash7.ToLowerInvariant());ps5PackageAdmissionSha256=('sha256:'+$ps5AdmissionHash7.ToLowerInvariant());crossEditionVerified=$true;csharpLayoutVerified=$true}
