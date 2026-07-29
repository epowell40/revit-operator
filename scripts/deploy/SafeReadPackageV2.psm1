Set-StrictMode -Version Latest

$script:ReleaseSchema = 'revit-operator.safe-read-package-release.v2'
$script:PinsSchema = 'revit-operator.safe-read-package-pins.v2'
$script:RuntimeAttestationSchema = 'revit-operator.safe-read-runtime-attestation.v1'
$script:HostDll = 'RevitOperator.SafeReadHost.dll'
$script:CertifiedExecutorDll = 'RevitOperator.SafeReadCertifiedExecution.dll'
$script:RuntimeAttestationName = 'safe_read_runtime_attestation.v1.json'
$script:RuntimeAttestationPinName = 'safe_read_runtime_attestation.v1.sha256'
$script:RouteId = 'safe_read.sheet_count.v1'
$script:RouteContractSha256 = 'sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874'
$script:PolicySha256 = 'sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67'
$script:ExecutorId = 'revit-operator.safe-read-host.v1'
$script:TemplateName = 'RevitOperator.SafeReadHost.addin.template'
$script:InstalledManifestName = 'RevitOperator.SafeReadHost.addin'
$script:AssemblyToken = '{{ASSEMBLY_PATH}}'
$script:Identity = [ordered]@{
  Name = 'Revit Operator Safe Read Host'
  AddInId = 'AAFAA2C0-43F1-42A0-A6B4-D9A0C5F5CE0E'
  FullClassName = 'RevitOperator.SafeReadHost.App'
  VendorId = 'BIMT'
  VendorDescription = 'BIMTools Revit Operator Safe Read Host'
}

function Get-SafeReadSha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  'sha256:{0}' -f (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-SafeReadObject {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $json=Get-Content -LiteralPath $Path -Raw
  if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$json|ConvertFrom-Json -DateKind String}else{$json|ConvertFrom-Json}
}

function ConvertTo-SafeReadCanonicalJson {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject)
  $InputObject | ConvertTo-Json -Depth 16 -Compress
}

function ConvertTo-SafeReadHashtable {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject)
  $result = [ordered]@{}
  foreach ($property in $InputObject.PSObject.Properties) {
    if ($property.Value -is [System.Management.Automation.PSCustomObject]) {
      $result[$property.Name] = ConvertTo-SafeReadHashtable $property.Value
    } elseif ($property.Value -is [System.Collections.IEnumerable] -and $property.Value -isnot [string]) {
      $result[$property.Name] = @($property.Value | ForEach-Object {
        if ($_ -is [System.Management.Automation.PSCustomObject]) { ConvertTo-SafeReadHashtable $_ } else { $_ }
      })
    } else { $result[$property.Name] = $property.Value }
  }
  $result
}

function Get-SafeReadExpectedTarget {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$RevitYear)
  switch ($RevitYear) {
    '2023' { @{ Framework = 'net48'; TargetFrameworkAttribute = '.NETFramework,Version=v4.8'; RevitApiMajor = 23 } }
    '2024' { @{ Framework = 'net48'; TargetFrameworkAttribute = '.NETFramework,Version=v4.8'; RevitApiMajor = 24 } }
    '2025' { @{ Framework = 'net8.0-windows'; TargetFrameworkAttribute = '.NETCoreApp,Version=v8.0'; RevitApiMajor = 25 } }
    default { throw "Unsupported SafeRead Revit year '$RevitYear'." }
  }
}

function Assert-SafeReadReleaseId {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$ReleaseId)
  if ($ReleaseId -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$') { throw "SafeRead releaseId is invalid: $ReleaseId" }
}

