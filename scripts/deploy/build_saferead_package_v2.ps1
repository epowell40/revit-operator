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
  [scriptblock]$AssemblyInspector,
  [string]$ProofToolPath,
  [scriptblock]$ManagedCodeInspector
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

function Resolve-BuildPath([string]$Path,[string]$Base) {
  if ([IO.Path]::IsPathRooted($Path)) { return [IO.Path]::GetFullPath($Path) }
  [IO.Path]::GetFullPath((Join-Path $Base $Path))
}

$input = ConvertTo-SafeReadObject (Resolve-Path -LiteralPath $InputManifestPath).Path
if ($input.schemaVersion -cne 'revit-operator.safe-read-package-build-input.v2') { throw 'Input manifest must use revit-operator.safe-read-package-build-input.v2.' }
if(-not $input.runtimeAttestation){throw 'Input requires runtimeAttestation values.'}
Assert-SafeReadExactProperties $input.runtimeAttestation @('state','issued_at_utc','expires_at_utc','route_id','route_contract_sha256','policy_sha256','executor_id') 'SafeRead build runtime attestation'
if($input.runtimeAttestation.state -cnotin @('active','revoked') -or $input.runtimeAttestation.route_id -cne 'safe_read.sheet_count.v1' -or $input.runtimeAttestation.route_contract_sha256 -cne 'sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874' -or $input.runtimeAttestation.policy_sha256 -cne 'sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67' -or $input.runtimeAttestation.executor_id -cne 'revit-operator.safe-read-host.v1'){throw 'Input runtime attestation is not the exact backend contract.'}
$issued=[datetimeoffset]::ParseExact([string]$input.runtimeAttestation.issued_at_utc,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal);$expires=[datetimeoffset]::ParseExact([string]$input.runtimeAttestation.expires_at_utc,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal);if($expires -le $issued){throw 'Input runtime attestation validity window is invalid.'}
Assert-SafeReadReleaseId ([string]$input.releaseId)
$allowed = @($input.allowedSignerThumbprints); if ($allowed.Count -eq 0) { throw 'Input requires an exact signer allowlist.' }
if (-not $SignFileAction -and ([string]::IsNullOrWhiteSpace($SignToolPath) -or [string]::IsNullOrWhiteSpace($SigningThumbprint))) { throw 'Provide signtool and thumbprint, or an injected SignFileAction.' }
if ($SignToolPath -and -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) { throw "signtool.exe not found: $SignToolPath" }

$outputParent = (Resolve-Path -LiteralPath $OutputRoot).Path
$resolvedProofToolPath = $null
if (-not $ManagedCodeInspector) {
  if ([string]::IsNullOrWhiteSpace($ProofToolPath)) { throw 'Provide ProofToolPath, or an injected ManagedCodeInspector for tests.' }
  $resolvedProofToolPath = (Resolve-Path -LiteralPath $ProofToolPath).Path
  if (-not (Test-Path -LiteralPath $resolvedProofToolPath -PathType Leaf)) { throw "SafeRead proof tool not found: $resolvedProofToolPath" }
}

function Get-PackagedManagedCodeSha256([string]$ArtifactPath,[string]$Year) {
  if ($ManagedCodeInspector) { return [string](& $ManagedCodeInspector $ArtifactPath $Year) }
  $fingerprintRoot = Join-Path $outputParent ('.SafeReadFingerprint-{0}-{1}-{2}' -f $input.releaseId,$Year,[guid]::NewGuid().ToString('N'))
  $toolOutput = @(& dotnet $resolvedProofToolPath fingerprint --artifact $ArtifactPath --output-dir $fingerprintRoot 2>&1)
  if ($LASTEXITCODE -ne 0) {
    throw "SafeRead proof fingerprint failed for Revit $Year with exit $LASTEXITCODE`: $([string]::Join(' | ',@($toolOutput)))"
  }
  $fingerprintPath = Join-Path $fingerprintRoot 'artifact.fingerprint.json'
  $fingerprint = ConvertTo-SafeReadObject $fingerprintPath
  Assert-SafeReadExactProperties $fingerprint @('schemaVersion','status','sha256','length','managedCodeSha256','assemblyIdentity','issues','metadata','il') "SafeRead fingerprint $Year"
  Assert-SafeReadExactProperties $fingerprint.metadata @('count','sha256','items') "SafeRead fingerprint metadata $Year"
  Assert-SafeReadExactProperties $fingerprint.il @('count','sha256','items') "SafeRead fingerprint IL $Year"
  $rawSha256 = (Get-SafeReadSha256 $ArtifactPath).Substring(7)
  if ([int]$fingerprint.schemaVersion -ne 1 -or $fingerprint.status -cne 'verified' -or @($fingerprint.issues).Count -ne 0 -or
      $fingerprint.sha256 -cne $rawSha256 -or [int64]$fingerprint.length -ne (Get-Item -LiteralPath $ArtifactPath).Length -or
      $fingerprint.managedCodeSha256 -cnotmatch '^[0-9a-f]{64}$' -or $fingerprint.metadata.sha256 -cnotmatch '^[0-9a-f]{64}$' -or
      $fingerprint.il.sha256 -cnotmatch '^[0-9a-f]{64}$') {
    throw "SafeRead proof fingerprint receipt is invalid for Revit $Year."
  }
  [string]$fingerprint.managedCodeSha256
}

