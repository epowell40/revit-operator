Set-StrictMode -Version Latest

$script:ReleaseSchema = 'revit-operator.safe-read-package-release.v2'
$script:AttestationSchema = 'revit-operator.safe-read-package-attestation.v2'
$script:HostDll = 'RevitOperator.SafeReadHost.dll'
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
  Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
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
    if ([string]::IsNullOrWhiteSpace($targetFramework)) { throw "SafeRead assembly does not declare one target framework: $resolved" }
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
    }
  } finally {
    if ($pe) { $pe.Dispose() } else { $stream.Dispose() }
  }
}

function Get-SafeReadRevitApiFacts {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $resolved = (Resolve-Path -LiteralPath $Path).Path
  $stream=[IO.File]::OpenRead($resolved);$pe=$null
  try{$pe=[System.Reflection.PortableExecutable.PEReader]::new($stream);if(-not $pe.HasMetadata){throw "RevitAPI is not managed: $resolved"};$metadata=[System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);$definition=$metadata.GetAssemblyDefinition();$module=$metadata.GetModuleDefinition()
    [pscustomobject]@{ContentSha256=Get-SafeReadSha256 $resolved;Mvid=$metadata.GetGuid($module.Mvid).ToString('D').ToLowerInvariant();AssemblyVersion=$definition.Version.ToString()}
  }finally{if($pe){$pe.Dispose()}else{$stream.Dispose()}}
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
  $manifestPath = Join-Path $root 'release-manifest.json'; $attestationPath = Join-Path $root 'deployment-attestation.json'
  foreach ($path in $manifestPath,$attestationPath) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SafeRead bundle is missing $(Split-Path -Leaf $path)." } }
  if ((Get-SafeReadSha256 $attestationPath) -cne $AttestationPinSha256) { throw 'SafeRead deployment attestation pin does not match this bundle.' }
  $release = ConvertTo-SafeReadObject $manifestPath; $attestation = ConvertTo-SafeReadObject $attestationPath
  Assert-SafeReadExactProperties $release @('schemaVersion','releaseId','allowedSignerThumbprints','targets') 'SafeRead release manifest'
  Assert-SafeReadExactProperties $attestation @('schemaVersion','releaseId','releaseManifestSha256','staticRuntimeTuples') 'SafeRead package attestation'
  if ($release.schemaVersion -cne $script:ReleaseSchema -or $attestation.schemaVersion -cne $script:AttestationSchema) { throw 'Unsupported SafeRead package schema.' }
  Assert-SafeReadReleaseId ([string]$release.releaseId)
  if ($attestation.releaseId -cne $release.releaseId -or $attestation.releaseManifestSha256 -cne (Get-SafeReadSha256 $manifestPath)) { throw 'SafeRead attestation does not bind the exact release.' }
  $rootNames = @(Get-ChildItem -LiteralPath $root -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('deployment-attestation.json','release-manifest.json','targets') -DifferenceObject $rootNames) { throw 'SafeRead bundle root has missing or extra entries.' }
  $targetNames = @(Get-ChildItem -LiteralPath (Join-Path $root 'targets') -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('2023','2024','2025') -DifferenceObject $targetNames) { throw 'SafeRead bundle has missing or extra target directories.' }
  $targets = @($release.targets); if ($targets.Count -ne 3) { throw 'SafeRead release must declare exactly three targets.' }
  $allowed = @($release.allowedSignerThumbprints); if ($allowed.Count -eq 0) { throw 'SafeRead signer allowlist is empty.' }
  $contract = $null; $seen = @{}; $tuples = @($attestation.staticRuntimeTuples)
  if ($tuples.Count -ne 3) { throw 'SafeRead package attestation must contain exactly three static runtime tuples.' }
  foreach ($target in $targets) {
    Assert-SafeReadExactProperties $target @('revitYear','framework','platform','revitApi','requiredPayload','manifest') 'SafeRead target'
    $year = [string]$target.revitYear; if ($seen.ContainsKey($year)) { throw "SafeRead target year is duplicated: $year" }; $seen[$year]=$true
    $expected = Get-SafeReadExpectedTarget $year
    if ($target.framework -cne $expected.Framework -or $target.platform -cne 'x64') { throw "SafeRead target $year has mixed framework/platform metadata." }
    $api = $target.revitApi
    Assert-SafeReadExactProperties $api @('contentSha256','mvid','assemblyVersion') "SafeRead target $year Revit API evidence"
    if ([int](([version]$api.assemblyVersion).Major) -ne $expected.RevitApiMajor -or $api.contentSha256 -cnotmatch '^sha256:[0-9a-f]{64}$' -or $api.mvid -cnotmatch '^[0-9a-f-]{36}$') { throw "SafeRead target $year has invalid Revit API evidence." }
    $payload = @($target.requiredPayload); if ($payload.Count -eq 0) { throw "SafeRead target $year has no required payload." }
    foreach ($declared in $payload) { Assert-SafeReadRelativePath ([string]$declared.path) }
    $payloadContract = @($payload | ForEach-Object { '{0}|{1}|{2}' -f $_.path,$_.role,([bool]$_.revitApiBound) })
    if ($null -eq $contract) { $contract = $payloadContract } elseif (Compare-Object -ReferenceObject $contract -DifferenceObject $payloadContract) { throw 'SafeRead required payload contract differs across years.' }
    $hostPayload = @($payload | Where-Object { $_.role -ceq 'host' })
    if ($hostPayload.Count -ne 1 -or $hostPayload[0].path -cne "payload/$script:HostDll" -or -not [bool]$hostPayload[0].revitApiBound) { throw "SafeRead target $year does not contain the exact certified host payload." }
    $targetRoot = Join-Path $root "targets\$year"
    $expectedPaths = @($payload.path) + "manifest/$script:TemplateName"
    $actualPaths = @(Get-ChildItem -LiteralPath $targetRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($targetRoot.Length).TrimStart([char]92,[char]47).Replace([char]92,[char]47) } | Sort-Object)
    if (Compare-Object -ReferenceObject @($expectedPaths | Sort-Object) -DifferenceObject $actualPaths) { throw "SafeRead target $year has missing or extra files." }
    foreach ($item in $payload) {
      Assert-SafeReadExactProperties $item @('path','role','revitApiBound','sha256','sizeBytes','assembly') "SafeRead target $year payload entry"
      Assert-SafeReadExactProperties $item.assembly @('name','targetFramework','platform','mvid','revitApiReferenceVersion') "SafeRead target $year payload assembly evidence"
      if ($item.path -cnotmatch '^payload/[A-Za-z0-9][A-Za-z0-9._-]*\.dll$') { throw "SafeRead payload path is not an exact DLL leaf: $($item.path)" }
      $path = Join-Path $targetRoot ($item.path.Replace('/', '\'))
      if ((Get-SafeReadSha256 $path) -cne $item.sha256 -or (Get-Item -LiteralPath $path).Length -ne [int64]$item.sizeBytes) { throw "SafeRead target $year payload hash/size mismatch: $($item.path)" }
      Invoke-SafeReadSignatureVerification -Path $path -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
      $facts = if ($AssemblyInspector) { & $AssemblyInspector $path $year $item } else { Get-SafeReadAssemblyFacts $path }
      if ($facts.Name -cne $item.assembly.name -or $facts.TargetFramework -cne $item.assembly.targetFramework -or $facts.Platform -cne $item.assembly.platform -or $facts.Mvid -cne $item.assembly.mvid -or $facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64') { throw "SafeRead target $year assembly facts do not match." }
      if ([bool]$item.revitApiBound) {
        if ([string]::IsNullOrWhiteSpace($facts.RevitApiReferenceVersion) -or ([version]$facts.RevitApiReferenceVersion).Major -ne $expected.RevitApiMajor -or $facts.RevitApiReferenceVersion -cne $item.assembly.revitApiReferenceVersion) { throw "SafeRead target $year contains a cross-year Revit API assembly reference." }
      }
    }
    $templatePath = Join-Path $targetRoot "manifest\$script:TemplateName"
    Assert-SafeReadExactProperties $target.manifest @('path','sha256','sizeBytes') "SafeRead target $year manifest evidence"
    if($target.manifest.path -cne "manifest/$script:TemplateName"){throw "SafeRead target $year uses the wrong manifest template name."}
    if ((Get-SafeReadSha256 $templatePath) -cne $target.manifest.sha256 -or (Get-Item -LiteralPath $templatePath).Length -ne [int64]$target.manifest.sizeBytes) { throw "SafeRead target $year manifest hash/size mismatch." }
    [void](Assert-SafeReadManifestXml -Path $templatePath -ExpectedAssembly $script:AssemblyToken)
    $tuple = @($tuples | Where-Object revit_version -ceq $year); if ($tuple.Count -ne 1) { throw "SafeRead target $year static runtime tuple is missing or duplicated." }
    Assert-SafeReadExactProperties $tuple[0] @('revit_version','runtime_tuple') "SafeRead target $year static tuple envelope"
    $runtime = $tuple[0].runtime_tuple
    Assert-SafeReadExactProperties $runtime @('host_content_sha256','host_mvid','revit_api_content_sha256','revit_api_mvid','revit_version') "SafeRead target $year runtime tuple"
    if ($runtime.host_content_sha256 -cne $hostPayload[0].sha256 -or $runtime.host_mvid -cne $hostPayload[0].assembly.mvid -or $runtime.revit_api_content_sha256 -cne $api.contentSha256 -or $runtime.revit_api_mvid -cne $api.mvid -or $runtime.revit_version -cne $year) { throw "SafeRead target $year static runtime tuple does not match package evidence." }
    foreach ($hash in $runtime.host_content_sha256,$runtime.revit_api_content_sha256) { if ($hash -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'SafeRead runtime tuple hashes must be lowercase sha256:<hex>.' } }
  }
  if (($seen.Keys | Sort-Object) -join ',' -ne '2023,2024,2025') { throw 'SafeRead release does not contain all supported years.' }
  [pscustomobject]@{ ReleaseId=$release.releaseId; ReleaseManifestSha256=Get-SafeReadSha256 $manifestPath; AttestationSha256=Get-SafeReadSha256 $attestationPath; Targets=$targets; StaticRuntimeTuples=$tuples }
}

function Write-SafeReadAtomicFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Content)
  $directory = Split-Path -Parent $Path; New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path),[guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($temporary,$Content,[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,("{0}.previous.{1}" -f $Path,[guid]::NewGuid().ToString('N'))) } else { Move-Item -LiteralPath $temporary -Destination $Path }
}

Export-ModuleMember -Function Assert-SafeReadBundle,Assert-SafeReadManifestXml,Assert-SafeReadReleaseId,Assert-SafeReadRelativePath,ConvertTo-SafeReadCanonicalJson,ConvertTo-SafeReadHashtable,ConvertTo-SafeReadObject,Get-SafeReadAssemblyFacts,Get-SafeReadExpectedTarget,Get-SafeReadRevitApiFacts,Get-SafeReadSha256,New-SafeReadInstalledManifest,Write-SafeReadAtomicFile