function Assert-SafeReadRelativePath {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  if ([IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.([\\/]|$)' -or $Path -match ':' -or $Path -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*(?:/[A-Za-z0-9][A-Za-z0-9._-]*)*$') {
    throw "Unsafe SafeRead relative path: $Path"
  }
}

function Assert-SafeReadExactProperties {
  param([Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string[]]$Expected,[Parameter(Mandatory)][string]$Location)
  $actual=@($Value.PSObject.Properties.Name)
  if(($actual -join '|') -cne ($Expected -join '|')){throw "$Location has missing, reordered, or extra properties."}
}

function Get-SafeReadAssemblyFacts {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  # Windows PowerShell 5.1 does not ship System.Reflection.Metadata/PEReader.
  # ReflectionOnlyLoad reads metadata without executing the assembly; the TFM and
  # PE machine are read directly from the image so net8 assemblies remain inspectable.
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $facts=Invoke-SafeReadDesktopAssemblyInspector $resolved
    return [pscustomobject]@{Name=$facts.Name;TargetFramework=$facts.TargetFramework;Platform=$facts.Platform;Mvid=$facts.Mvid;RevitApiReferenceVersion=$facts.RevitApiReferenceVersion;AssemblyReferences=@($facts.AssemblyReferences)}
  }
  $stream = [IO.File]::OpenRead($resolved)
  $pe = $null
  try {
    $pe = [System.Reflection.PortableExecutable.PEReader]::new($stream)
    if (-not $pe.HasMetadata) { throw "SafeRead payload is not a managed assembly: $resolved" }
    $metadata = [System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe); $definition = $metadata.GetAssemblyDefinition(); $module = $metadata.GetModuleDefinition()
    $targetFramework = $null
    foreach ($attributeHandle in $definition.GetCustomAttributes()) {
      $attribute = $metadata.GetCustomAttribute($attributeHandle)
      if ($attribute.Constructor.Kind -ne [Reflection.Metadata.HandleKind]::MemberReference) { continue }
      $member = $metadata.GetMemberReference($attribute.Constructor)
      if ($member.Parent.Kind -ne [Reflection.Metadata.HandleKind]::TypeReference) { continue }
      $type = $metadata.GetTypeReference($member.Parent)
      if ($metadata.GetString($type.Namespace) -eq 'System.Runtime.Versioning' -and $metadata.GetString($type.Name) -eq 'TargetFrameworkAttribute') {
        $blob = $metadata.GetBlobReader($attribute.Value)
        if ($blob.ReadUInt16() -ne 1) { throw "Invalid target framework attribute: $resolved" }
        $targetFramework = $blob.ReadSerializedString()
      }
    }
    $revitApi = @()
    foreach ($referenceHandle in $metadata.AssemblyReferences) {
      $reference = $metadata.GetAssemblyReference($referenceHandle)
      if ($metadata.GetString($reference.Name) -eq 'RevitAPI') { $revitApi += $reference.Version.ToString() }
    }
    [pscustomobject]@{
      Name = $metadata.GetString($definition.Name)
      TargetFramework = $targetFramework
      Platform = [string]$pe.PEHeaders.CoffHeader.Machine
      Mvid = $metadata.GetGuid($module.Mvid).ToString('D').ToLowerInvariant()
      RevitApiReferenceVersion = if ($revitApi.Count -eq 1) { $revitApi[0] } else { $null }
      AssemblyReferences = @($metadata.AssemblyReferences | ForEach-Object { $metadata.GetString($metadata.GetAssemblyReference($_).Name) } | Sort-Object -Unique)
    }
  } finally {
    if ($pe) { $pe.Dispose() } else { $stream.Dispose() }
  }
}

function Get-SafeReadRevitApiFacts {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $facts=Invoke-SafeReadDesktopAssemblyInspector $resolved
    return [pscustomobject]@{ContentSha256=Get-SafeReadSha256 $resolved;Mvid=$facts.Mvid;AssemblyVersion=$facts.AssemblyVersion}
  }
  $stream=[IO.File]::OpenRead($resolved);$pe=$null
  try{$pe=[System.Reflection.PortableExecutable.PEReader]::new($stream);if(-not $pe.HasMetadata){throw "RevitAPI is not managed: $resolved"};$metadata=[System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);$definition=$metadata.GetAssemblyDefinition();$module=$metadata.GetModuleDefinition()
    [pscustomobject]@{ContentSha256=Get-SafeReadSha256 $resolved;Mvid=$metadata.GetGuid($module.Mvid).ToString('D').ToLowerInvariant();AssemblyVersion=$definition.Version.ToString()}
  }finally{if($pe){$pe.Dispose()}else{$stream.Dispose()}}
}

function Invoke-SafeReadDesktopAssemblyInspector {
  param([Parameter(Mandatory)][string]$Path)
  $pathBytes=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Path))
  $source=@"
`$ErrorActionPreference='Stop'
`$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$pathBytes'))
`$bytes=[IO.File]::ReadAllBytes(`$p);`$a=[Reflection.Assembly]::ReflectionOnlyLoad(`$bytes);`$text=[Text.Encoding]::UTF8.GetString(`$bytes)
`$tfms=@([regex]::Matches(`$text,'\.(?:NETFramework|NETStandard|NETCoreApp),Version=v\d+\.\d+(?:\.\d+)?')|ForEach-Object Value|Sort-Object -Unique);if(`$tfms.Count -gt 1){throw 'Assembly declares multiple target frameworks.'}
`$pe=[BitConverter]::ToInt32(`$bytes,0x3c);if(`$pe -lt 0 -or `$pe+6 -gt `$bytes.Length -or [BitConverter]::ToUInt32(`$bytes,`$pe) -ne 0x00004550){throw 'Invalid PE header.'};`$machine=[BitConverter]::ToUInt16(`$bytes,`$pe+4)
`$refs=@(`$a.GetReferencedAssemblies()|ForEach-Object Name|Sort-Object -Unique);`$revit=@(`$a.GetReferencedAssemblies()|Where-Object Name -ceq 'RevitAPI'|ForEach-Object{`$_.Version.ToString()})
[pscustomobject]@{Name=`$a.GetName().Name;AssemblyVersion=`$a.GetName().Version.ToString();TargetFramework=if(`$tfms.Count -eq 1){`$tfms[0]}else{`$null};Platform=if(`$machine -eq 0x8664){'Amd64'}elseif(`$machine -eq 0x014c){'I386'}else{'Unsupported'};Mvid=`$a.ManifestModule.ModuleVersionId.ToString('D').ToLowerInvariant();RevitApiReferenceVersion=if(`$revit.Count -eq 1){`$revit[0]}else{`$null};AssemblyReferences=`$refs}|ConvertTo-Json -Compress
"@
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
  $json=& (Join-Path $PSHOME 'powershell.exe') -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded 2>$null
  if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($json -join ''))){throw "SafeRead isolated metadata inspection failed: $Path"}
  ($json -join '')|ConvertFrom-Json
}