$bundleRoot = Join-Path $outputParent ("SafeReadPackage-{0}" -f $input.releaseId)
if (Test-Path -LiteralPath $bundleRoot) { throw "Refusing to overwrite existing SafeRead package: $bundleRoot" }
$stage = Join-Path $outputParent (".SafeReadPackage-{0}.{1}.staging" -f $input.releaseId,[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  $templateSource = if ($input.addinTemplatePath) { Resolve-BuildPath ([string]$input.addinTemplatePath) $RepositoryRoot } else { Join-Path $RepositoryRoot 'apps\revit-safe-read-host\addin\RevitOperator.SafeReadHost.addin.template' }
  [void](Assert-SafeReadManifestXml -Path $templateSource -ExpectedAssembly '{{ASSEMBLY_PATH}}')
  $release = [ordered]@{ schemaVersion='revit-operator.safe-read-package-release.v2'; releaseId=[string]$input.releaseId; allowedSignerThumbprints=@($allowed); targets=@() }
  $packagePins = @(); $seen=@{}
  foreach ($sourceTarget in @($input.targets)) {
    $year=[string]$sourceTarget.revitYear; if($seen.ContainsKey($year)){throw "Input repeats Revit year $year."};$seen[$year]=$true
    $expected=Get-SafeReadExpectedTarget $year
    if ($sourceTarget.framework -cne $expected.Framework -or $sourceTarget.platform -cne 'x64') { throw "Input target $year has invalid framework/platform." }
    $apiPath = Resolve-BuildPath ([string]$sourceTarget.revitApiPath) $RepositoryRoot
    if ((Get-Item -LiteralPath $apiPath).PSIsContainer) { $apiPath=Join-Path $apiPath 'RevitAPI.dll' }
    $apiFacts=Get-SafeReadRevitApiFacts $apiPath
    if(([version]$apiFacts.AssemblyVersion).Major -ne $expected.RevitApiMajor){throw "Input target $year points at a cross-year RevitAPI.dll."}
    $targetRoot=Join-Path $stage "targets\$year"; $payloadRoot=Join-Path $targetRoot 'payload'; $manifestRoot=Join-Path $targetRoot 'manifest';$proofRoot=Join-Path $targetRoot 'proof'
    New-Item -ItemType Directory -Force -Path $payloadRoot,$manifestRoot,$proofRoot | Out-Null
    $declared=@($sourceTarget.requiredPayload);$hosts=@($declared|Where-Object role -ceq 'host');$executors=@($declared|Where-Object role -ceq 'certified_executor')
    if($hosts.Count -ne 1 -or $hosts[0].fileName -cne 'RevitOperator.SafeReadHost.dll' -or -not [bool]$hosts[0].revitApiBound){throw "Input target $year requires exactly one host declaration."}
    if($executors.Count -ne 1 -or $executors[0].fileName -cne 'RevitOperator.SafeReadCertifiedExecution.dll' -or -not [bool]$executors[0].revitApiBound){throw "Input target $year requires exactly one certified_executor declaration."}
    if($declared.Count -ne 2){throw "Input target $year may declare only host and certified_executor; runtime dependencies are derived deterministically."}
    if($executors[0].projectPath -or $executors[0].sourceDll -or $executors[0].outputPath){throw "Input target $year may not supply or rebuild the certified executor; use proofReceiptPath."}
    $proof=Get-SafeReadProofArtifact (Resolve-BuildPath ([string]$sourceTarget.proofReceiptPath) $RepositoryRoot) $year
    Copy-Item -LiteralPath $proof.ReceiptPath -Destination (Join-Path $proofRoot 'proof.receipt.json')
    $payloadReceipts=@()
    $hostItem=$hosts[0];$projectPath=if($hostItem.projectPath){Resolve-BuildPath ([string]$hostItem.projectPath) $RepositoryRoot}else{Join-Path $RepositoryRoot 'apps\revit-safe-read-host\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj'}
    if(-not $hostItem.sourceDll){$apiDirectory=Split-Path -Parent $apiPath;if($BuildInvoker){& $BuildInvoker $projectPath $year $expected.Framework 'x64' $apiDirectory}else{& dotnet build $projectPath -c Release -f $expected.Framework -p:RevitYear=$year -p:Platform=x64 -p:RevitApiPath=$apiDirectory --nologo;if($LASTEXITCODE -ne 0){throw "SafeRead host build failed for $year."}}}
    $hostSource=if($hostItem.sourceDll){Resolve-BuildPath ([string]$hostItem.sourceDll) $RepositoryRoot}elseif($hostItem.outputPath){Resolve-BuildPath ([string]$hostItem.outputPath) $RepositoryRoot}else{Join-Path (Split-Path -Parent $projectPath) "bin\Revit$year\Release\$($expected.Framework)\RevitOperator.SafeReadHost.dll"}
    $dependencySourceRoot=Split-Path -Parent $hostSource

    function Add-Payload([string]$Source,[string]$FileName,[string]$Role,[bool]$RevitBound,$Provenance,$Declaration){
      $destination=Join-Path $payloadRoot $FileName;Copy-Item -LiteralPath $Source -Destination $destination
      if($SignFileAction){& $SignFileAction $destination $year $Declaration}else{& $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $destination;if($LASTEXITCODE -ne 0){throw "signtool failed for $year/$FileName."}}
      $facts=if($AssemblyInspector){& $AssemblyInspector $destination $year $Declaration}else{Get-SafeReadAssemblyFacts $destination}
      if($FileName -cne "$($facts.Name).dll"){throw "Payload $year/$FileName does not match its exact assembly identity."}
      if($Role -ceq 'host' -and $facts.Name -cne 'RevitOperator.SafeReadHost'){throw "Payload $year/$FileName is not the SafeRead host assembly."};if($Role -ceq 'certified_executor' -and $facts.Name -cne 'RevitOperator.SafeReadCertifiedExecution'){throw "Payload $year/$FileName is not the certified executor assembly."}
      if($Role -cin @('host','certified_executor')){if($facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64'){throw "Payload $year/$FileName has wrong framework/platform."}}elseif(-not(Test-SafeReadDependencyAssemblyCompatibility ([string]$facts.TargetFramework) ([string]$facts.Platform) $expected.Framework)){throw "Runtime dependency $year/$FileName is not framework/platform compatible."}
      if($RevitBound -and ([string]::IsNullOrWhiteSpace($facts.RevitApiReferenceVersion) -or ([version]$facts.RevitApiReferenceVersion).Major -ne $expected.RevitApiMajor)){throw "Payload $year/$FileName references the wrong Revit API."}
      $next=[ordered]@{path="payload/$FileName";role=$Role;revitApiBound=$RevitBound;sha256=Get-SafeReadSha256 $destination;sizeBytes=(Get-Item -LiteralPath $destination).Length;assembly=[ordered]@{name=[string]$facts.Name;targetFramework=[string]$facts.TargetFramework;platform=[string]$facts.Platform;mvid=[string]$facts.Mvid;revitApiReferenceVersion=if($facts.RevitApiReferenceVersion){[string]$facts.RevitApiReferenceVersion}else{$null};references=@($facts.AssemblyReferences|Sort-Object -Unique)};provenance=$Provenance}
      Set-Variable -Name payloadReceipts -Scope 1 -Value (@($payloadReceipts)+@($next))
    }
    Add-Payload $hostSource 'RevitOperator.SafeReadHost.dll' 'host' $true $null $hostItem
    $executorUnsigned='sha256:'+([string]$proof.Artifact.sha256)
    $executorProvenance=[ordered]@{proofReceiptSha256=$proof.ReceiptSha256;unsignedSha256=$executorUnsigned;managedCodeSha256=[string]$proof.Artifact.managedCodeSha256}
    Add-Payload $proof.AssemblyPath 'RevitOperator.SafeReadCertifiedExecution.dll' 'certified_executor' $true $executorProvenance $executors[0]
    $signedExecutor=Join-Path $payloadRoot 'RevitOperator.SafeReadCertifiedExecution.dll';$signedManaged=Get-PackagedManagedCodeSha256 $signedExecutor $year
    if($signedManaged -cne [string]$proof.Artifact.managedCodeSha256){throw "Signed certified executor managed-code fingerprint changed for Revit $year."}
    $processed=@{};do{$added=$false;foreach($entry in @($payloadReceipts)){foreach($reference in @($entry.assembly.references)){if(Test-SafeReadRuntimeProvidedAssembly $reference $expected.Framework){continue};if(@($payloadReceipts|Where-Object{$_.assembly.name -ceq $reference}).Count){continue};$dependencyPath=Join-Path $dependencySourceRoot "$reference.dll";if(-not(Test-Path -LiteralPath $dependencyPath -PathType Leaf)){throw "SafeRead target $year is missing runtime dependency $reference required by $($entry.assembly.name)."};if($processed.ContainsKey($reference)){continue};$processed[$reference]=$true;Add-Payload $dependencyPath "$reference.dll" 'runtime_dependency' $false $null ([pscustomobject]@{role='runtime_dependency'});$added=$true}}}while($added)
    Assert-SafeReadDependencyClosure $payloadReceipts $expected.Framework $year
    $executorPayload=@($payloadReceipts|Where-Object role -ceq 'certified_executor')[0]
    $templateDestination=Join-Path $manifestRoot 'RevitOperator.SafeReadHost.addin.template';Copy-Item -LiteralPath $templateSource -Destination $templateDestination
    $proofDestination=Join-Path $proofRoot 'proof.receipt.json'
    $runtime=[ordered]@{schema='revit-operator.safe-read-runtime-attestation.v1';state=[string]$input.runtimeAttestation.state;issued_at_utc=[string]$input.runtimeAttestation.issued_at_utc;expires_at_utc=[string]$input.runtimeAttestation.expires_at_utc;route_id='safe_read.sheet_count.v1';route_contract_sha256='sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874';policy_sha256='sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67';proof_sha256=Get-SafeReadSha256 $proofDestination;executor_id='revit-operator.safe-read-host.v1';runtime_tuple=[ordered]@{host_content_sha256=$executorPayload.sha256;host_mvid=$executorPayload.assembly.mvid;revit_api_content_sha256=$apiFacts.ContentSha256;revit_api_mvid=$apiFacts.Mvid;revit_version=$year}}
    $runtimePath=Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.json';[IO.File]::WriteAllText($runtimePath,(ConvertTo-SafeReadCanonicalJson $runtime),[Text.UTF8Encoding]::new($false));$runtimePin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.sha256'),$runtimePin+"`n",[Text.UTF8Encoding]::new($false))
    $release.targets += [ordered]@{revitYear=$year;framework=$expected.Framework;platform='x64';revitApi=[ordered]@{contentSha256=$apiFacts.ContentSha256;mvid=$apiFacts.Mvid;assemblyVersion=$apiFacts.AssemblyVersion};requiredPayload=$payloadReceipts;proof=[ordered]@{path='proof/proof.receipt.json';sha256=Get-SafeReadSha256 $proofDestination;sizeBytes=(Get-Item -LiteralPath $proofDestination).Length;artifactUnsignedSha256=[string]$proof.Artifact.sha256;managedCodeSha256=[string]$proof.Artifact.managedCodeSha256};runtimeAttestation=[ordered]@{path='payload/safe_read_runtime_attestation.v1.json';sha256=$runtimePin;sizeBytes=(Get-Item -LiteralPath $runtimePath).Length};manifest=[ordered]@{path='manifest/RevitOperator.SafeReadHost.addin.template';sha256=Get-SafeReadSha256 $templateDestination;sizeBytes=(Get-Item -LiteralPath $templateDestination).Length}}
    $packagePins += [ordered]@{revitYear=$year;runtimeAttestationSha256=$runtimePin}
  }
  if(($seen.Keys|Sort-Object)-join',' -ne '2023,2024,2025'){throw 'Input must contain exactly 2023, 2024, and 2025.'}
  $releasePath=Join-Path $stage 'release-manifest.json';[IO.File]::WriteAllText($releasePath,(ConvertTo-SafeReadCanonicalJson $release),[Text.UTF8Encoding]::new($false))
  $pins=[ordered]@{schemaVersion='revit-operator.safe-read-package-pins.v2';releaseId=[string]$input.releaseId;releaseManifestSha256=Get-SafeReadSha256 $releasePath;targets=$packagePins}
  $pinsPath=Join-Path $stage 'package-pins.json';[IO.File]::WriteAllText($pinsPath,(ConvertTo-SafeReadCanonicalJson $pins),[Text.UTF8Encoding]::new($false))
  $pin=Get-SafeReadSha256 $pinsPath
  [void](Assert-SafeReadBundle -BundleRoot $stage -AttestationPinSha256 $pin -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector)
  Move-Item -LiteralPath $stage -Destination $bundleRoot
  Write-Host "SafeRead package created: $bundleRoot";Write-Host "External package pins SHA-256: $pin";foreach($entry in $packagePins){Write-Host "Revit $($entry.revitYear) runtime attestation pin: $($entry.runtimeAttestationSha256)"}
} catch { if(Test-Path -LiteralPath $stage){Remove-Item -LiteralPath $stage -Recurse -Force};throw }
