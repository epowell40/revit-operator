BeforeAll {
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
$deployRoot=(Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$module=Join-Path $deployRoot 'SafeReadPackageV2.psm1';Import-Module $module -Force
$builder=Join-Path $deployRoot 'build_saferead_package_v2.ps1'
$installer=Join-Path $deployRoot 'install_saferead_package_v2.ps1'
$verifier=Join-Path $deployRoot 'verify_saferead_microhost_bundle.ps1'
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

function New-TestBundle([string]$Root,[string]$ReleaseId='safe-read-v3-a'){
  [IO.Directory]::CreateDirectory($Root)|Out-Null
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
    if($expected.Framework -eq 'net48'){
      $aclPath=Join-Path $payloadRoot 'System.IO.FileSystem.AccessControl.dll';[IO.File]::WriteAllText($aclPath,"access-control-$year")
      $aclFacts=Get-FakeFacts $year 'System.IO.FileSystem.AccessControl';$aclAssembly=[ordered]@{name=$aclFacts.Name;version=$aclFacts.Version;culture=$aclFacts.Culture;publicKeyToken=$aclFacts.PublicKeyToken;targetFramework=$aclFacts.TargetFramework;platform=$aclFacts.Platform;mvid=$aclFacts.Mvid;references=$aclFacts.AssemblyReferences}
      $payload += [ordered]@{path='payload/System.IO.FileSystem.AccessControl.dll';role='runtime_dependency';revitApiBound=$false;sha256=Get-SafeReadSha256 $aclPath;sizeBytes=(Get-Item $aclPath).Length;assembly=$aclAssembly;provenance=$null}
    }
    $template=Join-Path $manifestRoot 'RevitOperator.SafeReadHost.addin.template';Copy-Item -LiteralPath (Join-Path $deployRoot '..\..\apps\revit-safe-read-host\addin\RevitOperator.SafeReadHost.addin.template') -Destination $template
    $apiIdentity=New-Identity 'RevitAPI' "$major.0.0.0";$uiIdentity=New-Identity 'RevitAPIUI' "$major.0.0.0";$api=[ordered]@{contentSha256=('sha256:'+('8'*64));mvid=("$major".PadLeft(8,'0')+'-0000-0000-0000-000000000001');identity=$apiIdentity};$apiUi=[ordered]@{contentSha256=('sha256:'+('9'*64));mvid=("$major".PadLeft(8,'0')+'-0000-0000-0000-000000000002');identity=$uiIdentity}
    $executor=$payload[1];$runtime=[ordered]@{schema=[string]$contract.schemas.runtime_attestation;state='active';issued_at_utc='2030-01-01T00:00:00.000Z';expires_at_utc='2030-01-01T00:05:00.000Z';route_id=[string]$contract.route.route_id;route_contract_sha256=[string]$contract.route.route_contract_sha256;policy_sha256=[string]$contract.route.policy_sha256;proof_sha256=$proofSha;executor_id=[string]$contract.identity.executor_id;runtime_tuple=[ordered]@{host_content_sha256=$executor.sha256;host_mvid=$executor.assembly.mvid;revit_api_content_sha256=$api.contentSha256;revit_api_mvid=$api.mvid;revit_version=$year}}
    $runtimePath=Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.json';Write-JsonFile $runtimePath $runtime;$runtimePin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $payloadRoot 'safe_read_runtime_attestation.v1.sha256'),$runtimePin+"`n",[Text.UTF8Encoding]::new($false))
    $targets += [ordered]@{revitYear=$year;framework=$expected.Framework;platform='x64';revitApi=$api;revitApiUi=$apiUi;requiredPayload=$payload;proof=[ordered]@{path='proof/proof.receipt.json';sha256=$proofSha;sizeBytes=(Get-Item $proofPath).Length;artifactUnsignedSha256=[string]$artifacts[$year].sha256;equivalencePath='proof/artifact.equivalence.json';equivalenceSha256=Get-SafeReadSha256 $equivalencePath};runtimeAttestation=[ordered]@{path='payload/safe_read_runtime_attestation.v1.json';sha256=$runtimePin;sizeBytes=(Get-Item $runtimePath).Length};manifest=[ordered]@{path='manifest/RevitOperator.SafeReadHost.addin.template';sha256=Get-SafeReadSha256 $template;sizeBytes=(Get-Item $template).Length}}
    $pinTargets += [ordered]@{revitYear=$year;runtimeAttestationSha256=$runtimePin}
  }
  $release=[ordered]@{schemaVersion='revit-operator.safe-read-package-release.v3';releaseId=$ReleaseId;allowedSignerThumbprints=@($testThumbprint);targets=$targets};$releasePath=Join-Path $Root 'release-manifest.json';Write-JsonFile $releasePath $release
  $pins=[ordered]@{schemaVersion='revit-operator.safe-read-package-pins.v3';releaseId=$ReleaseId;releaseManifestSha256=Get-SafeReadSha256 $releasePath;targets=$pinTargets};$pinsPath=Join-Path $Root 'package-pins.json';Write-JsonFile $pinsPath $pins
  [pscustomobject]@{Root=$Root;Pin=Get-SafeReadSha256 $pinsPath;ReleaseId=$ReleaseId}
}

function Refresh-BundlePin($Bundle){$pins=ConvertTo-SafeReadObject (Join-Path $Bundle.Root 'package-pins.json');$pins.releaseManifestSha256=Get-SafeReadSha256 (Join-Path $Bundle.Root 'release-manifest.json');Write-JsonFile (Join-Path $Bundle.Root 'package-pins.json') $pins;$Bundle.Pin=Get-SafeReadSha256 (Join-Path $Bundle.Root 'package-pins.json')}
function Rebind-TamperedExecutor($Bundle,[string]$Year){$releasePath=Join-Path $Bundle.Root 'release-manifest.json';$release=ConvertTo-SafeReadObject $releasePath;$target=@($release.targets|Where-Object revitYear -eq $Year)[0];$executor=@($target.requiredPayload|Where-Object role -eq 'certified_executor')[0];$path=Join-Path $Bundle.Root "targets\$Year\payload\RevitOperator.SafeReadCertifiedExecution.dll";$executor.sha256=Get-SafeReadSha256 $path;$executor.sizeBytes=(Get-Item $path).Length;$runtimePath=Join-Path $Bundle.Root "targets\$Year\payload\safe_read_runtime_attestation.v1.json";$runtime=ConvertTo-SafeReadObject $runtimePath;$runtime.runtime_tuple.host_content_sha256=$executor.sha256;Write-JsonFile $runtimePath $runtime;$pin=Get-SafeReadSha256 $runtimePath;[IO.File]::WriteAllText((Join-Path $Bundle.Root "targets\$Year\payload\safe_read_runtime_attestation.v1.sha256"),$pin+"`n",[Text.UTF8Encoding]::new($false));$target.runtimeAttestation.sha256=$pin;$target.runtimeAttestation.sizeBytes=(Get-Item $runtimePath).Length;Write-JsonFile $releasePath $release;$pins=ConvertTo-SafeReadObject (Join-Path $Bundle.Root 'package-pins.json');@($pins.targets|Where-Object revitYear -eq $Year)[0].runtimeAttestationSha256=$pin;Write-JsonFile (Join-Path $Bundle.Root 'package-pins.json') $pins;Refresh-BundlePin $Bundle}
}

