[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$InputManifestPath,
  [Parameter(Mandatory)][string]$OutputRoot,
  [string]$RepositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [string]$SignToolPath,
  [string]$SigningThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [scriptblock]$SignFileAction,
  [scriptblock]$SignatureVerifier,
  [scriptblock]$AssemblyInspector
)

$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
Import-Module (Join-Path $PSScriptRoot 'SafeReadPackageV2.psm1') -Force

function Resolve-BuildPath([string]$Path,[string]$Base){
  if([IO.Path]::IsPathRooted($Path)){return [IO.Path]::GetFullPath($Path)}
  [IO.Path]::GetFullPath((Join-Path $Base $Path))
}

function Invoke-CheckedCommand([string]$Label,[scriptblock]$Action){
  $output=@(& $Action 2>&1)
  if($LASTEXITCODE -ne 0){throw "$Label failed with exit $LASTEXITCODE`: $([string]::Join(' | ',@($output)))"}
  $output
}

function Assert-IdentityEqual($Expected,$Actual,[string]$Location){
  $expectedKey=Get-SafeReadAssemblyIdentityKey $Expected;$actualKey=Get-SafeReadAssemblyIdentityKey $Actual
  if($expectedKey -cne $actualKey){throw "$Location assembly identity mismatch. Expected $expectedKey; actual $actualKey."}
}

function Get-Facts([string]$Path,[string]$Year,$Declaration){
  if($AssemblyInspector){& $AssemblyInspector $Path $Year $Declaration}else{Get-SafeReadAssemblyFacts $Path}
}

function Get-ReferenceByName($Facts,[string]$Name){
  @($Facts.AssemblyReferences|Where-Object{$_ -isnot [string] -and $_.name -ceq $Name})
}