function Assert-SafeReadUtcInstant {
  param([Parameter(Mandatory)][string]$Value,[Parameter(Mandatory)][string]$Name)
  if ($Value -cnotmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$') { throw "SafeRead $Name must be UTC yyyy-MM-ddTHH:mm:ss.fffZ." }
  try { [datetimeoffset]::ParseExact($Value,"yyyy-MM-dd'T'HH:mm:ss.fff'Z'",[Globalization.CultureInfo]::InvariantCulture,[Globalization.DateTimeStyles]::AssumeUniversal) } catch { throw "SafeRead $Name must be UTC yyyy-MM-ddTHH:mm:ss.fffZ." }
}

function Get-SafeReadProofArtifact {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$ReceiptPath,[Parameter(Mandatory)][string]$RevitYear)
  $receiptPathResolved=(Resolve-Path -LiteralPath $ReceiptPath).Path
  $receipt=ConvertTo-SafeReadObject $receiptPathResolved
  Assert-SafeReadExactProperties $receipt @('schemaVersion','proofKind','mode','status','certified','manifestSha256','trustBoundary','compilerOptions','issues','observation','artifacts') 'SafeRead proof receipt'
  if ([int]$receipt.schemaVersion -ne 1 -or $receipt.proofKind -cne 'revit-safe-read-whole-assembly/v1' -or $receipt.mode -cne 'check' -or $receipt.status -cne 'verified' -or -not [bool]$receipt.certified -or @($receipt.issues).Count -ne 0) { throw "SafeRead proof receipt is not certified and verified: $receiptPathResolved" }
  $artifactProperty=@($receipt.artifacts.PSObject.Properties | Where-Object Name -ceq $RevitYear)
  if($artifactProperty.Count -ne 1){throw "SafeRead proof receipt has no exact artifact for Revit $RevitYear."}
  $artifact=$artifactProperty[0].Value
  Assert-SafeReadExactProperties $artifact @('fileName','sha256','length','assemblyIdentity','targetFramework','platform','managedCodeSha256') "SafeRead proof artifact $RevitYear"
  $expected=Get-SafeReadExpectedTarget $RevitYear
  $expectedFile="RevitOperator.SafeReadCertifiedExecution.Revit$RevitYear.dll"
  if($artifact.fileName -cne $expectedFile -or $artifact.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $artifact.managedCodeSha256 -cnotmatch '^[0-9a-f]{64}$' -or [int64]$artifact.length -le 0 -or $artifact.assemblyIdentity -cnotmatch '^RevitOperator\.SafeReadCertifiedExecution, Version=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -or $artifact.targetFramework -cne $expected.TargetFrameworkAttribute -or $artifact.platform -cne 'x64'){throw "SafeRead proof artifact contract is invalid for Revit $RevitYear."}
  $proofRoot=Split-Path -Parent $receiptPathResolved
  $names=@(Get-ChildItem -LiteralPath $proofRoot -Force | ForEach-Object Name | Sort-Object)
  $expectedNames=@('proof.receipt.json','RevitOperator.SafeReadCertifiedExecution.Revit2023.dll','RevitOperator.SafeReadCertifiedExecution.Revit2024.dll','RevitOperator.SafeReadCertifiedExecution.Revit2025.dll')|Sort-Object
  if(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $names){throw 'SafeRead proof output directory has missing or extra files.'}
  $assemblyPath=Join-Path $proofRoot $expectedFile
  $whole=(Get-SafeReadSha256 $assemblyPath).Substring(7)
  if($whole -cne $artifact.sha256 -or (Get-Item -LiteralPath $assemblyPath).Length -ne [int64]$artifact.length){throw "SafeRead verifier-emitted artifact hash/length mismatch for Revit $RevitYear."}
  [pscustomobject]@{ReceiptPath=$receiptPathResolved;ReceiptSha256=Get-SafeReadSha256 $receiptPathResolved;AssemblyPath=$assemblyPath;Artifact=$artifact}
}

function Test-SafeReadRuntimeProvidedAssembly {
  param([Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][string]$Framework)
  if($Name -in @('RevitAPI','RevitAPIUI')){return $true}
  if($Framework -eq 'net8.0-windows'){return $Name -eq 'System.Private.CoreLib' -or $Name -like 'System.*' -or $Name -like 'Microsoft.Win32.*'}
  $net48=@('mscorlib','Microsoft.CSharp','PresentationCore','PresentationFramework','WindowsBase','System','System.Core','System.Data','System.Drawing','System.Net.Http','System.Numerics','System.Runtime','System.Runtime.Serialization','System.Security','System.ServiceModel','System.Threading.Tasks','System.Transactions','System.Web','System.Xml','System.Xml.Linq')
  $net48 -ccontains $Name
}

function Test-SafeReadDependencyAssemblyCompatibility {
  param([AllowNull()][string]$TargetFramework,[Parameter(Mandatory)][string]$Platform,[Parameter(Mandatory)][string]$Framework)
  if($Platform -cnotin @('I386','Amd64')){return $false}
  if([string]::IsNullOrWhiteSpace($TargetFramework)){return $true}
  if($Framework -eq 'net8.0-windows'){return $TargetFramework -ceq '.NETCoreApp,Version=v8.0' -or $TargetFramework -ceq '.NETStandard,Version=v2.0'}
  $TargetFramework -cmatch '^\.NETFramework,Version=v4\.(?:6(?:\.1|\.2)?|7(?:\.1|\.2)?|8)$' -or $TargetFramework -ceq '.NETStandard,Version=v2.0'
}

function Assert-SafeReadDependencyClosure {
  param([Parameter(Mandatory)]$Payload,[Parameter(Mandatory)][string]$Framework,[Parameter(Mandatory)][string]$RevitYear)
  $names=@{};foreach($item in @($Payload)){if($names.ContainsKey([string]$item.assembly.name)){throw "SafeRead target $RevitYear duplicates assembly identity $($item.assembly.name)."};$names[[string]$item.assembly.name]=$true}
  foreach($item in @($Payload)){foreach($reference in @($item.assembly.references)){if(-not(Test-SafeReadRuntimeProvidedAssembly $reference $Framework)-and -not $names.ContainsKey([string]$reference)){throw "SafeRead target $RevitYear is missing runtime dependency $reference required by $($item.assembly.name)."}}}
}

function Get-SafeReadXml {
  [CmdletBinding(DefaultParameterSetName='Path')]
  param(
    [Parameter(Mandatory,ParameterSetName='Path')][string]$Path,
    [Parameter(Mandatory,ParameterSetName='Content')][string]$Content
  )
  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $source = if ($PSCmdlet.ParameterSetName -eq 'Path') { [IO.StreamReader]::new((Resolve-Path -LiteralPath $Path).Path) } else { [IO.StringReader]::new($Content) }
  $reader = $null
  try {
    $reader = [Xml.XmlReader]::Create($source, $settings)
    $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($reader); $document
  } finally { if ($reader) { $reader.Dispose() }; $source.Dispose() }
}

function Assert-SafeReadManifestXml {
  [CmdletBinding(DefaultParameterSetName='Path')]
  param(
    [Parameter(Mandatory,ParameterSetName='Path')][string]$Path,
    [Parameter(Mandatory,ParameterSetName='Content')][string]$Content,
    [Parameter(Mandatory)][string]$ExpectedAssembly
  )
  $xml = if ($PSCmdlet.ParameterSetName -eq 'Path') { Get-SafeReadXml -Path $Path } else { Get-SafeReadXml -Content $Content }
  if ($xml.DocumentElement.LocalName -ne 'RevitAddIns') { throw 'SafeRead manifest root must be RevitAddIns.' }
  $rootElements = @($xml.DocumentElement.ChildNodes | Where-Object NodeType -eq ([Xml.XmlNodeType]::Element))
  if ($rootElements.Count -ne 1 -or $rootElements[0].LocalName -ne 'AddIn') { throw 'SafeRead manifest must contain exactly one AddIn.' }
  $addin = $rootElements[0]
  if ($addin.GetAttribute('Type') -cne 'Application' -or $addin.Attributes.Count -ne 1) { throw 'SafeRead manifest AddIn must be exactly Type=Application.' }
  $expectedNames = @('Name','Assembly','FullClassName','AddInId','VendorId','VendorDescription')
  $children = @($addin.ChildNodes | Where-Object NodeType -eq ([Xml.XmlNodeType]::Element))
  if ($children.Count -ne 6 -or (@($children.LocalName) -join '|') -cne ($expectedNames -join '|')) { throw 'SafeRead manifest has missing, duplicate, reordered, or extra fields.' }
  $expected = [ordered]@{ Name=$script:Identity.Name; Assembly=$ExpectedAssembly; FullClassName=$script:Identity.FullClassName; AddInId=$script:Identity.AddInId; VendorId=$script:Identity.VendorId; VendorDescription=$script:Identity.VendorDescription }
  foreach ($name in $expectedNames) {
    $nodes = @($children | Where-Object LocalName -eq $name)
    if ($nodes.Count -ne 1 -or $nodes[0].InnerText -cne [string]$expected[$name] -or $nodes[0].Attributes.Count -ne 0) { throw "SafeRead manifest field '$name' is not the exact certified value." }
  }
  $xml
}

function New-SafeReadInstalledManifest {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$TemplatePath, [Parameter(Mandatory)][string]$AssemblyPath)
  $xml = Assert-SafeReadManifestXml -Path $TemplatePath -ExpectedAssembly $script:AssemblyToken
  $xml.SelectSingleNode('/RevitAddIns/AddIn/Assembly').InnerText = $AssemblyPath
  $settings = [Xml.XmlWriterSettings]::new(); $settings.Encoding = [Text.UTF8Encoding]::new($false); $settings.Indent = $true; $settings.OmitXmlDeclaration = $false
  $builder = [Text.StringBuilder]::new(); $writer = [Xml.XmlWriter]::Create($builder, $settings)
  try { $xml.Save($writer) } finally { $writer.Dispose() }
  $result = $builder.ToString(); [void](Assert-SafeReadManifestXml -Content $result -ExpectedAssembly $AssemblyPath); $result
}

