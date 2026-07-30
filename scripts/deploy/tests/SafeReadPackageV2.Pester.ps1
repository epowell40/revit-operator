BeforeAll {
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$deployRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$module=Join-Path $deployRoot 'SafeReadPackageV2.psm1';Import-Module $module -Force;$safeReadModule=Get-Module SafeReadPackageV2
$builder=Join-Path $deployRoot 'build_saferead_package_v2.ps1'
$installer=Join-Path $deployRoot 'install_saferead_package_v2.ps1'
$verifier=Join-Path $deployRoot 'verify_saferead_microhost_bundle.ps1'
$admissionPreparer=Join-Path $deployRoot 'prepare_saferead_admission_receipt.ps1'
$repoRoot=(Resolve-Path (Join-Path $deployRoot '..\..')).Path
$contract=Get-Content -LiteralPath (Join-Path $repoRoot 'contracts\safe-read\contract.v1.json') -Raw|ConvertFrom-Json
$testThumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
$signatureVerifier={param($Path)[pscustomobject]@{Status='Valid';Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}

function Write-JsonFile([string]$Path,$Value){[IO.Directory]::CreateDirectory((Split-Path -Parent $Path))|Out-Null;[IO.File]::WriteAllText($Path,(ConvertTo-SafeReadCanonicalJson $Value),[Text.UTF8Encoding]::new($false))}
function ConvertTo-TestCanonicalValue($Value){
  if($null -eq $Value){return $null}
  if($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string] -and $Value -isnot [System.Collections.IDictionary]){return @($Value|ForEach-Object{ConvertTo-TestCanonicalValue $_})}
  if($Value -is [System.Collections.IDictionary]){$result=[ordered]@{};foreach($name in @($Value.Keys|ForEach-Object{[string]$_}|Sort-Object)){$result[$name]=ConvertTo-TestCanonicalValue $Value[$name]};return $result}
  if($Value -is [pscustomobject]){$result=[ordered]@{};foreach($property in @($Value.PSObject.Properties|Sort-Object Name)){$result[$property.Name]=ConvertTo-TestCanonicalValue $property.Value};return $result}
  $Value
}
function Get-TestCanonicalHash($Value){$json=(ConvertTo-TestCanonicalValue $Value)|ConvertTo-Json -Depth 16 -Compress;$bytes=[Text.UTF8Encoding]::new($false).GetBytes($json);$sha=[Security.Cryptography.SHA256]::Create();try{'sha256:'+([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}}
function Assert-ThrowsLike([scriptblock]$Action,[string]$Pattern){$message=$null;try{&$Action}catch{$message=$_.Exception.Message};if($null -eq $message -or $message -notlike $Pattern){throw "Expected failure '$Pattern'; actual '$message'."}}
function New-SafeReadAdmissionReceiptForTesting([string]$BundleRoot,[string]$AttestationPinSha256,[string]$ManifestAssemblyRoot,[scriptblock]$SignatureVerifier,[scriptblock]$AssemblyInspector){
  &$safeReadModule {param($BundleRoot,$AttestationPinSha256,$ManifestAssemblyRoot,$SignatureVerifier,$AssemblyInspector)New-SafeReadAdmissionReceiptCore -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector} $BundleRoot $AttestationPinSha256 $ManifestAssemblyRoot $SignatureVerifier $AssemblyInspector
}
function Assert-SafeReadAdmissionReceiptForTesting([string]$ReceiptPath,[string]$BundleRoot,[string]$AttestationPinSha256,[string]$ExpectedManifestAssemblyRoot,[scriptblock]$SignatureVerifier,[scriptblock]$AssemblyInspector){
  &$safeReadModule {param($ReceiptPath,$BundleRoot,$AttestationPinSha256,$ExpectedManifestAssemblyRoot,$SignatureVerifier,$AssemblyInspector)Assert-SafeReadAdmissionReceiptCore -ReceiptPath $ReceiptPath -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ExpectedManifestAssemblyRoot -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector} $ReceiptPath $BundleRoot $AttestationPinSha256 $ExpectedManifestAssemblyRoot $SignatureVerifier $AssemblyInspector
}
function New-Identity([string]$Name,[string]$Version='1.0.0.0',[string]$Token='null'){[pscustomobject][ordered]@{name=$Name;version=$Version;culture='neutral';publicKeyToken=$Token}}
function Get-YearMajor([string]$Year){switch($Year){'2023'{23}'2024'{24}'2025'{25}}}
function Get-FakeFacts([string]$Year,[string]$Name){
  $major=Get-YearMajor $Year;$framework=if($Year -eq '2025'){'.NETCoreApp,Version=v8.0'}else{'.NETFramework,Version=v4.8'}
  $api=New-Identity 'RevitAPI' "$major.0.0.0";$ui=New-Identity 'RevitAPIUI' "$major.0.0.0"
  $runtime=if($Year -eq '2025'){New-Identity 'System.Runtime' '8.0.0.0' 'b03f5f7f11d50a3a'}else{New-Identity 'mscorlib' '4.0.0.0' 'b77a5c561934e089'}
  $refs=if($Name -eq 'RevitOperator.SafeReadHost'){@($api,$ui,$runtime)}elseif($Name -eq 'RevitOperator.SafeReadCertifiedExecution'){@($api,$runtime)}else{@($runtime)}
  [pscustomobject]@{Name=$Name;Version='1.0.0.0';Culture='neutral';PublicKeyToken='null';TargetFramework=$framework;Platform='Amd64';Mvid=("$major".PadLeft(8,'0')+'-0000-0000-0000-'+(([Math]::Abs($Name.GetHashCode())%999999999999).ToString().PadLeft(12,'0')));RevitApiReferenceVersion=if($Name -like 'RevitOperator.*'){"$major.0.0.0"}else{$null};AssemblyReferences=@($refs|Sort-Object @{Expression={Get-SafeReadAssemblyIdentityKey $_}})}
}
$assemblyInspector={param($Path,$Year,$Item)Get-FakeFacts $Year ([IO.Path]::GetFileNameWithoutExtension($Path))}

function New-TestBundle([string]$Root,[string]$ReleaseId='safe-read-v3-a',[switch]$OmitSourceReceipt){
  [IO.Directory]::CreateDirectory($Root)|Out-Null
  $sourceReceipt=[ordered]@{schemaVersion=1;commit=('a'*40);proofTree=('b'*40);hostTree=('c'*40);archiveSha256=('sha256:'+('d'*64))}
  $sourceReceiptPath=Join-Path $Root 'source.snapshot.receipt.json';if(-not $OmitSourceReceipt){Write-JsonFile $sourceReceiptPath $sourceReceipt}
  $artifacts=[ordered]@{}
  foreach($year in '2023','2024','2025'){$expected=Get-SafeReadExpectedTarget $year;$artifacts[$year]=[ordered]@{fileName="RevitOperator.SafeReadCertifiedExecution.Revit$year.dll";sha256=($year.Substring(3,1)*64);length=100;managedCodeSha256=('b'*64);assemblyIdentity='RevitOperator.SafeReadCertifiedExecution, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null';targetFramework=$expected.TargetFrameworkAttribute;platform='x64'}}
  $proof=[ordered]@{schemaVersion=1;proofKind='revit-safe-read-certified-kernel/v1';mode='check';status='verified';certified=$true;manifestSha256=('1'*64);verifierProfileId='revit-safe-read-sheet-count-kernel/v1';verifierProfileSha256=('2'*64);verifierBundleSha256=('3'*64);sourceLockSha256=('4'*64);apiLockSha256=('5'*64);sdkLockSha256=('6'*64);trustBoundary='fixture';compilerOptions=@('/deterministic+');issues=@();observation=[ordered]@{};artifacts=$artifacts}
  $targets=@();$pinTargets=@()
  foreach($year in '2023','2024','2025'){
    $expected=Get-SafeReadExpectedTarget $year;$major=Get-YearMajor $year;$targetRoot=Join-Path $Root "targets\$year";$payloadRoot=Join-Path $targetRoot 'payload';$manifestRoot=Join-Path $targetRoot 'manifest';$proofRoot=Join-Path $targetRoot 'proof'
    [IO.Directory]::CreateDirectory($payloadRoot)|Out-Null;[IO.Directory]::CreateDirectory($manifestRoot)|Out-Null;[IO.Directory]::CreateDirectory($proofRoot)|Out-Null
    $proofPath=Join-Path $proofRoot 'proof.receipt.json';Write-JsonFile $proofPath $proof;$proofSha=Get-SafeReadSha256 $proofPath
    $hostPath=Join-Path $payloadRoot 'RevitOperator.SafeReadHost.dll';$executorPath=Join-Path $payloadRoot 'RevitOperator.SafeReadCertifiedExecution.dll';[IO.File]::WriteAllText($hostPath,"host-$year");[IO.File]::WriteAllText($executorPath,"executor-$year")
    $hostFacts=Get-FakeFacts $year 'RevitOperator.SafeReadHost';$executorFacts=Get-FakeFacts $year 'RevitOperator.SafeReadCertifiedExecution'
    $equivalence=[ordered]@{schemaVersion=1;status='verified';equivalent=$true;proofReceiptSha256=$proofSha.Substring(7);revitYear=$year;artifactFileName="RevitOperator.SafeReadCertifiedExecution.Revit$year.dll";unsignedSha256=[string]$artifacts[$year].sha256;unsignedLength=100;candidateSha256=(Get-SafeReadSha256 $executorPath).Substring(7);candidateLength=(Get-Item $executorPath).Length;canonicalPeSha256=('7'*64);verifierProfileId='revit-safe-read-sheet-count-kernel/v1';verifierProfileSha256=('2'*64);verifierBundleSha256=('3'*64);allowedDifferences=@('certificate-table');issues=@()}
    $equivalencePath=Join-Path $proofRoot 'artifact.equivalence.json';Write-JsonFile $equivalencePath $equivalence
    $hostAssembly=[ordered]@{name=$hostFacts.Name;version=$hostFacts.Version;culture=$hostFacts.Culture;publicKeyToken=$hostFacts.PublicKeyToken;targetFramework=$hostFacts.TargetFramework;platform=$hostFacts.Platform;mvid=$hostFacts.Mvid;references=$hostFacts.AssemblyReferences}
    $executorAssembly=[ordered]@{name=$executorFacts.Name;version=$executorFacts.Version;culture=$executorFacts.Culture;publicKeyToken=$executorFacts.PublicKeyToken;targetFramework=$executorFacts.TargetFramework;platform=$executorFacts.Platform;mvid=$executorFacts.Mvid;references=$executorFacts.AssemblyReferences}
    $payload=@(
      [ordered]@{path='payload/RevitOperator.SafeReadHost.dll';role='host';revitApiBound=$true;sha256=Get-SafeReadSha256 $hostPath;sizeBytes=(Get-Item $hostPath).Length;assembly=$hostAssembly;provenance=$null},
      [ordered]@{path='payload/RevitOperator.SafeReadCertifiedExecution.dll';role='certified_executor';revitApiBound=$true;sha256=Get-SafeReadSha256 $executorPath;sizeBytes=(Get-Item $executorPath).Length;assembly=$executorAssembly;provenance=[ordered]@{proofReceiptSha256=$proofSha;unsignedSha256=('sha256:'+[string]$artifacts[$year].sha256);equivalenceReceiptSha256=Get-SafeReadSha256 $equivalencePath;canonicalPeSha256=('7'*64);verifierProfileId='revit-safe-read-sheet-count-kernel/v1';verifierProfileSha256=('2'*64);verifierBundleSha256=('3'*64)}}
    )
    $template=Join-Path $manifestRoot 'RevitOperator.SafeReadHost.addin.template';Copy-Item -LiteralPath (Join-Path $deployRoot '..\..\apps\revit-safe-read-host\addin\RevitOperator.SafeReadHost.addin.template') -Destination $template
    $apiIdentity=New-Identity 'RevitAPI' "$major.0.0.0";$uiIdentity=New-Identity 'RevitAPIUI' "$major.0.0.0";$api=[ordered]@{contentSha256=('sha256:'+('8'*64));mvid=("$major".PadLeft(8,'0')+'-0000-0000-0000-000000000001');identity=$apiIdentity};$apiUi=[ordered]@{contentSha256=('sha256:'+('9'*64));mvid=("$major".PadLeft(8,'0')+'-0000-0000-0000-000000000002');identity=$uiIdentity}
    $executor=$payload[1];$runtime=[ordered]@{schema=[string]$contract.schemas.runtime_attestation;state='active';issued_at_utc='2030-01-01T00:00:00.000Z';expires_at_utc='2030-01-01T00:05:00.000Z';route_id=[string]$contract.route.route_id;route_contract_sha256=[string]$contract.route.route_contract_sha256;policy_sha256=[string]$contract.route.policy_sha256;proof_sha256=$proofSha;executor_id=[string]$contract.identity.executor_id;runtime_tuple=[ordered]@{host_content_sha256=$executor.sha256;host_mvid=$executor.assembly.mvid;revit_api_content_sha256=$api.contentSha256;revit_api_mvid=$api.mvid;revit_version=$year}}
    $runtimePath=Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.json';Write-JsonFile $runtimePath $runtime;$runtimePin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.sha256'),$runtimePin+"`n",[Text.UTF8Encoding]::new($false))
    $targets += [ordered]@{revitYear=$year;framework=$expected.Framework;platform='x64';revitApi=$api;revitApiUi=$apiUi;requiredPayload=$payload;proof=[ordered]@{path='proof/proof.receipt.json';sha256=$proofSha;sizeBytes=(Get-Item $proofPath).Length;artifactUnsignedSha256=[string]$artifacts[$year].sha256;equivalencePath='proof/artifact.equivalence.json';equivalenceSha256=Get-SafeReadSha256 $equivalencePath};runtimeAttestation=[ordered]@{path='payload/safe_read_runtime_attestation.v1.json';sha256=$runtimePin;sizeBytes=(Get-Item $runtimePath).Length};manifest=[ordered]@{path='manifest/RevitOperator.SafeReadHost.addin.template';sha256=Get-SafeReadSha256 $template;sizeBytes=(Get-Item $template).Length}}
    $pinTargets += [ordered]@{revitYear=$year;runtimeAttestationSha256=$runtimePin}
  }
  $source=[ordered]@{path='source.snapshot.receipt.json';sha256=if($OmitSourceReceipt){'sha256:'+('e'*64)}else{Get-SafeReadSha256 $sourceReceiptPath};sizeBytes=if($OmitSourceReceipt){1}else{(Get-Item $sourceReceiptPath).Length};commit=$sourceReceipt.commit;proofTree=$sourceReceipt.proofTree;hostTree=$sourceReceipt.hostTree;archiveSha256=$sourceReceipt.archiveSha256}
  $release=[ordered]@{schemaVersion='revit-operator.safe-read-package-release.v3';releaseId=$ReleaseId;allowedSignerThumbprints=@($testThumbprint);source=$source;targets=$targets};$releasePath=Join-Path $Root 'release-manifest.json';Write-JsonFile $releasePath $release
  $pins=[ordered]@{schemaVersion='revit-operator.safe-read-package-pins.v3';releaseId=$ReleaseId;releaseManifestSha256=Get-SafeReadSha256 $releasePath;targets=$pinTargets};$pinsPath=Join-Path $Root 'package-pins.json';Write-JsonFile $pinsPath $pins
  [void](Protect-SafeReadTreeAcl $Root)
  [pscustomobject]@{Root=$Root;Pin=Get-SafeReadSha256 $pinsPath;ReleaseId=$ReleaseId}
}

function Refresh-BundlePin($Bundle){$pins=ConvertTo-SafeReadObject (Join-Path $Bundle.Root 'package-pins.json');$pins.releaseManifestSha256=Get-SafeReadSha256 (Join-Path $Bundle.Root 'release-manifest.json');Write-JsonFile (Join-Path $Bundle.Root 'package-pins.json') $pins;$Bundle.Pin=Get-SafeReadSha256 (Join-Path $Bundle.Root 'package-pins.json')}
function Refresh-SourceEvidence($Bundle,[switch]$CopyIdentities){$receiptPath=Join-Path $Bundle.Root 'source.snapshot.receipt.json';$receipt=ConvertTo-SafeReadObject $receiptPath;$releasePath=Join-Path $Bundle.Root 'release-manifest.json';$release=ConvertTo-SafeReadObject $releasePath;$release.source.sha256=Get-SafeReadSha256 $receiptPath;$release.source.sizeBytes=(Get-Item $receiptPath).Length;if($CopyIdentities){foreach($name in 'commit','proofTree','hostTree','archiveSha256'){$release.source.$name=$receipt.$name}};Write-JsonFile $releasePath $release;Refresh-BundlePin $Bundle}
function Rebind-TamperedExecutor($Bundle,[string]$Year){$releasePath=Join-Path $Bundle.Root 'release-manifest.json';$release=ConvertTo-SafeReadObject $releasePath;$target=@($release.targets|Where-Object revitYear -eq $Year)[0];$executor=@($target.requiredPayload|Where-Object role -eq 'certified_executor')[0];$path=Join-Path $Bundle.Root "targets\$Year\payload\RevitOperator.SafeReadCertifiedExecution.dll";$executor.sha256=Get-SafeReadSha256 $path;$executor.sizeBytes=(Get-Item $path).Length;$runtimePath=Join-Path $Bundle.Root "targets\$Year\payload\safe_read_runtime_attestation.v1.json";$runtime=ConvertTo-SafeReadObject $runtimePath;$runtime.runtime_tuple.host_content_sha256=$executor.sha256;Write-JsonFile $runtimePath $runtime;$pin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $Bundle.Root "targets\$Year\payload\safe_read_runtime_attestation.v1.sha256"),$pin+"`n",[Text.UTF8Encoding]::new($false));$target.runtimeAttestation.sha256=$pin;$target.runtimeAttestation.sizeBytes=(Get-Item $runtimePath).Length;Write-JsonFile $releasePath $release;$pins=ConvertTo-SafeReadObject (Join-Path $Bundle.Root 'package-pins.json');@($pins.targets|Where-Object revitYear -eq $Year)[0].runtimeAttestationSha256=$pin;Write-JsonFile (Join-Path $Bundle.Root 'package-pins.json') $pins;Refresh-BundlePin $Bundle}
}