$repository=Resolve-SafeReadCanonicalPath ([IO.Path]::GetFullPath($RepositoryRoot))
$inputPath=Resolve-SafeReadCanonicalPath $InputManifestPath
$input=ConvertTo-SafeReadObject $inputPath
Assert-SafeReadExactProperties $input @('schemaVersion','releaseId','allowedSignerThumbprints','runtimeAttestation') 'SafeRead package build input'
if($input.schemaVersion -cne 'revit-operator.safe-read-package-build-input.v3'){throw 'Input manifest must use revit-operator.safe-read-package-build-input.v3.'}
Assert-SafeReadReleaseId ([string]$input.releaseId)
$allowed=@($input.allowedSignerThumbprints)
if($allowed.Count -eq 0 -or @($allowed|Where-Object{$_ -cnotmatch '^[A-Fa-f0-9]{40}$'}).Count){throw 'Input requires an exact non-empty SHA-1 signer thumbprint allowlist.'}
Assert-SafeReadExactProperties $input.runtimeAttestation @('state','issued_at_utc','expires_at_utc','route_id','route_contract_sha256','policy_sha256','executor_id') 'SafeRead build runtime attestation'
if($input.runtimeAttestation.state -cnotin @('active','revoked') -or $input.runtimeAttestation.route_id -cne 'safe_read.sheet_count.v1' -or $input.runtimeAttestation.route_contract_sha256 -cne 'sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874' -or $input.runtimeAttestation.policy_sha256 -cne 'sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67' -or $input.runtimeAttestation.executor_id -cne 'revit-operator.safe-read-host.v1'){throw 'Input runtime attestation is not the exact backend contract.'}
$issued=[datetimeoffset]::ParseExact([string]$input.runtimeAttestation.issued_at_utc,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
$expires=[datetimeoffset]::ParseExact([string]$input.runtimeAttestation.expires_at_utc,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal)
if($expires -le $issued){throw 'Input runtime attestation validity window is invalid.'}
if(-not $SignFileAction -and ([string]::IsNullOrWhiteSpace($SignToolPath) -or [string]::IsNullOrWhiteSpace($SigningThumbprint))){throw 'Provide signtool and thumbprint, or an injected SignFileAction.'}
if($SignToolPath){$SignToolPath=Resolve-SafeReadCanonicalPath $SignToolPath}

$outputParent=Resolve-SafeReadCanonicalPath $OutputRoot
$bundleRoot=Join-Path $outputParent "SafeReadPackage-$($input.releaseId)"
if(Test-Path -LiteralPath $bundleRoot){throw "Refusing to overwrite existing SafeRead package: $bundleRoot"}
$runRoot=Join-Path $outputParent ('.SafeReadPackageRun-{0}.{1}' -f $input.releaseId,[guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $runRoot|Out-Null
[void](Protect-SafeReadPathAcl $runRoot -Strict)
$stage=Join-Path $runRoot 'package';New-Item -ItemType Directory -Path $stage|Out-Null
[void](Protect-SafeReadPathAcl $stage -Strict)

# The package builder owns the proof run. No input field can supply a receipt,
# artifact, source root, compiler, policy, or reference path.
$trustedRepository=Join-Path $runRoot 'trusted-source'
New-Item -ItemType Directory -Path $trustedRepository|Out-Null
[void](Protect-SafeReadPathAcl $trustedRepository -Strict)
$git=(Get-Command git -ErrorAction Stop).Source
$sourcePaths=@('apps/revit-safe-read-proof','apps/revit-safe-read-host')
$dirty=@(Invoke-CheckedCommand 'SafeRead source status' {& $git -C $repository status --porcelain=v1 --untracked-files=all -- @sourcePaths})
if($dirty.Count){throw "SafeRead source paths must match their exact committed Git tree: $([string]::Join(' | ',@($dirty)))"}
$commit=@(Invoke-CheckedCommand 'SafeRead source commit resolution' {& $git -C $repository rev-parse --verify 'HEAD^{commit}'})[-1].ToString().Trim()
if($commit -cnotmatch '^[0-9a-f]{40}$'){throw 'SafeRead source commit identity is invalid.'}
$proofTree=@(Invoke-CheckedCommand 'SafeRead proof tree resolution' {& $git -C $repository rev-parse "$commit`:apps/revit-safe-read-proof"})[-1].ToString().Trim()
$hostTree=@(Invoke-CheckedCommand 'SafeRead host tree resolution' {& $git -C $repository rev-parse "$commit`:apps/revit-safe-read-host"})[-1].ToString().Trim()
if($proofTree -cnotmatch '^[0-9a-f]{40}$' -or $hostTree -cnotmatch '^[0-9a-f]{40}$'){throw 'SafeRead source tree identity is invalid.'}
$sourceArchive=Join-Path $runRoot 'trusted-source.zip'
[void](Invoke-CheckedCommand 'SafeRead committed source archive' {& $git -C $repository archive --format=zip --output=$sourceArchive $commit -- @sourcePaths})
[void](Protect-SafeReadPathAcl $sourceArchive -Strict)
Expand-Archive -LiteralPath $sourceArchive -DestinationPath $trustedRepository
[void](Protect-SafeReadTreeAcl $trustedRepository)
[void](Assert-SafeReadStrictTree $trustedRepository)
$sourceReceipt=[ordered]@{schemaVersion=1;commit=$commit;proofTree=$proofTree;hostTree=$hostTree;archiveSha256=Get-SafeReadSha256 $sourceArchive}
$sourceReceiptPath=Join-Path $runRoot 'source.snapshot.receipt.json';[IO.File]::WriteAllText($sourceReceiptPath,(ConvertTo-SafeReadCanonicalJson $sourceReceipt),[Text.UTF8Encoding]::new($false));[void](Protect-SafeReadPathAcl $sourceReceiptPath -Strict)
$proofRoot=Resolve-SafeReadCanonicalPath (Join-Path $trustedRepository 'apps\revit-safe-read-proof')
$bootstrap=Resolve-SafeReadCanonicalPath (Join-Path $proofRoot 'bootstrap.ps1')
$generator=Resolve-SafeReadCanonicalPath (Join-Path $proofRoot 'production\New-ProductionManifest.ps1')
$pwsh=(Get-Command pwsh -ErrorAction Stop).Source
$proofBootstrapRoot=Join-Path $runRoot 'proof-bootstrap'
[void](Invoke-CheckedCommand 'SafeRead proof bootstrap' {& $pwsh -NoLogo -NoProfile -NonInteractive -File $bootstrap -Check -OutputRoot $proofBootstrapRoot})
$proofTool=Resolve-SafeReadCanonicalPath (Join-Path $proofBootstrapRoot 'tool\RevitSafeReadProof.dll')
$proofManifest=Join-Path $runRoot 'production.manifest.json'
[void](Invoke-CheckedCommand 'SafeRead production manifest generation' {& $pwsh -NoLogo -NoProfile -NonInteractive -File $generator -OutputPath $proofManifest})
[void](Assert-SafeReadSecureTree $proofManifest)
$proofOutput=Join-Path $runRoot 'proof-output'
[void](Invoke-CheckedCommand 'SafeRead canonical proof check' {& dotnet $proofTool check --manifest $proofManifest --output-dir $proofOutput})
[void](Assert-SafeReadSecureTree $proofOutput)
$proofReceiptPath=Resolve-SafeReadCanonicalPath (Join-Path $proofOutput 'proof.receipt.json')
$proofReceiptSha=Get-SafeReadSha256 $proofReceiptPath

$templateSource=Resolve-SafeReadCanonicalPath (Join-Path $trustedRepository 'apps\revit-safe-read-host\addin\RevitOperator.SafeReadHost.addin.template')
[void](Assert-SafeReadManifestXml -Path $templateSource -ExpectedAssembly '{{ASSEMBLY_PATH}}')
$hostProject=Resolve-SafeReadCanonicalPath (Join-Path $trustedRepository 'apps\revit-safe-read-host\src\RevitOperator.SafeReadHost\RevitOperator.SafeReadHost.csproj')
[void](Assert-SafeReadStrictTree (Split-Path -Parent $hostProject))

$release=[ordered]@{schemaVersion='revit-operator.safe-read-package-release.v3';releaseId=[string]$input.releaseId;allowedSignerThumbprints=@($allowed|ForEach-Object{$_.ToUpperInvariant()});targets=@()}
$packagePins=@();$proofHashes=@()

foreach($year in '2023','2024','2025'){
  $expected=Get-SafeReadExpectedTarget $year
  $revitRoot=Resolve-SafeReadCanonicalPath "C:\Program Files\Autodesk\Revit $year"
  $apiPath=Resolve-SafeReadCanonicalPath (Join-Path $revitRoot 'RevitAPI.dll')
  $apiUiPath=Resolve-SafeReadCanonicalPath (Join-Path $revitRoot 'RevitAPIUI.dll')
  $apiFacts=Get-SafeReadRevitApiFacts $apiPath;$apiUiFacts=Get-SafeReadRevitApiFacts $apiUiPath
  if($apiFacts.Identity.name -cne 'RevitAPI' -or $apiUiFacts.Identity.name -cne 'RevitAPIUI' -or ([version]$apiFacts.AssemblyVersion).Major -ne $expected.RevitApiMajor -or ([version]$apiUiFacts.AssemblyVersion).Major -ne $expected.RevitApiMajor){throw "Installed Revit $year API identities are not the exact intended references."}

  $targetRoot=Join-Path $stage "targets\$year";$payloadRoot=Join-Path $targetRoot 'payload';$manifestRoot=Join-Path $targetRoot 'manifest';$targetProofRoot=Join-Path $targetRoot 'proof'
  New-Item -ItemType Directory -Path $payloadRoot,$manifestRoot,$targetProofRoot|Out-Null
  Copy-Item -LiteralPath $proofReceiptPath -Destination (Join-Path $targetProofRoot 'proof.receipt.json')
  $proof=Get-SafeReadProofArtifact $proofReceiptPath $year

  $yearBuild=Join-Path $runRoot "host-build-$year"
  $isolatedBin=Join-Path $yearBuild 'bin';$isolatedObj=Join-Path $yearBuild 'obj'
  New-Item -ItemType Directory -Path $isolatedBin|Out-Null
  # Build the transport host against the exact verifier-emitted executor identity;
  # the ordinary ProjectReference output is deliberately not built or consumed.
  Copy-Item -LiteralPath $proof.AssemblyPath -Destination (Join-Path $isolatedBin 'RevitOperator.SafeReadCertifiedExecution.dll')
  [void](Invoke-CheckedCommand "SafeRead host build for Revit $year" {& dotnet build $hostProject -c Release -f $expected.Framework -p:RevitYear=$year -p:Platform=x64 -p:RevitApiPath=$revitRoot -p:BuildProjectReferences=false -p:ProduceReferenceAssembly=false "-p:OutputPath=$isolatedBin\" "-p:IntermediateOutputPath=$isolatedObj\" --nologo})
  $hostCandidates=@(Get-ChildItem -LiteralPath $isolatedBin -File -Filter 'RevitOperator.SafeReadHost.dll'|Sort-Object FullName)
  if($hostCandidates.Count -ne 1){throw "Isolated host build produced $($hostCandidates.Count) candidate host assemblies for Revit $year."}
  $hostSource=$hostCandidates[0].FullName;$dependencySearchRoot=Split-Path -Parent $hostSource
  $payloadReceipts=@()

  function Add-Payload([string]$Source,[string]$FileName,[string]$Role,[bool]$RevitBound,$Provenance){
    $sourceCanonical=Resolve-SafeReadCanonicalPath $Source
    $destination=Join-Path $payloadRoot $FileName
    Copy-Item -LiteralPath $sourceCanonical -Destination $destination
    if($SignFileAction){& $SignFileAction $destination $year ([pscustomobject]@{role=$Role;fileName=$FileName})}
    else{& $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $destination;if($LASTEXITCODE -ne 0){throw "signtool failed for $year/$FileName."}}
    Invoke-SafeReadSignatureVerification -Path $destination -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
    $facts=Get-Facts $destination $year ([pscustomobject]@{role=$Role;fileName=$FileName})
    if($FileName -cne "$($facts.Name).dll"){throw "Payload $year/$FileName does not match its assembly name."}
    if($Role -ceq 'host' -and $facts.Name -cne 'RevitOperator.SafeReadHost'){throw "Payload $year/$FileName is not the SafeRead host."}
    if($Role -ceq 'certified_executor' -and $facts.Name -cne 'RevitOperator.SafeReadCertifiedExecution'){throw "Payload $year/$FileName is not the certified executor."}
    if($Role -cin @('host','certified_executor')){if($facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64'){throw "Payload $year/$FileName has wrong framework/platform."}}
    elseif(-not(Test-SafeReadDependencyAssemblyCompatibility ([string]$facts.TargetFramework) ([string]$facts.Platform) $expected.Framework)){throw "Runtime dependency $year/$FileName is not framework/platform compatible."}
    $revitRef=@(Get-ReferenceByName $facts 'RevitAPI');$revitUiRef=@(Get-ReferenceByName $facts 'RevitAPIUI')
    if($RevitBound){if($revitRef.Count -ne 1){throw "Payload $year/$FileName must reference exactly one RevitAPI identity."};Assert-IdentityEqual $apiFacts.Identity $revitRef[0] "Payload $year/$FileName RevitAPI"}
    elseif($revitRef.Count -or $revitUiRef.Count){throw "Runtime dependency $year/$FileName may not reference Revit API assemblies."}
    if($Role -ceq 'host'){if($revitUiRef.Count -ne 1){throw "Host $year must reference exactly one RevitAPIUI identity."};Assert-IdentityEqual $apiUiFacts.Identity $revitUiRef[0] "Host $year RevitAPIUI"}
    if($Role -ceq 'certified_executor' -and $revitUiRef.Count){throw "Certified executor $year may not reference RevitAPIUI."}
    $assembly=[ordered]@{name=[string]$facts.Name;version=[string]$facts.Version;culture=[string]$facts.Culture;publicKeyToken=[string]$facts.PublicKeyToken;targetFramework=[string]$facts.TargetFramework;platform=[string]$facts.Platform;mvid=[string]$facts.Mvid;references=@(ConvertTo-SafeReadCanonicalAssemblyReferences @($facts.AssemblyReferences))}
    $entry=[ordered]@{path="payload/$FileName";role=$Role;revitApiBound=$RevitBound;sha256=Get-SafeReadSha256 $destination;sizeBytes=(Get-Item -LiteralPath $destination).Length;assembly=$assembly;provenance=$Provenance}
    Set-Variable -Name payloadReceipts -Scope 1 -Value (@($payloadReceipts)+@($entry))
  }

  Add-Payload $hostSource 'RevitOperator.SafeReadHost.dll' 'host' $true $null
  $executorProvenance=[ordered]@{proofReceiptSha256=$proofReceiptSha;unsignedSha256=('sha256:'+([string]$proof.Artifact.sha256));equivalenceReceiptSha256=$null;canonicalPeSha256=$null;verifierProfileId=[string]$proof.Receipt.verifierProfileId;verifierProfileSha256=[string]$proof.Receipt.verifierProfileSha256;verifierBundleSha256=[string]$proof.Receipt.verifierBundleSha256}
  Add-Payload $proof.AssemblyPath 'RevitOperator.SafeReadCertifiedExecution.dll' 'certified_executor' $true $executorProvenance
  $signedExecutor=Join-Path $payloadRoot 'RevitOperator.SafeReadCertifiedExecution.dll'
  $equivalenceRoot=Join-Path $runRoot "equivalence-$year"
  [void](Invoke-CheckedCommand "SafeRead signed PE equivalence for Revit $year" {& dotnet $proofTool equivalence --unsigned-artifact $proof.AssemblyPath --candidate-artifact $signedExecutor --proof-receipt $proofReceiptPath --revit-year $year --output-dir $equivalenceRoot})
  $equivalencePath=Resolve-SafeReadCanonicalPath (Join-Path $equivalenceRoot 'artifact.equivalence.json')
  $equivalence=ConvertTo-SafeReadObject $equivalencePath
  Assert-SafeReadExactProperties $equivalence @('schemaVersion','status','equivalent','proofReceiptSha256','revitYear','artifactFileName','unsignedSha256','unsignedLength','candidateSha256','candidateLength','canonicalPeSha256','verifierProfileId','verifierProfileSha256','verifierBundleSha256','allowedDifferences','issues') "SafeRead equivalence receipt $year"
  if([int]$equivalence.schemaVersion -ne 1 -or $equivalence.status -cne 'verified' -or -not [bool]$equivalence.equivalent -or @($equivalence.issues).Count -ne 0 -or $equivalence.proofReceiptSha256 -cne $proofReceiptSha.Substring(7) -or $equivalence.revitYear -cne $year -or $equivalence.artifactFileName -cne "RevitOperator.SafeReadCertifiedExecution.Revit$year.dll" -or ('sha256:'+$equivalence.unsignedSha256) -cne $executorProvenance.unsignedSha256 -or ('sha256:'+$equivalence.candidateSha256) -cne (Get-SafeReadSha256 $signedExecutor) -or $equivalence.verifierProfileId -cne $proof.Receipt.verifierProfileId -or $equivalence.verifierProfileSha256 -cne $proof.Receipt.verifierProfileSha256 -or $equivalence.verifierBundleSha256 -cne $proof.Receipt.verifierBundleSha256){throw "SafeRead signed PE equivalence receipt is invalid for Revit $year."}
  Copy-Item -LiteralPath $equivalencePath -Destination (Join-Path $targetProofRoot 'artifact.equivalence.json')
  $executorEntry=@($payloadReceipts|Where-Object role -ceq 'certified_executor')[0]
  $executorEntry.provenance.equivalenceReceiptSha256=Get-SafeReadSha256 (Join-Path $targetProofRoot 'artifact.equivalence.json')
  $executorEntry.provenance.canonicalPeSha256=[string]$equivalence.canonicalPeSha256

  $processed=@{}
  do{
    $added=$false
    foreach($entry in @($payloadReceipts)){
      foreach($reference in @($entry.assembly.references)){
        if(Test-SafeReadRuntimeProvidedAssembly $reference $expected.Framework){continue}
        $key=Get-SafeReadAssemblyIdentityKey $reference
        if(@($payloadReceipts|Where-Object{(Get-SafeReadAssemblyIdentityKey $_.assembly) -ceq $key}).Count){continue}
        if($processed.ContainsKey($key)){continue};$processed[$key]=$true
        $candidates=@(Get-ChildItem -LiteralPath $dependencySearchRoot -File -Filter "$($reference.name).dll"|ForEach-Object{[pscustomobject]@{Path=$_.FullName;Facts=Get-Facts $_.FullName $year ([pscustomobject]@{role='runtime_dependency'})}}|Where-Object{(Get-SafeReadAssemblyIdentityKey $_.Facts) -ceq $key})
        if($candidates.Count -ne 1){throw "SafeRead target $year requires exactly one dependency artifact for $key; found $($candidates.Count)."}
        Add-Payload $candidates[0].Path "$($reference.name).dll" 'runtime_dependency' $false $null;$added=$true
      }
    }
  }while($added)
  Assert-SafeReadDependencyClosure $payloadReceipts $expected.Framework $year

  $templateDestination=Join-Path $manifestRoot 'RevitOperator.SafeReadHost.addin.template';Copy-Item -LiteralPath $templateSource -Destination $templateDestination
  $proofDestination=Join-Path $targetProofRoot 'proof.receipt.json';$equivalenceDestination=Join-Path $targetProofRoot 'artifact.equivalence.json'
  $runtime=[ordered]@{schema='revit-operator.safe-read-runtime-attestation.v1';state=[string]$input.runtimeAttestation.state;issued_at_utc=[string]$input.runtimeAttestation.issued_at_utc;expires_at_utc=[string]$input.runtimeAttestation.expires_at_utc;route_id='safe_read.sheet_count.v1';route_contract_sha256='sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874';policy_sha256='sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67';proof_sha256=Get-SafeReadSha256 $proofDestination;executor_id='revit-operator.safe-read-host.v1';runtime_tuple=[ordered]@{host_content_sha256=$executorEntry.sha256;host_mvid=$executorEntry.assembly.mvid;revit_api_content_sha256=$apiFacts.ContentSha256;revit_api_mvid=$apiFacts.Mvid;revit_version=$year}}
  $runtimePath=Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.json';[IO.File]::WriteAllText($runtimePath,(ConvertTo-SafeReadCanonicalJson $runtime),[Text.UTF8Encoding]::new($false));$runtimePin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.sha256'),$runtimePin+"`n",[Text.UTF8Encoding]::new($false))
  $apiEvidence=[ordered]@{contentSha256=$apiFacts.ContentSha256;mvid=$apiFacts.Mvid;identity=$apiFacts.Identity}
  $apiUiEvidence=[ordered]@{contentSha256=$apiUiFacts.ContentSha256;mvid=$apiUiFacts.Mvid;identity=$apiUiFacts.Identity}
  $release.targets += [ordered]@{revitYear=$year;framework=$expected.Framework;platform='x64';revitApi=$apiEvidence;revitApiUi=$apiUiEvidence;requiredPayload=$payloadReceipts;proof=[ordered]@{path='proof/proof.receipt.json';sha256=Get-SafeReadSha256 $proofDestination;sizeBytes=(Get-Item $proofDestination).Length;artifactUnsignedSha256=[string]$proof.Artifact.sha256;equivalencePath='proof/artifact.equivalence.json';equivalenceSha256=Get-SafeReadSha256 $equivalenceDestination};runtimeAttestation=[ordered]@{path='payload/safe_read_runtime_attestation.v1.json';sha256=$runtimePin;sizeBytes=(Get-Item $runtimePath).Length};manifest=[ordered]@{path='manifest/RevitOperator.SafeReadHost.addin.template';sha256=Get-SafeReadSha256 $templateDestination;sizeBytes=(Get-Item $templateDestination).Length}}
  $packagePins += [ordered]@{revitYear=$year;runtimeAttestationSha256=$runtimePin}
  $proofHashes += Get-SafeReadSha256 $proofDestination
}

if(@($proofHashes|Sort-Object -Unique).Count -ne 1 -or $proofHashes[0] -cne $proofReceiptSha){throw 'All package targets must preserve one exact three-year proof receipt.'}
$releasePath=Join-Path $stage 'release-manifest.json';[IO.File]::WriteAllText($releasePath,(ConvertTo-SafeReadCanonicalJson $release),[Text.UTF8Encoding]::new($false))
$pins=[ordered]@{schemaVersion='revit-operator.safe-read-package-pins.v3';releaseId=[string]$input.releaseId;releaseManifestSha256=Get-SafeReadSha256 $releasePath;targets=$packagePins}
$pinsPath=Join-Path $stage 'package-pins.json';[IO.File]::WriteAllText($pinsPath,(ConvertTo-SafeReadCanonicalJson $pins),[Text.UTF8Encoding]::new($false));$pin=Get-SafeReadSha256 $pinsPath
[void](Assert-SafeReadSecureTree $stage)
[void](Assert-SafeReadBundle -BundleRoot $stage -AttestationPinSha256 $pin -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector)
Move-Item -LiteralPath $stage -Destination $bundleRoot
[void](Assert-SafeReadSecureTree $bundleRoot)
Write-Host "SafeRead package created: $bundleRoot"
Write-Host "External package pins SHA-256: $pin"