function Invoke-SafeReadSignatureVerification {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string[]]$AllowedSignerThumbprints, [scriptblock]$SignatureVerifier)
  $result = if ($SignatureVerifier) { & $SignatureVerifier $Path } else {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    [pscustomobject]@{ Status=[string]$signature.Status; Thumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null} }
  }
  $thumbprint = ([string]$result.Thumbprint).Replace(' ','').ToUpperInvariant()
  $allowed = @($AllowedSignerThumbprints | ForEach-Object { ([string]$_).Replace(' ','').ToUpperInvariant() })
  if ([string]$result.Status -cne 'Valid' -or $allowed -notcontains $thumbprint) { throw "SafeRead payload signature or signer allowlist validation failed: $Path" }
}

function Assert-SafeReadBundle {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [scriptblock]$SignatureVerifier,
    [scriptblock]$AssemblyInspector
  )
  if ($AttestationPinSha256 -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'SafeRead attestation pin must be lowercase sha256:<hex>.' }
  $root = (Resolve-Path -LiteralPath $BundleRoot).Path
  $manifestPath = Join-Path $root 'release-manifest.json'; $pinsPath = Join-Path $root 'package-pins.json'
  foreach ($path in $manifestPath,$pinsPath) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SafeRead bundle is missing $(Split-Path -Leaf $path)." } }
  if ((Get-SafeReadSha256 $pinsPath) -cne $AttestationPinSha256) { throw 'SafeRead package pins external pin does not match this bundle.' }
  $release = ConvertTo-SafeReadObject $manifestPath; $pins = ConvertTo-SafeReadObject $pinsPath
  Assert-SafeReadExactProperties $release @('schemaVersion','releaseId','allowedSignerThumbprints','targets') 'SafeRead release manifest'
  Assert-SafeReadExactProperties $pins @('schemaVersion','releaseId','releaseManifestSha256','targets') 'SafeRead package pins'
  if ($release.schemaVersion -cne $script:ReleaseSchema -or $pins.schemaVersion -cne $script:PinsSchema) { throw 'Unsupported SafeRead package schema.' }
  Assert-SafeReadReleaseId ([string]$release.releaseId)
  if ($pins.releaseId -cne $release.releaseId -or $pins.releaseManifestSha256 -cne (Get-SafeReadSha256 $manifestPath)) { throw 'SafeRead package pins do not bind the exact release.' }
  $rootNames = @(Get-ChildItem -LiteralPath $root -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('package-pins.json','release-manifest.json','targets') -DifferenceObject $rootNames) { throw 'SafeRead bundle root has missing or extra entries.' }
  $targetNames = @(Get-ChildItem -LiteralPath (Join-Path $root 'targets') -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('2023','2024','2025') -DifferenceObject $targetNames) { throw 'SafeRead bundle has missing or extra target directories.' }
  $targets = @($release.targets); if ($targets.Count -ne 3) { throw 'SafeRead release must declare exactly three targets.' }
  $allowed = @($release.allowedSignerThumbprints); if ($allowed.Count -eq 0) { throw 'SafeRead signer allowlist is empty.' }
  $seen = @{}; $pinTargets=@($pins.targets)
  if ($pinTargets.Count -ne 3) { throw 'SafeRead package pins must contain exactly three targets.' }
  foreach ($target in $targets) {
    Assert-SafeReadExactProperties $target @('revitYear','framework','platform','revitApi','requiredPayload','proof','runtimeAttestation','manifest') 'SafeRead target'
    $year = [string]$target.revitYear; if ($seen.ContainsKey($year)) { throw "SafeRead target year is duplicated: $year" }; $seen[$year]=$true
    $expected = Get-SafeReadExpectedTarget $year
    if ($target.framework -cne $expected.Framework -or $target.platform -cne 'x64') { throw "SafeRead target $year has mixed framework/platform metadata." }
    $api = $target.revitApi
    Assert-SafeReadExactProperties $api @('contentSha256','mvid','assemblyVersion') "SafeRead target $year Revit API evidence"
    if ([int](([version]$api.assemblyVersion).Major) -ne $expected.RevitApiMajor -or $api.contentSha256 -cnotmatch '^sha256:[0-9a-f]{64}$' -or $api.mvid -cnotmatch '^[0-9a-f-]{36}$') { throw "SafeRead target $year has invalid Revit API evidence." }
    $payload = @($target.requiredPayload); if ($payload.Count -lt 2) { throw "SafeRead target $year has no loadable host/executor payload." }
    foreach ($declared in $payload) { Assert-SafeReadRelativePath ([string]$declared.path) }
    $hostPayload = @($payload | Where-Object { $_.role -ceq 'host' })
    if ($hostPayload.Count -ne 1 -or $hostPayload[0].path -cne "payload/$script:HostDll" -or -not [bool]$hostPayload[0].revitApiBound) { throw "SafeRead target $year does not contain exactly one SafeRead host payload." }
    $executorPayload = @($payload | Where-Object { $_.role -ceq 'certified_executor' })
    if ($executorPayload.Count -ne 1 -or $executorPayload[0].path -cne "payload/$script:CertifiedExecutorDll" -or -not [bool]$executorPayload[0].revitApiBound) { throw "SafeRead target $year does not contain exactly one certified executor payload." }
    foreach($other in @($payload|Where-Object role -cne 'host'|Where-Object role -cne 'certified_executor')){if($other.role -cne 'runtime_dependency' -or [bool]$other.revitApiBound){throw "SafeRead target $year has an unsupported payload role."}}
    $targetRoot = Join-Path $root "targets\$year"
    $expectedPaths = @($payload.path) + @("payload/$script:RuntimeAttestationName","payload/$script:RuntimeAttestationPinName",'proof/proof.receipt.json',"manifest/$script:TemplateName")
    $actualPaths = @(Get-ChildItem -LiteralPath $targetRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($targetRoot.Length).TrimStart([char]92,[char]47).Replace([char]92,[char]47) } | Sort-Object)
    if (Compare-Object -ReferenceObject @($expectedPaths | Sort-Object) -DifferenceObject $actualPaths) { throw "SafeRead target $year has missing or extra files." }
    foreach ($item in $payload) {
      Assert-SafeReadExactProperties $item @('path','role','revitApiBound','sha256','sizeBytes','assembly','provenance') "SafeRead target $year payload entry"
      Assert-SafeReadExactProperties $item.assembly @('name','targetFramework','platform','mvid','revitApiReferenceVersion','references') "SafeRead target $year payload assembly evidence"
      if ($item.path -cnotmatch '^payload/[A-Za-z0-9][A-Za-z0-9._-]*\.dll$') { throw "SafeRead payload path is not an exact DLL leaf: $($item.path)" }
      $path = Join-Path $targetRoot ($item.path.Replace('/', '\'))
      if ((Get-SafeReadSha256 $path) -cne $item.sha256 -or (Get-Item -LiteralPath $path).Length -ne [int64]$item.sizeBytes) { throw "SafeRead target $year payload hash/size mismatch: $($item.path)" }
      Invoke-SafeReadSignatureVerification -Path $path -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
      $facts = if ($AssemblyInspector) { & $AssemblyInspector $path $year $item } else { Get-SafeReadAssemblyFacts $path }
      if ($facts.Name -cne $item.assembly.name -or [string]$facts.TargetFramework -cne [string]$item.assembly.targetFramework -or $facts.Platform -cne $item.assembly.platform -or $facts.Mvid -cne $item.assembly.mvid) { throw "SafeRead target $year assembly facts do not match." }
      if($item.path -cne "payload/$($facts.Name).dll"){throw "SafeRead target $year payload filename does not match its exact assembly identity."}
      if($item.role -ceq 'host' -and $facts.Name -cne 'RevitOperator.SafeReadHost'){throw "SafeRead target $year host assembly identity is invalid."};if($item.role -ceq 'certified_executor' -and $facts.Name -cne 'RevitOperator.SafeReadCertifiedExecution'){throw "SafeRead target $year certified executor assembly identity is invalid."}
      if($item.role -cin @('host','certified_executor')){if($facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64'){throw "SafeRead target $year host/certified executor has wrong framework/platform."}}elseif(-not(Test-SafeReadDependencyAssemblyCompatibility ([string]$facts.TargetFramework) ([string]$facts.Platform) $expected.Framework)){throw "SafeRead target $year runtime dependency is not framework/platform compatible."}
      if ([bool]$item.revitApiBound) {
        if ([string]::IsNullOrWhiteSpace($facts.RevitApiReferenceVersion) -or ([version]$facts.RevitApiReferenceVersion).Major -ne $expected.RevitApiMajor -or $facts.RevitApiReferenceVersion -cne $item.assembly.revitApiReferenceVersion) { throw "SafeRead target $year contains a cross-year Revit API assembly reference." }
      }elseif(-not [string]::IsNullOrWhiteSpace([string]$facts.RevitApiReferenceVersion) -or @($facts.AssemblyReferences|Where-Object{$_ -cin @('RevitAPI','RevitAPIUI')}).Count){throw "SafeRead target $year runtime dependency may not reference RevitAPI/RevitAPIUI."}
      if($item.role -ceq 'certified_executor'){
        Assert-SafeReadExactProperties $item.provenance @('proofReceiptSha256','unsignedSha256','managedCodeSha256') "SafeRead target $year certified executor provenance"
        foreach($hash in $item.provenance.proofReceiptSha256,$item.provenance.unsignedSha256){if($hash -cnotmatch '^sha256:[0-9a-f]{64}$'){throw "SafeRead target $year executor provenance hash is invalid."}}
        if($item.provenance.managedCodeSha256 -cnotmatch '^[0-9a-f]{64}$'){throw "SafeRead target $year managed code hash is invalid."}
      }elseif($null -ne $item.provenance){throw "SafeRead target $year non-executor payload has proof provenance."}
    }
    Assert-SafeReadDependencyClosure $payload $expected.Framework $year
    $proofPath=Join-Path $targetRoot 'proof\proof.receipt.json'
    $proofReceipt=ConvertTo-SafeReadObject $proofPath
    Assert-SafeReadExactProperties $proofReceipt @('schemaVersion','proofKind','mode','status','certified','manifestSha256','trustBoundary','compilerOptions','issues','observation','artifacts') "SafeRead target $year preserved proof receipt"
    if([int]$proofReceipt.schemaVersion -ne 1 -or $proofReceipt.proofKind -cne 'revit-safe-read-whole-assembly/v1' -or $proofReceipt.mode -cne 'check' -or $proofReceipt.status -cne 'verified' -or -not [bool]$proofReceipt.certified -or @($proofReceipt.issues).Count -ne 0){throw "SafeRead target $year preserved proof receipt is not certified."}
    $preservedArtifactProperty=@($proofReceipt.artifacts.PSObject.Properties|Where-Object Name -ceq $year);if($preservedArtifactProperty.Count -ne 1){throw "SafeRead target $year preserved proof receipt omits its artifact."};$preservedArtifact=$preservedArtifactProperty[0].Value
    Assert-SafeReadExactProperties $preservedArtifact @('fileName','sha256','length','assemblyIdentity','targetFramework','platform','managedCodeSha256') "SafeRead target $year preserved proof artifact"
    Assert-SafeReadExactProperties $target.proof @('path','sha256','sizeBytes','artifactUnsignedSha256','managedCodeSha256') "SafeRead target $year proof evidence"
    if($target.proof.path -cne 'proof/proof.receipt.json' -or (Get-SafeReadSha256 $proofPath) -cne $target.proof.sha256 -or (Get-Item -LiteralPath $proofPath).Length -ne [int64]$target.proof.sizeBytes -or $target.proof.sha256 -cne $executorPayload[0].provenance.proofReceiptSha256 -or ('sha256:'+$target.proof.artifactUnsignedSha256) -cne $executorPayload[0].provenance.unsignedSha256 -or $target.proof.managedCodeSha256 -cne $executorPayload[0].provenance.managedCodeSha256 -or $preservedArtifact.fileName -cne "RevitOperator.SafeReadCertifiedExecution.Revit$year.dll" -or $preservedArtifact.sha256 -cne $target.proof.artifactUnsignedSha256 -or [int64]$preservedArtifact.length -le 0 -or $preservedArtifact.assemblyIdentity -cnotmatch '^RevitOperator\.SafeReadCertifiedExecution, Version=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' -or $preservedArtifact.targetFramework -cne $expected.TargetFrameworkAttribute -or $preservedArtifact.platform -cne 'x64' -or $preservedArtifact.managedCodeSha256 -cne $target.proof.managedCodeSha256){throw "SafeRead target $year proof evidence does not bind the certified executor."}
    $templatePath = Join-Path $targetRoot "manifest\$script:TemplateName"
    Assert-SafeReadExactProperties $target.manifest @('path','sha256','sizeBytes') "SafeRead target $year manifest evidence"
    if($target.manifest.path -cne "manifest/$script:TemplateName"){throw "SafeRead target $year uses the wrong manifest template name."}
    if ((Get-SafeReadSha256 $templatePath) -cne $target.manifest.sha256 -or (Get-Item -LiteralPath $templatePath).Length -ne [int64]$target.manifest.sizeBytes) { throw "SafeRead target $year manifest hash/size mismatch." }
    [void](Assert-SafeReadManifestXml -Path $templatePath -ExpectedAssembly $script:AssemblyToken)
    Assert-SafeReadExactProperties $target.runtimeAttestation @('path','sha256','sizeBytes') "SafeRead target $year runtime attestation evidence"
    if($target.runtimeAttestation.path -cne "payload/$script:RuntimeAttestationName"){throw "SafeRead target $year uses the wrong runtime attestation path."}
    $runtimePath=Join-Path $targetRoot "payload\$script:RuntimeAttestationName";$runtimePinPath=Join-Path $targetRoot "payload\$script:RuntimeAttestationPinName"
    $pinText=[IO.File]::ReadAllText($runtimePinPath);if($pinText.EndsWith("`n")){$pinText=$pinText.Substring(0,$pinText.Length-1)};if($pinText.EndsWith("`r")){throw "SafeRead target $year runtime pin must use LF or no newline."}
    if($pinText -cnotmatch '^sha256:[0-9a-f]{64}$' -or $pinText -cne (Get-SafeReadSha256 $runtimePath) -or $pinText -cne $target.runtimeAttestation.sha256 -or (Get-Item -LiteralPath $runtimePath).Length -ne [int64]$target.runtimeAttestation.sizeBytes){throw "SafeRead target $year runtime attestation pin/evidence mismatch."}
    $runtimeAttestation=ConvertTo-SafeReadObject $runtimePath
    Assert-SafeReadExactProperties $runtimeAttestation @('schema','state','issued_at_utc','expires_at_utc','route_id','route_contract_sha256','policy_sha256','proof_sha256','executor_id','runtime_tuple') "SafeRead target $year runtime attestation"
    if($runtimeAttestation.schema -cne $script:RuntimeAttestationSchema -or $runtimeAttestation.state -cnotin @('active','revoked') -or $runtimeAttestation.route_id -cne $script:RouteId -or $runtimeAttestation.route_contract_sha256 -cne $script:RouteContractSha256 -or $runtimeAttestation.policy_sha256 -cne $script:PolicySha256 -or $runtimeAttestation.executor_id -cne $script:ExecutorId -or $runtimeAttestation.proof_sha256 -cne $target.proof.sha256){throw "SafeRead target $year runtime attestation is not the exact backend contract."}
    $issued=Assert-SafeReadUtcInstant ([string]$runtimeAttestation.issued_at_utc) 'issued_at_utc';$expires=Assert-SafeReadUtcInstant ([string]$runtimeAttestation.expires_at_utc) 'expires_at_utc';if($expires -le $issued){throw "SafeRead target $year runtime attestation validity window is invalid."}
    $runtime = $runtimeAttestation.runtime_tuple
    Assert-SafeReadExactProperties $runtime @('host_content_sha256','host_mvid','revit_api_content_sha256','revit_api_mvid','revit_version') "SafeRead target $year runtime tuple"
    # Backend field names are historical: host_* binds the separately proofed
    # certified executor, not the transport/UI host shell.
    if ($runtime.host_content_sha256 -cne $executorPayload[0].sha256 -or $runtime.host_mvid -cne $executorPayload[0].assembly.mvid -or $runtime.revit_api_content_sha256 -cne $api.contentSha256 -or $runtime.revit_api_mvid -cne $api.mvid -or $runtime.revit_version -cne $year) { throw "SafeRead target $year static runtime tuple does not match certified executor/package evidence." }
    foreach ($hash in $runtime.host_content_sha256,$runtime.revit_api_content_sha256) { if ($hash -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'SafeRead runtime tuple hashes must be lowercase sha256:<hex>.' } }
    $pinTarget=@($pinTargets|Where-Object revitYear -ceq $year);if($pinTarget.Count -ne 1){throw "SafeRead package pins omit or duplicate target $year."};Assert-SafeReadExactProperties $pinTarget[0] @('revitYear','runtimeAttestationSha256') "SafeRead package pin target $year";if($pinTarget[0].runtimeAttestationSha256 -cne $pinText){throw "SafeRead package pin target $year does not bind its runtime attestation."}
  }
  if (($seen.Keys | Sort-Object) -join ',' -ne '2023,2024,2025') { throw 'SafeRead release does not contain all supported years.' }
  [pscustomobject]@{ ReleaseId=$release.releaseId; ReleaseManifestSha256=Get-SafeReadSha256 $manifestPath; AttestationSha256=Get-SafeReadSha256 $pinsPath; Targets=$targets; RuntimeAttestationPins=$pinTargets }
}

function Write-SafeReadAtomicFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Content)
  $directory = Split-Path -Parent $Path; New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path),[guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($temporary,$Content,[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,("{0}.previous.{1}" -f $Path,[guid]::NewGuid().ToString('N'))) } else { Move-Item -LiteralPath $temporary -Destination $Path }
}

Export-ModuleMember -Function Assert-SafeReadBundle,Assert-SafeReadExactProperties,Assert-SafeReadManifestXml,Assert-SafeReadReleaseId,Assert-SafeReadRelativePath,Assert-SafeReadDependencyClosure,ConvertTo-SafeReadCanonicalJson,ConvertTo-SafeReadHashtable,ConvertTo-SafeReadObject,Get-SafeReadAssemblyFacts,Get-SafeReadExpectedTarget,Get-SafeReadProofArtifact,Get-SafeReadRevitApiFacts,Get-SafeReadSha256,New-SafeReadInstalledManifest,Test-SafeReadDependencyAssemblyCompatibility,Test-SafeReadRuntimeProvidedAssembly,Write-SafeReadAtomicFile