Describe 'SafeRead package v3 security contract' {
  BeforeEach{$bundle=New-TestBundle (Join-Path $TestDrive ([guid]::NewGuid().ToString('N')))}

  It 'accepts an exact three-year package and one identical proof receipt' {
    $receipt=Assert-SafeReadBundle -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    if($receipt.Targets.Count -ne 3){throw 'Expected three targets.'}
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
    foreach($required in 'production\New-ProductionManifest.ps1',' check --manifest ',' equivalence --unsigned-artifact '){if(-not $text.Contains($required)){throw "Builder omits $required"}}
    foreach($forbidden in ' fingerprint ','ManagedCodeInspector','sourceDll','BuildInvoker'){if($text.Contains($forbidden)){throw "Builder retains forbidden trust seam $forbidden"}}
  }

  It 'rejects a targets junction before reading package metadata' {
    $root=Join-Path $TestDrive 'junction-package';$elsewhere=Join-Path $TestDrive 'junction-target';[IO.Directory]::CreateDirectory($root)|Out-Null;[IO.Directory]::CreateDirectory($elsewhere)|Out-Null;New-Item -ItemType Junction -Path (Join-Path $root 'targets') -Target $elsewhere|Out-Null
    Assert-ThrowsLike {Assert-SafeReadBundle -BundleRoot $root -AttestationPinSha256 ('sha256:'+('0'*64)) -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector} '*reparse point*'
  }

  It 'rejects a foreign owner record and broad write ACE' {
    Assert-ThrowsLike {Assert-SafeReadAclRecord ([pscustomobject]@{OwnerSid='S-1-5-21-999';Access=@()}) 'foreign'} '*foreign owner*'
    $owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Assert-ThrowsLike {Assert-SafeReadAclRecord ([pscustomobject]@{OwnerSid=$owner;Access=@([pscustomobject]@{Sid='S-1-1-0';Type='Allow';Rights=[int64][Security.AccessControl.FileSystemRights]::Write;IsInherited=$false})}) 'broad'} '*broad principal*'
  }

  It 'hardens installed payload ACLs to owner SYSTEM and Administrators only' {
    $path=Join-Path $TestDrive 'acl';[IO.Directory]::CreateDirectory($path)|Out-Null;[void](Protect-SafeReadPathAcl $path -Strict);$record=Get-SafeReadAclRecord $path;$allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    foreach($ace in @($record.Access)){if($allowed -cnotcontains $ace.Sid -or $ace.IsInherited){throw "Unsafe hardened ACL $($ace.Sid)."}}
  }

  It 'installs the attestation parent and files with the host exact ACL contract' {
    $destination=Join-Path $TestDrive 'attestation-install';$addins=Join-Path $TestDrive 'attestation-addins'
    &$installer -BundleRoot $bundle.Root -AttestationPinSha256 $bundle.Pin -DestinationRoot $destination -RevitAddinsRoot $addins -SignatureVerifier $signatureVerifier -AssemblyInspector $assemblyInspector
    $payload=Join-Path $destination "releases\$($bundle.ReleaseId)\targets\2024\payload";$paths=@($payload,(Join-Path $payload 'safe_read_runtime_attestation.v1.json'),(Join-Path $payload 'safe_read_runtime_attestation.v1.sha256'))
    $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')|Sort-Object
    foreach($path in $paths){$record=Get-SafeReadAclRecord $path;if(-not $record.Protected){throw "Installed host trust path inherits ACLs: $path"};$principals=@($record.Access|ForEach-Object Sid|Sort-Object -Unique);if((Compare-Object $allowed $principals) -or @($record.Access|Where-Object{$_.Type -cne 'Allow' -or $_.IsInherited}).Count){throw "Installed host trust path differs from the owner/SYSTEM/Administrators contract: $path"}}
  }

  It 'rejects dependency version and public key token mismatches' {
    $hostPayload=[pscustomobject]@{assembly=[pscustomobject]@{name='Host';version='1.0.0.0';culture='neutral';publicKeyToken='null';references=@(New-Identity 'Third.Party' '1.0.0.0' 'aaaaaaaaaaaaaaaa')}}
    $dependency=[pscustomobject]@{assembly=[pscustomobject]@{name='Third.Party';version='0.9.0.0';culture='neutral';publicKeyToken='aaaaaaaaaaaaaaaa';references=@()}}
    Assert-ThrowsLike {Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'} '*dependency identity mismatch*'
    $dependency.assembly.version='2.0.0.0'
    Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'
    $dependency.assembly.publicKeyToken='bbbbbbbbbbbbbbbb'
    Assert-ThrowsLike {Assert-SafeReadDependencyClosure @($hostPayload,$dependency) 'net48' '2024'} '*dependency identity mismatch*'
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
  }
}