Describe 'SafeRead package v3 security contract' {
  BeforeEach{$bundle=New-TestBundle (Join-Path $TestDrive ([guid]::NewGuid().ToString('N')))}

  It 'accepts an exact three-year package and one identical proof receipt' {
    $receipt=Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    if($receipt.Targets.Count -ne 3){throw 'Expected three targets.'}
    if($receipt.Source.commit -cne ('a'*40) -or $receipt.SourceReceipt.archiveSha256 -cne ('sha256:'+('d'*64))){throw 'Expected exact source snapshot evidence.'}
  }

  It 'creates and externally verifies one canonical admission receipt through the explicit test seam without writing live manifests' {
    $assemblyRoot=Join-Path $TestDrive ('future '+[char]0x00DC+' & release');$receiptPath=Join-Path $TestDrive 'admission.receipt.json'
    $outputFull=Resolve-SafeReadAdmissionOutputPath -OutputPath $receiptPath -CoordinationRoot $TestDrive -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot
    $created=New-SafeReadAdmissionReceiptForTesting -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    [IO.File]::WriteAllText($outputFull,(ConvertTo-SafeReadCanonicalJson $created),[Text.UTF8Encoding]::new($false))
    if(Test-Path -LiteralPath $assemblyRoot){throw 'Admission preparation wrote the future release or live manifest root.'}
    $receipt=Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    if($receipt.releaseManifest.sha256 -cne (Get-SafeReadSha256 (Join-Path $bundle.Root 'release-manifest.json')) -or $receipt.packagePins.externalSha256 -cne $bundle.Pin){throw 'Admission receipt omits its external release/package binding.'}
    if($receipt.source.commit -cne ('a'*40) -or $receipt.proof.targetPaths.Count -ne 3 -or $receipt.targets.Count -ne 3){throw 'Admission receipt omits source, common proof, or three-year evidence.'}
    foreach($target in @($receipt.targets)){
      if($target.host.signerThumbprint -cne $testThumbprint -or $target.executor.signerThumbprint -cne $testThumbprint -or $target.executor.equivalence.candidateSha256 -cne $target.executor.sha256){throw "Admission receipt omits signed/equivalent payload facts for $($target.revitYear)."}
      if($target.runtimeAttestation.runtimeTuple.revitVersion -cne $target.revitYear -or $target.renderedManifest.fields.assembly -notlike "*targets\$($target.revitYear)\payload\RevitOperator.SafeReadHost.dll"){throw "Admission receipt omits runtime or rendered manifest facts for $($target.revitYear)."}
    }
  }

  It 'rejects canonical fabricated admission facts even when the receipt file is rewritten' {
    $assemblyRoot=Join-Path $TestDrive 'fabrication-root';$receiptPath=Join-Path $TestDrive 'fabricated.receipt.json'
    $receipt=New-SafeReadAdmissionReceiptForTesting -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    $receipt.targets[1].host.sha256='sha256:'+('f'*64);Write-JsonFile $receiptPath $receipt
    Assert-ThrowsLike {Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*does not match the externally verified package*'
  }

  It 'rejects non-canonical, BOM, UTF-16 admission bytes and a caller-selected manifest root mismatch' {
    $assemblyRoot=Join-Path $TestDrive 'canonical-root';$receiptPath=Join-Path $TestDrive 'noncanonical.receipt.json'
    $receipt=New-SafeReadAdmissionReceiptForTesting -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector;Write-JsonFile $receiptPath $receipt
    [IO.File]::AppendAllText($receiptPath,"`n",[Text.UTF8Encoding]::new($false))
    Assert-ThrowsLike {Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*exact canonical UTF-8 without BOM*'
    $json=ConvertTo-SafeReadCanonicalJson $receipt;$utf8Bom=[Text.UTF8Encoding]::new($true);[IO.File]::WriteAllBytes($receiptPath,[byte[]]($utf8Bom.GetPreamble()+$utf8Bom.GetBytes($json)))
    Assert-ThrowsLike {Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*exact canonical UTF-8 without BOM*'
    $utf16=[Text.UnicodeEncoding]::new($false,$true);[IO.File]::WriteAllBytes($receiptPath,[byte[]]($utf16.GetPreamble()+$utf16.GetBytes($json)))
    Assert-ThrowsLike {Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*exact canonical UTF-8 without BOM*'
    Write-JsonFile $receiptPath $receipt
    Assert-ThrowsLike {Assert-SafeReadAdmissionReceiptForTesting -ReceiptPath $receiptPath -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ExpectedManifestAssemblyRoot (Join-Path $TestDrive 'other-root') -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*does not match the externally verified package*'
  }

  It 'uses one deterministic canonical JSON byte contract in both PowerShell editions' {
    $value=[ordered]@{path=('C:\'+[char]0x00DC+'ser\BIM & Tools');quote='"';slash='\';control="line`nfeed";emoji=[char]::ConvertFromUtf32(0x1F642)}
    $expected='{"path":"C:\\'+[char]0x00DC+'ser\\BIM & Tools","quote":"\"","slash":"\\","control":"line\nfeed","emoji":"'+[char]::ConvertFromUtf32(0x1F642)+'"}'
    if((ConvertTo-SafeReadCanonicalJson $value) -cne $expected){throw 'SafeRead canonical JSON escaping or Unicode preservation drifted.'}
    Assert-ThrowsLike {ConvertTo-SafeReadCanonicalJson ([ordered]@{bad=[string][char]0xD800})} '*unpaired high surrogate*'
  }

  It 'keeps verifier injection out of production entrypoints' {
    foreach($commandPath in $admissionPreparer,$verifier){
      $parameters=(Get-Command $commandPath).Parameters.Keys
      foreach($forbidden in 'SignatureVerifier','AssemblyInspector'){if($parameters -contains $forbidden){throw "$commandPath exposes production verifier injection: $forbidden"}}
    }
    foreach($commandName in 'New-SafeReadAdmissionReceipt','Assert-SafeReadAdmissionReceipt'){
      $parameters=(Get-Command $commandName).Parameters.Keys
      foreach($forbidden in 'SignatureVerifier','AssemblyInspector'){if($parameters -contains $forbidden){throw "$commandName exposes production verifier injection: $forbidden"}}
    }
    $forgedPath=Join-Path $TestDrive 'forged-verifier.json';$assemblyRoot=Join-Path $TestDrive 'forged-verifier-root'
    Assert-ThrowsLike {&$admissionPreparer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -CoordinationRoot $TestDrive -OutputPath $forgedPath -SignatureVerifier $signatureVerifier} '*parameter*SignatureVerifier*'
    Assert-ThrowsLike {New-SafeReadAdmissionReceipt -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -SignatureVerifier $signatureVerifier} '*parameter*SignatureVerifier*'
    if(Test-Path -LiteralPath $forgedPath){throw 'A fabricated verifier reached the production admission output path.'}
  }

  It 'rejects unsafe receipt outputs, volume roots, Autodesk Addins, and reparse roots before writing' {
    $assemblyRoot=Join-Path $TestDrive 'future-release-root';$outside=Join-Path (Split-Path -Parent $TestDrive) 'outside.receipt.json'
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath $outside -CoordinationRoot $TestDrive -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*direct child*'
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath (Join-Path $TestDrive 'receipt.addin') -CoordinationRoot $TestDrive -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*exact .json extension*'
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath (Join-Path $bundle.Root 'receipt.json') -CoordinationRoot $bundle.Root -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*package bundle*'
    [IO.Directory]::CreateDirectory($assemblyRoot)|Out-Null
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath (Join-Path $assemblyRoot 'receipt.json') -CoordinationRoot $assemblyRoot -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*manifest assembly root*'
    $autodesk=Join-Path $TestDrive 'Autodesk\Revit\Addins\2025';[IO.Directory]::CreateDirectory($autodesk)|Out-Null
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath (Join-Path $autodesk 'receipt.json') -CoordinationRoot $autodesk -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*Autodesk Revit Addins tree*'
    $existing=Join-Path $TestDrive 'existing.json';[IO.File]::WriteAllText($existing,'x')
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath $existing -CoordinationRoot $TestDrive -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*Refusing to overwrite*'
    Assert-ThrowsLike {Resolve-SafeReadManifestAssemblyRoot ([IO.Path]::GetPathRoot($TestDrive))} '*volume root*'
    $target=Join-Path $TestDrive 'canonical-coordination';[IO.Directory]::CreateDirectory($target)|Out-Null;$junction=Join-Path $TestDrive 'coordination-link';New-Item -ItemType Junction -Path $junction -Target $target|Out-Null
    Assert-ThrowsLike {Resolve-SafeReadAdmissionOutputPath -OutputPath (Join-Path $junction 'receipt.json') -CoordinationRoot $junction -BundleRoot $bundle.Root -ManifestAssemblyRoot $assemblyRoot} '*links or reparse points*'
    Assert-ThrowsLike {&$admissionPreparer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -ManifestAssemblyRoot $assemblyRoot -CoordinationRoot $TestDrive -OutputPath (Join-Path $TestDrive 'never-written.addin')} '*exact .json extension*'
    if(Test-Path -LiteralPath (Join-Path $TestDrive 'never-written.addin')){throw 'Unsafe admission preparation wrote a live-style addin file.'}
  }

  It 'rejects a missing source snapshot receipt' {
    $missing=New-TestBundle (Join-Path $TestDrive 'missing-source') 'safe-read-v3-missing' -OmitSourceReceipt
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $missing.Root -AttestationPinSha256 $missing.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*missing source.snapshot.receipt.json*'
  }

  It 'rejects extra source receipt fields after every package hash is rebound' {
    $path=Join-Path $bundle.Root 'source.snapshot.receipt.json';$source=ConvertTo-SafeReadObject $path;$source|Add-Member -NotePropertyName branch -NotePropertyValue 'untrusted';Write-JsonFile $path $source;Refresh-SourceEvidence $bundle
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*extra properties*'
  }

  It 'rejects non-canonical source receipt bytes after every package hash is rebound' {
    $path=Join-Path $bundle.Root 'source.snapshot.receipt.json';[IO.File]::AppendAllText($path,"`n",[Text.UTF8Encoding]::new($false));Refresh-SourceEvidence $bundle
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*exact canonical UTF-8 without BOM*'
  }

  It 'rejects a rebound source receipt that disagrees with duplicated release identity' {
    $path=Join-Path $bundle.Root 'source.snapshot.receipt.json';$source=ConvertTo-SafeReadObject $path;$source.commit=('e'*40);Write-JsonFile $path $source;Refresh-SourceEvidence $bundle
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*does not match its snapshot receipt*'
  }

  It 'rejects uppercase source identities after the receipt and release are rebound together' {
    $path=Join-Path $bundle.Root 'source.snapshot.receipt.json';$source=ConvertTo-SafeReadObject $path;$source.commit=('A'*40);Write-JsonFile $path $source;Refresh-SourceEvidence $bundle -CopyIdentities
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*identities are invalid or not lowercase*'
  }

  It 'rejects an extra file at package root' {
    [IO.File]::WriteAllText((Join-Path $bundle.Root 'untrusted.txt'),'extra')
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*missing or extra entries*'
  }

  It 'matches the canonical cross-runtime contract fixture and recomputes every route hash' {
    $body=$contract.route.canonical_body_json|ConvertFrom-Json
    if((Get-TestCanonicalHash $body) -cne [string]$contract.route.body_sha256){throw 'Canonical body hash drifted.'}
    $request=[ordered]@{method=[string]$contract.route.method;path=[string]$contract.route.path;body=$body}
    if((Get-TestCanonicalHash $request) -cne [string]$contract.route.request_hash){throw 'Canonical request hash drifted.'}
    if((Get-TestCanonicalHash $contract.route.effect) -cne [string]$contract.route.effect_hash){throw 'Canonical effect hash drifted.'}
    $route=[ordered]@{route_id=[string]$contract.route.route_id;method=[string]$contract.route.method;path=[string]$contract.route.path;canonical_body_json=[string]$contract.route.canonical_body_json;request_hash=[string]$contract.route.request_hash;effect_hash=[string]$contract.route.effect_hash}
    if((Get-TestCanonicalHash $route) -cne [string]$contract.route.route_contract_sha256){throw 'Canonical route contract hash drifted.'}
    if((Get-TestCanonicalHash $contract.route.policy) -cne [string]$contract.route.policy_sha256){throw 'Canonical policy hash drifted.'}
    $runtime=ConvertTo-SafeReadObject (Join-Path $bundle.Root 'targets\2024\payload\safe_read_runtime_attestation.v1.json')
    if((@($runtime.PSObject.Properties.Name) -join ',') -cne (@($contract.keys.runtime_attestation) -join ',')){throw 'Packaged attestation key order drifted.'}
    if($runtime.schema -cne $contract.schemas.runtime_attestation -or $runtime.route_id -cne $contract.route.route_id -or $runtime.route_contract_sha256 -cne $contract.route.route_contract_sha256 -or $runtime.policy_sha256 -cne $contract.route.policy_sha256 -or $runtime.executor_id -cne $contract.identity.executor_id){throw 'Packaged attestation contract drifted.'}
    if((@($runtime.runtime_tuple.PSObject.Properties.Name) -join ',') -cne (@($contract.keys.runtime_tuple) -join ',')){throw 'Packaged runtime tuple key order drifted.'}
  }

  It 'rejects a caller-authored proof receipt and artifact input before proof execution' {
    $input=[ordered]@{schemaVersion='revit-operator.safe-read-package-build-input.v3';releaseId='fabricated';allowedSignerThumbprints=@($testThumbprint);runtimeAttestation=[ordered]@{state='active';issued_at_utc='2030-01-01T00:00:00.000Z';expires_at_utc='2030-01-01T00:05:00.000Z';route_id='safe_read.sheet_count.v1';route_contract_sha256='sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874';policy_sha256='sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67';executor_id='revit-operator.safe-read-host.v1'};targets=@([ordered]@{proofReceiptPath='hand-authored.json';sourceDll='overlay.dll'})}
    $path=Join-Path $TestDrive 'fabricated-input.json';Write-JsonFile $path $input;$output=Join-Path $TestDrive 'build-output';[IO.Directory]::CreateDirectory($output)|Out-Null
    Assert-ThrowsLike {&$builder -InputManifestPath $path -OutputRoot $output -SignFileAction {}} '*extra properties*'
  }

  It 'invokes only the canonical production proof check and strict PE equivalence seam' {
    $text=Get-Content -LiteralPath $builder -Raw
    foreach($required in 'production\New-ProductionManifest.ps1',' check --manifest ',' equivalence --unsigned-artifact ','HEAD^{commit}',' archive --format=zip '){if(-not $text.Contains($required)){throw "Builder omits $required"}}
    foreach($forbidden in ' fingerprint ','ManagedCodeInspector','sourceDll','BuildInvoker'){if($text.Contains($forbidden)){throw "Builder retains forbidden trust seam $forbidden"}}
  }

  It 'rejects pre-tampered proof source instead of snapshotting a writable working tree' {
    $repository=Join-Path $TestDrive 'tampered-source';$proof=Join-Path $repository 'apps\revit-safe-read-proof';$hostSourceDir=Join-Path $repository 'apps\revit-safe-read-host';[IO.Directory]::CreateDirectory($proof)|Out-Null;[IO.Directory]::CreateDirectory($hostSourceDir)|Out-Null
    [IO.File]::WriteAllText((Join-Path $proof 'marker.txt'),'committed');[IO.File]::WriteAllText((Join-Path $hostSourceDir 'marker.txt'),'committed');& git -C $repository init --quiet;& git -C $repository add -- apps;& git -C $repository -c user.name=SafeRead -c user.email=saferead@example.invalid commit --quiet -m fixture
    if($LASTEXITCODE -ne 0){throw 'Failed to create the committed source attack fixture.'};[IO.File]::WriteAllText((Join-Path $proof 'marker.txt'),'tampered')
    $output=Join-Path $TestDrive 'tampered-source-output';[IO.Directory]::CreateDirectory($output)|Out-Null
    Assert-ThrowsLike {&$builder -InputManifestPath (Join-Path $PSScriptRoot 'fixtures\saferead-package-build-input.v3.json') -OutputRoot $output -RepositoryRoot $repository -SignFileAction {}} '*must match their exact committed Git tree*'
  }

  It 'rejects a targets junction before reading package metadata' {
    $root=Join-Path $TestDrive 'junction-package';$elsewhere=Join-Path $TestDrive 'junction-target';[IO.Directory]::CreateDirectory($root)|Out-Null;[void](Protect-SafeReadPathAcl $root -Strict);[IO.Directory]::CreateDirectory($elsewhere)|Out-Null;New-Item -ItemType Junction -Path (Join-Path $root 'targets') -Target $elsewhere|Out-Null
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $root -AttestationPinSha256 ('sha256:'+('0'*64)) -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*reparse point*'
  }

  It 'rejects foreign ownership and every untrusted write-capable ACE' {
    Assert-ThrowsLike {Assert-SafeReadAclRecord ([pscustomobject]@{OwnerSid='S-1-5-21-999';Access=@()}) 'foreign'} '*foreign owner*'
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-ThrowsLike {Assert-SafeReadAclRecord ([pscustomobject]@{OwnerSid=$owner;Protected=$true;Access=@([pscustomobject]@{Sid='S-1-5-21-123-456-789-4242';Type='Allow';Rights=[int64][Security.AccessControl.FileSystemRights]::Modify;IsInherited=$false})}) 'arbitrary'} '*untrusted principal*'
    Assert-ThrowsLike {Assert-SafeReadStrictAclRecord ([pscustomobject]@{OwnerSid=$owner;Protected=$false;Access=@([pscustomobject]@{Sid=$owner;Type='Allow';Rights=[int64][Security.AccessControl.FileSystemRights]::Modify;IsInherited=$true})}) 'inherited'} '*inherits ACLs*'
  }

  It 'canonicalizes assembly references identically by ordinal full identity' {
    $references=@((New-Identity 'zeta' '1.0.0.0' 'bbbbbbbbbbbbbbbb'),(New-Identity 'Alpha' '2.0.0.0' 'aaaaaaaaaaaaaaaa'),(New-Identity 'Alpha' '1.0.0.0' 'aaaaaaaaaaaaaaaa'))
    $actual=@(ConvertTo-SafeReadCanonicalAssemblyReferences $references|ForEach-Object{Get-SafeReadAssemblyIdentityKey $_})
    $expected=@('Alpha, Version=1.0.0.0, Culture=neutral, PublicKeyToken=aaaaaaaaaaaaaaaa','Alpha, Version=2.0.0.0, Culture=neutral, PublicKeyToken=aaaaaaaaaaaaaaaa','zeta, Version=1.0.0.0, Culture=neutral, PublicKeyToken=bbbbbbbbbbbbbbbb')
    if(Compare-Object $expected $actual -SyncWindow 0){throw 'Assembly reference canonical order is unstable.'}
  }

  It 'hardens installed payload ACLs to owner SYSTEM and Administrators only' {
    $path=Join-Path $TestDrive 'acl';[IO.Directory]::CreateDirectory($path)|Out-Null;[void](Protect-SafeReadPathAcl $path -Strict);$record=Get-SafeReadAclRecord $path;$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    foreach($ace in @($record.Access)){if($allowed -cnotcontains $ace.Sid -or $ace.IsInherited){throw "Unsafe hardened ACL $($ace.Sid)."}}
  }

  It 'installs the attestation parent and files with the host exact ACL contract' {
    $destination=Join-Path $TestDrive 'attestation-install';$addins=Join-Path $TestDrive 'attestation-addins'
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    $installedSource=Join-Path $destination "releases\$($bundle.ReleaseId)\source.snapshot.receipt.json";if((Get-SafeReadSha256 $installedSource) -cne (Get-SafeReadSha256 (Join-Path $bundle.Root 'source.snapshot.receipt.json'))){throw 'Install did not preserve the exact source receipt.'}
    $payload=Join-Path $destination "releases\$($bundle.ReleaseId)\targets\2024\payload";$paths=@($destination,(Join-Path $destination 'active-release.json'),$installedSource,$payload,(Join-Path $payload 'safe_read_runtime_attestation.v1.json'),(Join-Path $payload 'safe_read_runtime_attestation.v1.sha256'),(Join-Path $addins '2023'),(Join-Path $addins '2023\RevitOperator.SafeReadHost.addin'),(Join-Path $addins '2024'),(Join-Path $addins '2024\RevitOperator.SafeReadHost.addin'),(Join-Path $addins '2025'),(Join-Path $addins '2025\RevitOperator.SafeReadHost.addin'))
    $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')|Sort-Object
    foreach($path in $paths){$record=Get-SafeReadAclRecord $path;if(-not $record.Protected){throw "Installed host trust path inherits ACLs: $path"};$principals=@($record.Access|ForEach-Object Sid|Sort-Object -Unique);if((Compare-Object $allowed $principals) -or @($record.Access|Where-Object{$_.Type -cne 'Allow' -or $_.IsInherited}).Count){throw "Installed host trust path differs from the owner/SYSTEM/Administrators contract: $path"}}
  }

  It 'hardens pre-existing live year parents without broad-root recursion' {
    $destination=Join-Path $TestDrive 'existing-parent-install';$addins=Join-Path $TestDrive 'existing-parent-addins';[IO.Directory]::CreateDirectory($addins)|Out-Null;[void](Protect-SafeReadPathAcl $addins -Strict)
    foreach($year in '2023','2024','2025'){$yearPath=Join-Path $addins $year;[IO.Directory]::CreateDirectory($yearPath)|Out-Null;& icacls.exe $yearPath /grant '*S-1-5-32-545:(OI)(CI)(M)'|Out-Null;if($LASTEXITCODE -ne 0){throw 'Failed to create the inherited/foreign live-parent ACL fixture.'}}
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    foreach($year in '2023','2024','2025'){
      $yearPath=Join-Path $addins $year
      [void](Assert-SafeReadStrictAclRecord (Get-SafeReadAclRecord $yearPath) $yearPath)
      [void](Assert-SafeReadStrictTree (Join-Path $yearPath 'RevitOperator.SafeReadHost.addin'))
    }
  }

  It 'rejects a foreign Modify ACE before rollback reads active state' {
    $destination=Join-Path $TestDrive 'tampered-install';$addins=Join-Path $TestDrive 'tampered-addins'
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    $active=Join-Path $destination 'active-release.json';& icacls.exe $active /grant '*S-1-5-32-545:(M)'|Out-Null;if($LASTEXITCODE -ne 0){throw 'Failed to inject the foreign Modify ACE fixture.'}
    Assert-ThrowsLike {&$installer -RollbackReleaseId $bundle.ReleaseId -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*untrusted principal*'
  }

  It 'rejects dependency version and public key token mismatches' {
    $hostPayload=[pscustomobject]@{assembly=[pscustomobject]@{name='Host';version='1.0.0.0';culture='neutral';publicKeyToken='null';references=@(New-Identity 'Third.Party' '1.0.0.0' 'aaaaaaaaaaaaaaaa')}}
    $dependency=[pscustomobject]@{assembly=[pscustomobject]@{name='Third.Party';version='0.9.0.0';culture='neutral';publicKeyToken='aaaaaaaaaaaaaaaa';references=@()}}
    Assert-ThrowsLike {Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'} '*dependency identity mismatch*'
    $dependency.assembly.version='2.0.0.0'
    Assert-ThrowsLike {Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'} '*dependency identity mismatch*'
    $dependency.assembly.publicKeyToken='bbbbbbbbbbbbbbbb'
    Assert-ThrowsLike {Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'} '*dependency identity mismatch*'
  }

  It 'neither requires nor accepts an unreferenced AccessControl payload' {
    $receipt=Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    if(@($receipt.Targets|ForEach-Object requiredPayload|Where-Object role -eq 'runtime_dependency').Count){throw 'The exact fixture unexpectedly requires a runtime dependency.'}
    $releasePath=Join-Path $bundle.Root 'release-manifest.json';$release=ConvertTo-SafeReadObject $releasePath;$target=@($release.targets|Where-Object revitYear -eq '2024')[0]
    $path=Join-Path $bundle.Root 'targets\2024\payload\System.IO.FileSystem.AccessControl.dll';[IO.File]::WriteAllText($path,'unreferenced-access-control')
    $facts=Get-FakeFacts '2024' 'System.IO.FileSystem.AccessControl';$assembly=[ordered]@{name=$facts.Name;version=$facts.Version;culture=$facts.Culture;publicKeyToken=$facts.PublicKeyToken;targetFramework=$facts.TargetFramework;platform=$facts.Platform;mvid=$facts.Mvid;references=$facts.AssemblyReferences}
    $target.requiredPayload=@($target.requiredPayload)+@([ordered]@{path='payload/System.IO.FileSystem.AccessControl.dll';role='runtime_dependency';revitApiBound=$false;sha256=Get-SafeReadSha256 $path;sizeBytes=(Get-Item $path).Length;assembly=$assembly;provenance=$null})
    Write-JsonFile $releasePath $release;Refresh-BundlePin $bundle
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*unreferenced runtime dependency*'
  }

  It 'uses equivalence evidence to reject an overlay despite refreshed package hashes' {
    $path=Join-Path $bundle.Root 'targets\2024\payload\RevitOperator.SafeReadCertifiedExecution.dll';[IO.File]::AppendAllText($path,'arbitrary-overlay');Rebind-TamperedExecutor $bundle '2024'
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*equivalence receipt does not bind*'
  }

  It 'serializes installers through one cross-process Global mutex' {
    $signal=Join-Path $TestDrive 'mutex-held';$encodedPath=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($signal));$code="`$m=[Threading.Mutex]::new(`$false,'Global\RevitOperator.SafeRead.PackageActivation.v3');`$h=`$m.WaitOne();[IO.File]::WriteAllText([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$encodedPath')),'held');Start-Sleep -Seconds 3;`$m.ReleaseMutex();`$m.Dispose()";$process=Start-Process -FilePath (Get-Command pwsh).Source -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command',$code) -PassThru -WindowStyle Hidden
    $deadline=[datetime]::UtcNow.AddSeconds(5);while(-not(Test-Path $signal) -and [datetime]::UtcNow -lt $deadline){Start-Sleep -Milliseconds 25};if(-not(Test-Path $signal)){throw 'Mutex holder did not start.'}
    Assert-ThrowsLike {&$installer -RollbackReleaseId 'none' -DestinationRoot (Join-Path $TestDrive 'concurrent-dest') -RevitAddinsRoot (Join-Path $TestDrive 'concurrent-addins') -ActivationLockTimeoutMilliseconds 100} '*machine-wide*'
    $process.WaitForExit()
  }

  It 'installs two releases and performs a verified rollback' {
    $destination=Join-Path $TestDrive 'install';$addins=Join-Path $TestDrive 'addins';$second=New-TestBundle (Join-Path $TestDrive 'second') 'safe-read-v3-b'
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    &$installer -BundleRoot $second.Root -AttestationPinSha256 $second.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    &$installer -RollbackReleaseId $bundle.ReleaseId -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    $active=ConvertTo-SafeReadObject (Join-Path $destination 'active-release.json');if($active.releaseId -cne $bundle.ReleaseId){throw 'Rollback did not activate the original release.'}
    foreach($path in @((Join-Path $destination 'active-release.json'),(Join-Path $addins '2023'),(Join-Path $addins '2023\RevitOperator.SafeReadHost.addin'),(Join-Path $addins '2024'),(Join-Path $addins '2024\RevitOperator.SafeReadHost.addin'),(Join-Path $addins '2025'),(Join-Path $addins '2025\RevitOperator.SafeReadHost.addin'))){[void](Assert-SafeReadStrictTree $path)}
  }

  It 'rejects rollback when the installed source snapshot receipt was tampered' {
    $destination=Join-Path $TestDrive 'source-tamper-install';$addins=Join-Path $TestDrive 'source-tamper-addins';$second=New-TestBundle (Join-Path $TestDrive 'source-tamper-second') 'safe-read-v3-source-tamper-b'
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    &$installer -BundleRoot $second.Root -AttestationPinSha256 $second.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    [IO.File]::AppendAllText((Join-Path $destination "releases\$($bundle.ReleaseId)\source.snapshot.receipt.json"),'tampered')
    Assert-ThrowsLike {&$installer -RollbackReleaseId $bundle.ReleaseId -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*source receipt hash/size/path mismatch*'
  }
}
