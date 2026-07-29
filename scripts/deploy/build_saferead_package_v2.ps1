[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InputManifestPath,
  [Parameter(Mandatory)][string]$OutputRoot,
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$SignToolPath,
  [string]$SigningThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [scriptblock]$BuildInvoker,
  [scriptblock]$SignFileAction,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

function Resolve-BuildPath([string]$Path,[string]$Base) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  [IO.Path]::GetFullPath((Join-Path $Base $Path))
}

$input = ConvertTo-SafeReadObject (Resolve-Path -LiteralPath $InputManifestPath).Path
if ($input.schemaVersion -cne 'revit-operator.safe-read-package-build-input.v2') { throw 'Input manifest must use revit-operator.safe-read-package-build-input.v2.' }
Assert-SafeReadReleaseId ([string]$input.releaseId)
$allowed = @($input.allowedSignerThumbprints); if ($allowed.Count -eq 0) { throw 'Input requires an exact signer allowlist.' }
if (-not $SignFileAction -and ([string]::IsNullOrWhiteSpace($SignToolPath) -or [string]::IsNullOrWhiteSpace($SigningThumbprint))) { throw 'Provide signtool and thumbprint, or an injected SignFileAction.' }
if ($SignToolPath -and -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool.exe not found: $SignToolPath" }

$outputParent = (Resolve-Path -LiteralPath $OutputRoot).Path
$bundleRoot = Join-Path $outputParent ("SafeReadPackage-{0}" -f $input.releaseId)
if (Test-Path -LiteralPath $bundleRoot) { throw "Refusing to overwrite existing SafeRead package: $bundleRoot" }
$stage = Join-Path $outputParent (".SafeReadPackage-{0}.{1}.staging" -f $input.releaseId,[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $templateSource = if ($input.addinTemplatePath) { Resolve-BuildPath ([string]$input.addinTemplatePath) $RepositoryRoot } else { Join-Path $RepositoryRoot 'apps\revit-safe-read-host\addin\RevitOperator.SafeReadHost.addin.template' }
  [void](Assert-SafeReadManifestXml -Path $templateSource -ExpectedAssembly '{{ASSEMBLY_PATH}}')
  $release = [ordered]@{ schemaVersion='revit-operator.safe-read-package-release.v2'; releaseId=[string]$input.releaseId; allowedSignerThumbprints=@($allowed); targets=@() }
  $tuples = @(); $seen=@{}
  foreach ($sourceTarget in @($input.targets)) {
    $year=[string]$sourceTarget.revitYear; if($seen.ContainsKey($year)){throw "Input repeats Revit year $year."};$seen[$year]=$true
    $expected=Get-SafeReadExpectedTarget $year
    if ($sourceTarget.framework -cne $expected.Framework -or $sourceTarget.platform -cne 'x64') { throw "Input target $year has invalid framework/platform." }
    $apiPath = Resolve-BuildPath ([string]$sourceTarget.revitApiPath) $RepositoryRoot
    if ((Get-Item -LiteralPath $apiPath).PSIsContainer) { $apiPath=Join-Path $apiPath 'RevitAPI.dll' }
    $apiFacts=Get-SafeReadRevitApiFacts $apiPath
    if(([version]$apiFacts.AssemblyVersion).Major -ne $expected.RevitApiMajor){throw "Input target $year points at a cross-year RevitAPI.dll."}
    $targetRoot=Join-Path $stage "targets\$year"; $payloadRoot=Join-Path $targetRoot 'payload'; $manifestRoot=Join-Path $targetRoot 'manifest'
    New-Item -ItemType Directory -Force -Path $payloadRoot,$manifestRoot | Out-Null
    $payloadReceipts=@()
    foreach ($item in @($sourceTarget.requiredPayload)) {
      $fileName=[string]$item.fileName; Assert-SafeReadRelativePath $fileName
      if($fileName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.dll$'){throw "Invalid required payload fileName: $fileName"}
      $projectPath=$null
      if($item.projectPath){$projectPath=Resolve-BuildPath ([string]$item.projectPath) $RepositoryRoot}
      elseif($item.role -ceq 'host'){$projectPath=Join-Path $RepositoryRoot 'apps\revit-safe-read-host\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj'}
      if($projectPath){
        $apiDirectory=Split-Path -Parent $apiPath
        if($BuildInvoker){& $BuildInvoker $projectPath $year $expected.Framework 'x64' $apiDirectory}
        else { & dotnet build $projectPath -c Release -f $expected.Framework -p:RevitYear=$year -p:Platform=x64 -p:RevitApiPath=$apiDirectory --nologo; if($LASTEXITCODE -ne 0){throw "SafeRead project build failed for $year/$fileName."} }
      }
      $sourceDll = if($item.sourceDll){Resolve-BuildPath ([string]$item.sourceDll) $RepositoryRoot}
        elseif($item.outputPath){Resolve-BuildPath ([string]$item.outputPath) $RepositoryRoot}
        elseif($projectPath){Join-Path (Split-Path -Parent $projectPath) "bin\Revit$year\Release\$($expected.Framework)\$fileName"}
        else{throw "Required payload $fileName needs projectPath/outputPath or sourceDll."}
      $destination=Join-Path $payloadRoot $fileName; Copy-Item -LiteralPath $sourceDll -Destination $destination
      if($SignFileAction){& $SignFileAction $destination $year $item}else{& $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $destination;if($LASTEXITCODE -ne 0){throw "signtool failed for $year/$fileName."}}
      $facts=if($AssemblyInspector){& $AssemblyInspector $destination $year $item}else{Get-SafeReadAssemblyFacts $destination}
      if($facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64'){throw "Built payload $year/$fileName has wrong framework/platform."}
      if([bool]$item.revitApiBound -and ([string]::IsNullOrWhiteSpace($facts.RevitApiReferenceVersion) -or ([version]$facts.RevitApiReferenceVersion).Major -ne $expected.RevitApiMajor)){throw "Built payload $year/$fileName references the wrong Revit API."}
      $payloadReceipts += [ordered]@{path="payload/$fileName";role=[string]$item.role;revitApiBound=[bool]$item.revitApiBound;sha256=Get-SafeReadSha256 $destination;sizeBytes=(Get-Item -LiteralPath $destination).Length;assembly=[ordered]@{name=[string]$facts.Name;targetFramework=[string]$facts.TargetFramework;platform=[string]$facts.Platform;mvid=[string]$facts.Mvid;revitApiReferenceVersion=if($facts.RevitApiReferenceVersion){[string]$facts.RevitApiReferenceVersion}else{$null}}}
    }
    $hostPayload=@($payloadReceipts|Where-Object role -ceq 'host');if($hostPayload.Count -ne 1 -or $hostPayload[0].path -cne 'payload/RevitOperator.SafeReadHost.dll'){throw "Target $year needs exactly the real SafeRead host DLL."}
    $templateDestination=Join-Path $manifestRoot 'RevitOperator.SafeReadHost.addin.template';Copy-Item -LiteralPath $templateSource -Destination $templateDestination
    $release.targets += [ordered]@{revitYear=$year;framework=$expected.Framework;platform='x64';revitApi=[ordered]@{contentSha256=$apiFacts.ContentSha256;mvid=$apiFacts.Mvid;assemblyVersion=$apiFacts.AssemblyVersion};requiredPayload=$payloadReceipts;manifest=[ordered]@{path='manifest/RevitOperator.SafeReadHost.addin.template';sha256=Get-SafeReadSha256 $templateDestination;sizeBytes=(Get-Item -LiteralPath $templateDestination).Length}}
    $tuples += [ordered]@{revit_version=$year;runtime_tuple=[ordered]@{host_content_sha256=$hostPayload[0].sha256;host_mvid=$hostPayload[0].assembly.mvid;revit_api_content_sha256=$apiFacts.ContentSha256;revit_api_mvid=$apiFacts.Mvid;revit_version=$year}}
  }
  if(($seen.Keys|Sort-Object)-join',' -ne '2023,2024,2025'){throw 'Input must contain exactly 2023, 2024, and 2025.'}
  $releasePath=Join-Path $stage 'release-manifest.json';[IO.File]::WriteAllText($releasePath,(ConvertTo-SafeReadCanonicalJson $release),[Text.UTF8Encoding]::new($false))
  $attestation=[ordered]@{schemaVersion='revit-operator.safe-read-package-attestation.v2';releaseId=[string]$input.releaseId;releaseManifestSha256=Get-SafeReadSha256 $releasePath;staticRuntimeTuples=$tuples}
  $attestationPath=Join-Path $stage 'deployment-attestation.json';[IO.File]::WriteAllText($attestationPath,(ConvertTo-SafeReadCanonicalJson $attestation),[Text.UTF8Encoding]::new($false))
  $pin=Get-SafeReadSha256 $attestationPath
  [void](Assert-SafeReadBundle -BundleRoot $stage -AttestationPinSha256 $pin -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector)
  Move-Item -LiteralPath $stage -Destination $bundleRoot
  Write-Host "SafeRead package created: $bundleRoot";Write-Host "External deployment attestation pin: $pin"
} catch { if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force};throw }
