Set-StrictMode -Version Latest

$script:ReleaseSchema = 'revit-operator.safe-read-package-release.v3'
$script:PinsSchema = 'revit-operator.safe-read-package-pins.v3'
$script:RuntimeAttestationSchema = 'revit-operator.safe-read-runtime-attestation.v1'
$script:AdmissionReceiptSchema = 'revit-operator.safe-read-admission-receipt.v1'
$script:HostDll = 'RevitOperator.SafeReadHost.dll'
$script:CertifiedExecutorDll = 'RevitOperator.SafeReadCertifiedExecution.dll'
$script:RuntimeAttestationName = 'safe_read_runtime_attestation.v1.json'
$script:RuntimeAttestationPinName = 'safe_read_runtime_attestation.v1.sha256'
$script:RouteId = 'safe_read.sheet_count.v1'
$script:RouteContractSha256 = 'sha256:cc80c231ba289396516164cb0fdbc3c71779ac018e717085f07a544530e68874'
$script:PolicySha256 = 'sha256:23692b21a7e728e9c1ce5eec9580dcec4f3ac7f25d3d95059899c680a17aad67'
$script:ExecutorId = 'revit-operator.safe-read-host.v1'
$script:ProofKind = 'revit-safe-read-certified-kernel/v1'
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
  $bytes=[IO.File]::ReadAllBytes($Path)
  $hasBom=($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) -or
    ($bytes.Length -ge 2 -and (($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) -or ($bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF))) -or
    ($bytes.Length -ge 4 -and (($bytes[0] -eq 0x00 -and $bytes[1] -eq 0x00 -and $bytes[2] -eq 0xFE -and $bytes[3] -eq 0xFF) -or ($bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE -and $bytes[2] -eq 0x00 -and $bytes[3] -eq 0x00)))
  if($hasBom){throw 'SafeRead JSON input is not exact canonical UTF-8 without BOM.'}
  try{$json=[Text.UTF8Encoding]::new($false,$true).GetString($bytes)}catch{throw 'SafeRead JSON input is not exact canonical UTF-8 without BOM.'}
  if((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')){$json|ConvertFrom-Json -DateKind String}else{$json|ConvertFrom-Json}
}

function ConvertTo-SafeReadCanonicalJson {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$InputObject)
  $builder=[Text.StringBuilder]::new()
  Write-SafeReadCanonicalJsonValue -Value $InputObject -Builder $builder -Depth 0
  $builder.ToString()
}

function Write-SafeReadCanonicalJsonString {
  param([Parameter(Mandatory)][AllowEmptyString()][string]$Value,[Parameter(Mandatory)][Text.StringBuilder]$Builder)
  [void]$Builder.Append('"')
  for($index=0;$index -lt $Value.Length;$index++){
    $character=$Value[$index];$code=[int]$character
    if($code -eq 8){[void]$Builder.Append('\b');continue}
    if($code -eq 9){[void]$Builder.Append('\t');continue}
    if($code -eq 10){[void]$Builder.Append('\n');continue}
    if($code -eq 12){[void]$Builder.Append('\f');continue}
    if($code -eq 13){[void]$Builder.Append('\r');continue}
    if($code -eq 34){[void]$Builder.Append('\"');continue}
    if($code -eq 92){[void]$Builder.Append('\\');continue}
    if($code -lt 32){[void]$Builder.Append(('\u{0:x4}' -f $code));continue}
    if($code -ge 0xD800 -and $code -le 0xDBFF){
      if($index+1 -ge $Value.Length){throw 'SafeRead canonical JSON rejects an unpaired high surrogate.'}
      $low=$Value[$index+1];$lowCode=[int]$low
      if($lowCode -lt 0xDC00 -or $lowCode -gt 0xDFFF){throw 'SafeRead canonical JSON rejects an unpaired high surrogate.'}
      [void]$Builder.Append($character);[void]$Builder.Append($low);$index++;continue
    }
    if($code -ge 0xDC00 -and $code -le 0xDFFF){throw 'SafeRead canonical JSON rejects an unpaired low surrogate.'}
    [void]$Builder.Append($character)
  }
  [void]$Builder.Append('"')
}

function Write-SafeReadCanonicalJsonValue {
  param([AllowNull()]$Value,[Parameter(Mandatory)][Text.StringBuilder]$Builder,[Parameter(Mandatory)][int]$Depth)
  if($Depth -gt 32){throw 'SafeRead canonical JSON exceeds its maximum depth.'}
  if($null -eq $Value){[void]$Builder.Append('null');return}
  if($Value -is [string] -or $Value -is [char]){Write-SafeReadCanonicalJsonString ([string]$Value) $Builder;return}
  if($Value -is [bool]){[void]$Builder.Append($(if($Value){'true'}else{'false'}));return}
  $type=$Value.GetType()
  if($type -in @([byte],[sbyte],[int16],[uint16],[int32],[uint32],[int64],[uint64],[decimal])){[void]$Builder.Append(([Convert]::ToString($Value,[Globalization.CultureInfo]::InvariantCulture)));return}
  if($Value -is [double]){if([double]::IsNaN($Value)-or[double]::IsInfinity($Value)){throw 'SafeRead canonical JSON rejects non-finite numbers.'};[void]$Builder.Append($Value.ToString('R',[Globalization.CultureInfo]::InvariantCulture));return}
  if($Value -is [single]){if([single]::IsNaN($Value)-or[single]::IsInfinity($Value)){throw 'SafeRead canonical JSON rejects non-finite numbers.'};[void]$Builder.Append($Value.ToString('R',[Globalization.CultureInfo]::InvariantCulture));return}
  if($Value -is [Collections.IDictionary]){
    [void]$Builder.Append('{');$names=[string[]]@($Value.Keys|ForEach-Object{if($_ -isnot [string]){throw 'SafeRead canonical JSON object keys must be strings.'};[string]$_})
    if($Value -isnot [Collections.Specialized.OrderedDictionary]){[Array]::Sort($names,[StringComparer]::Ordinal)}
    for($index=0;$index -lt $names.Length;$index++){
      if($index){[void]$Builder.Append(',')};Write-SafeReadCanonicalJsonString $names[$index] $Builder;[void]$Builder.Append(':');Write-SafeReadCanonicalJsonValue $Value[$names[$index]] $Builder ($Depth+1)
    }
    [void]$Builder.Append('}');return
  }
  if($Value -is [Collections.IEnumerable]){
    [void]$Builder.Append('[');$index=0
    foreach($item in $Value){if($index){[void]$Builder.Append(',')};Write-SafeReadCanonicalJsonValue $item $Builder ($Depth+1);$index++}
    [void]$Builder.Append(']');return
  }
  $properties=@($Value.PSObject.Properties|Where-Object{$_.MemberType -in @('NoteProperty','Property')})
  if($properties.Count -eq 0){throw "SafeRead canonical JSON does not support value type $($type.FullName)."}
  [void]$Builder.Append('{')
  for($index=0;$index -lt $properties.Count;$index++){
    if($index){[void]$Builder.Append(',')};$property=$properties[$index];Write-SafeReadCanonicalJsonString ([string]$property.Name) $Builder;[void]$Builder.Append(':');Write-SafeReadCanonicalJsonValue $property.Value $Builder ($Depth+1)
  }
  [void]$Builder.Append('}')
}

function Assert-SafeReadCanonicalJsonBytes {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)]$Value,[Parameter(Mandatory)][string]$Location)
  $actual=[IO.File]::ReadAllBytes($Path);$expected=[Text.UTF8Encoding]::new($false,$true).GetBytes((ConvertTo-SafeReadCanonicalJson $Value))
  $equal=$actual.Length -eq $expected.Length
  if($equal){for($index=0;$index -lt $actual.Length;$index++){if($actual[$index] -ne $expected[$index]){$equal=$false;break}}}
  if(-not $equal){throw "$Location is not exact canonical UTF-8 without BOM."}
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

function ConvertTo-SafeReadPublicKeyToken {
  param([AllowNull()][byte[]]$Bytes,[switch]$FullPublicKey)
  if($null -eq $Bytes -or $Bytes.Length -eq 0){return 'null'}
  $token=$Bytes
  if($FullPublicKey){$sha1=[Security.Cryptography.SHA1]::Create();try{$hash=$sha1.ComputeHash($Bytes)}finally{$sha1.Dispose()};$token=New-Object byte[] 8;for($i=0;$i -lt 8;$i++){$token[$i]=$hash[$hash.Length-1-$i]}}
  (($token|ForEach-Object{$_.ToString('x2')}) -join '')
}

function New-SafeReadAssemblyIdentity {
  param([Parameter(Mandatory)][string]$Name,[Parameter(Mandatory)][string]$Version,[AllowNull()][string]$Culture,[AllowNull()][string]$PublicKeyToken)
  [pscustomobject][ordered]@{
    name=$Name
    version=$Version
    culture=if([string]::IsNullOrWhiteSpace($Culture)){'neutral'}else{$Culture}
    publicKeyToken=if([string]::IsNullOrWhiteSpace($PublicKeyToken)){'null'}else{$PublicKeyToken.ToLowerInvariant()}
  }
}

function Get-SafeReadAssemblyIdentityKey {
  param([Parameter(Mandatory)]$Identity)
  '{0}, Version={1}, Culture={2}, PublicKeyToken={3}' -f $Identity.name,$Identity.version,$Identity.culture,$Identity.publicKeyToken
}

function ConvertTo-SafeReadCanonicalAssemblyReferences {
  [CmdletBinding()]
  param([AllowEmptyCollection()][object[]]$References)
  $ordered=[Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal)
  foreach($reference in @($References)){
    if($reference -is [string]){throw 'SafeRead assembly references must contain full identities.'}
    $identity=New-SafeReadAssemblyIdentity ([string]$reference.name) ([string]$reference.version) ([string]$reference.culture) ([string]$reference.publicKeyToken)
    $key=Get-SafeReadAssemblyIdentityKey $identity
    if($ordered.ContainsKey($key)){throw "SafeRead assembly references duplicate identity $key."}
    $ordered.Add($key,$identity)
  }
  @($ordered.Values)
}

function ConvertTo-SafeReadSid {
  param([Parameter(Mandatory)]$Identity)
  try { ([Security.Principal.NTAccount]$Identity).Translate([Security.Principal.SecurityIdentifier]).Value }
  catch { [string]$Identity }
}

function Get-SafeReadAllowedSecurityPrincipals {
  $current=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  @($current,'S-1-5-18','S-1-5-32-544')
}

function Get-SafeReadAclRecord {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $acl=Get-Acl -LiteralPath $Path
  [pscustomobject]@{
    OwnerSid=ConvertTo-SafeReadSid $acl.Owner
    Protected=[bool]$acl.AreAccessRulesProtected
    Access=@($acl.Access|ForEach-Object{[pscustomobject]@{
      Sid=ConvertTo-SafeReadSid $_.IdentityReference
      Type=[string]$_.AccessControlType
      Rights=[int64]$_.FileSystemRights
      IsInherited=[bool]$_.IsInherited
    }})
  }
}

function Assert-SafeReadAclRecord {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Record,[Parameter(Mandatory)][string]$Location)
  $allowed=Get-SafeReadAllowedSecurityPrincipals
  if($allowed -cnotcontains [string]$Record.OwnerSid){throw "SafeRead path has a foreign owner: $Location owner=$($Record.OwnerSid)"}
  $writeMask=[int64]([Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Modify -bor [Security.AccessControl.FileSystemRights]::FullControl -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership)
  foreach($ace in @($Record.Access)){
    if($ace.Type -ceq 'Allow' -and (([int64]$ace.Rights -band $writeMask) -ne 0) -and $allowed -cnotcontains [string]$ace.Sid){
      throw "SafeRead path grants write access to an untrusted principal: $Location principal=$($ace.Sid)"
    }
  }
}

function Assert-SafeReadStrictAclRecord {
  [CmdletBinding()]
  param([Parameter(Mandatory)]$Record,[Parameter(Mandatory)][string]$Location)
  Assert-SafeReadAclRecord $Record $Location
  $allowed=Get-SafeReadAllowedSecurityPrincipals
  if(-not [bool]$Record.Protected){throw "SafeRead strict path inherits ACLs: $Location"}
  foreach($ace in @($Record.Access)){
    if($ace.IsInherited -or $ace.Type -cne 'Allow' -or $allowed -cnotcontains [string]$ace.Sid){
      throw "SafeRead strict path has a foreign, inherited, or non-allow ACE: $Location principal=$($ace.Sid)"
    }
  }
  $actual=@($Record.Access|ForEach-Object Sid|Sort-Object -Unique)
  if(Compare-Object -ReferenceObject @($allowed|Sort-Object) -DifferenceObject $actual){throw "SafeRead strict path omits an exact trusted principal: $Location"}
}

function Protect-SafeReadPathAcl {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[switch]$Strict)
  $canonical=Resolve-SafeReadCanonicalPath $Path
  $record=Get-SafeReadAclRecord $canonical
  $acl=Get-Acl -LiteralPath $canonical
  if($Strict){
    $allowed=Get-SafeReadAllowedSecurityPrincipals
    $actualPrincipals=@($record.Access|ForEach-Object Sid|Sort-Object -Unique)
    $alreadyStrict=$record.Protected -and @($record.Access|Where-Object{$_.Type -cne 'Allow' -or $_.IsInherited -or $allowed -cnotcontains $_.Sid}).Count -eq 0 -and @($allowed|Where-Object{$actualPrincipals -cnotcontains $_}).Count -eq 0
    if($alreadyStrict){Assert-SafeReadStrictAclRecord $record $canonical;return $canonical}
    $currentSid=[Security.Principal.WindowsIdentity]::GetCurrent().User
    $isDirectory=(Get-Item -LiteralPath $canonical -Force).PSIsContainer
    $acl=if($isDirectory){[Security.AccessControl.DirectorySecurity]::new()}else{[Security.AccessControl.FileSecurity]::new()}
    $acl.SetOwner($currentSid);$acl.SetAccessRuleProtection($true,$false)
    foreach($sidText in @($currentSid.Value,'S-1-5-18','S-1-5-32-544')){
      $sid=[Security.Principal.SecurityIdentifier]::new($sidText)
      if($isDirectory){
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
      }else{$rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.AccessControlType]::Allow)}
      $acl.AddAccessRule($rule)
    }
    try{Set-Acl -LiteralPath $canonical -AclObject $acl -ErrorAction Stop}catch{throw "SafeRead strict ACL hardening failed for $canonical`: $($_.Exception.Message)"}
    $acl=Get-Acl -LiteralPath $canonical
  }
  $final=Get-SafeReadAclRecord $canonical
  if($Strict){Assert-SafeReadStrictAclRecord $final $canonical}else{Assert-SafeReadAclRecord $final $canonical}
  $canonical
}

function Protect-SafeReadTreeAcl {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $root=Assert-SafeReadSecureTree $Path -SkipAcl
  $all=@(Get-Item -LiteralPath $root -Force)+@(Get-ChildItem -LiteralPath $root -Force -Recurse|Sort-Object {$_.FullName.Length})
  # Harden parents first so subsequently created/replaced files inherit only the
  # current owner, SYSTEM, and Administrators contract required by the host.
  foreach($item in $all){[void](Protect-SafeReadPathAcl $item.FullName -Strict)}
  [void](Assert-SafeReadStrictTree $root)
  $root
}

function Assert-SafeReadStrictTree {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  $root=Assert-SafeReadSecureTree $Path -SkipAcl
  $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($root)
  while($pending.Count -gt 0){
    $current=$pending.Pop();$item=Get-Item -LiteralPath $current -Force
    Assert-SafeReadStrictAclRecord (Get-SafeReadAclRecord $current) $current
    if($item.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $current -Force)){$pending.Push($child.FullName)}}
  }
  $root
}

function Resolve-SafeReadCanonicalPath {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[switch]$AllowMissingLeaf)
  $full=[IO.Path]::GetFullPath($Path)
  $root=[IO.Path]::GetPathRoot($full)
  if([string]::IsNullOrWhiteSpace($root)){throw "SafeRead path is not rooted: $Path"}
  $relative=$full.Substring($root.Length)
  $current=$root
  $segments=@($relative -split '[\\/]'|Where-Object{$_ -ne ''})
  for($index=0;$index -lt $segments.Count;$index++){
    $current=Join-Path $current $segments[$index]
    if(-not(Test-Path -LiteralPath $current)){
      if($AllowMissingLeaf -and $index -eq $segments.Count-1){return $full}
      throw "SafeRead canonical path segment does not exist: $current"
    }
    $item=Get-Item -LiteralPath $current -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "SafeRead paths may not contain links or reparse points: $current"}
    $current=$item.FullName
  }
  [IO.Path]::GetFullPath($current)
}

function Assert-SafeReadSecureTree {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[switch]$SkipAcl)
  $root=Resolve-SafeReadCanonicalPath $Path
  $pending=New-Object 'System.Collections.Generic.Stack[string]';$pending.Push($root)
  while($pending.Count -gt 0){
    $current=$pending.Pop();$item=Get-Item -LiteralPath $current -Force
    if(($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw "SafeRead tree contains a link or reparse point: $current"}
    if(-not $SkipAcl){Assert-SafeReadAclRecord (Get-SafeReadAclRecord $current) $current}
    if($item.PSIsContainer){foreach($child in @(Get-ChildItem -LiteralPath $current -Force)){$pending.Push($child.FullName)}}
  }
  $root
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
    return [pscustomobject]@{Name=$facts.Name;Version=$facts.Version;Culture=$facts.Culture;PublicKeyToken=$facts.PublicKeyToken;TargetFramework=$facts.TargetFramework;Platform=$facts.Platform;Mvid=$facts.Mvid;RevitApiReferenceVersion=$facts.RevitApiReferenceVersion;AssemblyReferences=@(ConvertTo-SafeReadCanonicalAssemblyReferences @($facts.AssemblyReferences))}
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
    $revitApi = @();$references=@()
    foreach ($referenceHandle in $metadata.AssemblyReferences) {
      $reference = $metadata.GetAssemblyReference($referenceHandle)
      $referenceName=$metadata.GetString($reference.Name)
      $identity=New-SafeReadAssemblyIdentity $referenceName $reference.Version.ToString() ($metadata.GetString($reference.Culture)) (ConvertTo-SafeReadPublicKeyToken ($metadata.GetBlobBytes($reference.PublicKeyOrToken)))
      $references += $identity
      if ($referenceName -eq 'RevitAPI') { $revitApi += $identity }
    }
    $assemblyCulture=$metadata.GetString($definition.Culture)
    [pscustomobject]@{
      Name = $metadata.GetString($definition.Name)
      Version = $definition.Version.ToString()
      Culture = if([string]::IsNullOrWhiteSpace($assemblyCulture)){'neutral'}else{$assemblyCulture}
      PublicKeyToken = ConvertTo-SafeReadPublicKeyToken ($metadata.GetBlobBytes($definition.PublicKey)) -FullPublicKey
      TargetFramework = $targetFramework
      Platform = [string]$pe.PEHeaders.CoffHeader.Machine
      Mvid = $metadata.GetGuid($module.Mvid).ToString('D').ToLowerInvariant()
      RevitApiReferenceVersion = if ($revitApi.Count -eq 1) { $revitApi[0].version } else { $null }
      AssemblyReferences = @(ConvertTo-SafeReadCanonicalAssemblyReferences $references)
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
    return [pscustomobject]@{ContentSha256=Get-SafeReadSha256 $resolved;Mvid=$facts.Mvid;AssemblyVersion=$facts.Version;Identity=(New-SafeReadAssemblyIdentity $facts.Name $facts.Version $facts.Culture $facts.PublicKeyToken)}
  }
  $stream=[IO.File]::OpenRead($resolved);$pe=$null
  try{$pe=[System.Reflection.PortableExecutable.PEReader]::new($stream);if(-not $pe.HasMetadata){throw "RevitAPI is not managed: $resolved"};$metadata=[System.Reflection.Metadata.PEReaderExtensions]::GetMetadataReader($pe);$definition=$metadata.GetAssemblyDefinition();$module=$metadata.GetModuleDefinition()
    $culture=$metadata.GetString($definition.Culture);[pscustomobject]@{ContentSha256=Get-SafeReadSha256 $resolved;Mvid=$metadata.GetGuid($module.Mvid).ToString('D').ToLowerInvariant();AssemblyVersion=$definition.Version.ToString();Identity=(New-SafeReadAssemblyIdentity ($metadata.GetString($definition.Name)) $definition.Version.ToString() $culture (ConvertTo-SafeReadPublicKeyToken ($metadata.GetBlobBytes($definition.PublicKey)) -FullPublicKey))}
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
`$assemblyName=`$a.GetName();if(`$null -eq `$assemblyName){throw 'Assembly identity is unavailable.'}
function Key(`$n){'{0}, Version={1}, Culture={2}, PublicKeyToken={3}' -f `$n.name,`$n.version,`$n.culture,`$n.publicKeyToken}
`$map=[Collections.Generic.SortedDictionary[string,object]]::new([StringComparer]::Ordinal);foreach(`$referenceName in @(`$a.GetReferencedAssemblies())){`$tokenBytes=`$referenceName.GetPublicKeyToken();`$token=if(`$null -eq `$tokenBytes -or `$tokenBytes.Length -eq 0){'null'}else{((`$tokenBytes|ForEach-Object{`$_.ToString('x2')}) -join '')};`$reference=[ordered]@{name=`$referenceName.Name;version=`$referenceName.Version.ToString();culture=if([string]::IsNullOrWhiteSpace(`$referenceName.CultureName)){'neutral'}else{`$referenceName.CultureName};publicKeyToken=`$token};`$key=Key `$reference;if(`$map.ContainsKey(`$key)){throw "Duplicate assembly reference `$key."};`$map.Add(`$key,`$reference)};`$refs=@(`$map.Values);`$revit=@(`$refs|Where-Object name -ceq 'RevitAPI')
`$assemblyVersion=if(`$null -ne `$assemblyName.Version){`$assemblyName.Version.ToString()}else{'0.0.0.0'}
`$module=`$a.ManifestModule;if(`$null -eq `$module){throw 'Assembly manifest module is unavailable.'};`$mvid=`$module.ModuleVersionId.ToString('D').ToLowerInvariant()
`$targetFramework=if(`$tfms.Count -eq 1){[string]`$tfms[0]}else{`$null};`$revitVersion=if(`$revit.Count -eq 1){[string]`$revit[0].version}else{`$null}
`$assemblyTokenBytes=`$assemblyName.GetPublicKeyToken();`$assemblyToken=if(`$null -eq `$assemblyTokenBytes -or `$assemblyTokenBytes.Length -eq 0){'null'}else{((`$assemblyTokenBytes|ForEach-Object{`$_.ToString('x2')}) -join '')}
[pscustomobject]@{Name=`$assemblyName.Name;Version=`$assemblyVersion;Culture=if([string]::IsNullOrWhiteSpace(`$assemblyName.CultureName)){'neutral'}else{`$assemblyName.CultureName};PublicKeyToken=`$assemblyToken;TargetFramework=`$targetFramework;Platform=if(`$machine -eq 0x8664){'Amd64'}elseif(`$machine -eq 0x014c){'I386'}else{'Unsupported'};Mvid=`$mvid;RevitApiReferenceVersion=`$revitVersion;AssemblyReferences=`$refs}|ConvertTo-Json -Depth 6 -Compress
"@
  $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($source))
  $output=@(& (Join-Path $PSHOME 'powershell.exe') -NoLogo -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand $encoded 2>&1)
  if($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace(($output -join ''))){throw "SafeRead isolated metadata inspection failed: $Path`: $([string]::Join(' | ',@($output)))"}
  ($output -join '')|ConvertFrom-Json
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
  Assert-SafeReadExactProperties $receipt @('schemaVersion','proofKind','mode','status','certified','manifestSha256','verifierProfileId','verifierProfileSha256','verifierBundleSha256','sourceLockSha256','apiLockSha256','sdkLockSha256','trustBoundary','compilerOptions','issues','observation','artifacts') 'SafeRead proof receipt'
  if ([int]$receipt.schemaVersion -ne 1 -or $receipt.proofKind -cne $script:ProofKind -or $receipt.mode -cne 'check' -or $receipt.status -cne 'verified' -or -not [bool]$receipt.certified -or @($receipt.issues).Count -ne 0 -or $receipt.verifierProfileId -cne 'revit-safe-read-sheet-count-kernel/v1') { throw "SafeRead proof receipt is not certified and verified: $receiptPathResolved" }
  foreach($lockHash in $receipt.manifestSha256,$receipt.verifierProfileSha256,$receipt.verifierBundleSha256,$receipt.sourceLockSha256,$receipt.apiLockSha256,$receipt.sdkLockSha256){if($lockHash -cnotmatch '^[0-9a-f]{64}$'){throw "SafeRead proof receipt lock hash is invalid: $receiptPathResolved"}}
  if((@($receipt.artifacts.PSObject.Properties.Name|Sort-Object)-join ',') -cne '2023,2024,2025'){throw 'SafeRead proof receipt must cover exactly Revit 2023, 2024, and 2025.'}
  $artifactProperty=@($receipt.artifacts.PSObject.Properties | Where-Object Name -ceq $RevitYear)
  if($artifactProperty.Count -ne 1){throw "SafeRead proof receipt has no exact artifact for Revit $RevitYear."}
  $artifact=$artifactProperty[0].Value
  Assert-SafeReadExactProperties $artifact @('fileName','sha256','length','managedCodeSha256','assemblyIdentity','targetFramework','platform') "SafeRead proof artifact $RevitYear"
  $expected=Get-SafeReadExpectedTarget $RevitYear
  $expectedFile="RevitOperator.SafeReadCertifiedExecution.Revit$RevitYear.dll"
  if($artifact.fileName -cne $expectedFile -or $artifact.sha256 -cnotmatch '^[0-9a-f]{64}$' -or $artifact.managedCodeSha256 -cnotmatch '^[0-9a-f]{64}$' -or [int64]$artifact.length -le 0 -or $artifact.assemblyIdentity -cnotmatch '^RevitOperator\.SafeReadCertifiedExecution, Version=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+, Culture=neutral, PublicKeyToken=null$' -or $artifact.targetFramework -cne $expected.TargetFrameworkAttribute -or $artifact.platform -cne 'x64'){throw "SafeRead proof artifact contract is invalid for Revit $RevitYear."}
  $proofRoot=Split-Path -Parent $receiptPathResolved
  $names=@(Get-ChildItem -LiteralPath $proofRoot -Force | ForEach-Object Name | Sort-Object)
  $expectedNames=@('proof.receipt.json','RevitOperator.SafeReadCertifiedExecution.Revit2023.dll','RevitOperator.SafeReadCertifiedExecution.Revit2024.dll','RevitOperator.SafeReadCertifiedExecution.Revit2025.dll')|Sort-Object
  if(Compare-Object -ReferenceObject $expectedNames -DifferenceObject $names){throw 'SafeRead proof output directory has missing or extra files.'}
  $assemblyPath=Join-Path $proofRoot $expectedFile
  $whole=(Get-SafeReadSha256 $assemblyPath).Substring(7)
  if($whole -cne $artifact.sha256 -or (Get-Item -LiteralPath $assemblyPath).Length -ne [int64]$artifact.length){throw "SafeRead verifier-emitted artifact hash/length mismatch for Revit $RevitYear."}
  [pscustomobject]@{ReceiptPath=$receiptPathResolved;ReceiptSha256=Get-SafeReadSha256 $receiptPathResolved;Receipt=$receipt;AssemblyPath=$assemblyPath;Artifact=$artifact}
}

function Test-SafeReadRuntimeProvidedAssembly {
  param([Parameter(Mandatory)]$Reference,[Parameter(Mandatory)][string]$Framework)
  $Name=if($Reference -is [string]){$Reference}else{[string]$Reference.name}
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
  $identities=@{};$names=@{};$required=@{}
  foreach($item in @($Payload)){
    $identity=New-SafeReadAssemblyIdentity ([string]$item.assembly.name) ([string]$item.assembly.version) ([string]$item.assembly.culture) ([string]$item.assembly.publicKeyToken)
    $key=Get-SafeReadAssemblyIdentityKey $identity
    if($identities.ContainsKey($key)){throw "SafeRead target $RevitYear duplicates assembly identity $key."}
    if($names.ContainsKey($identity.name)){throw "SafeRead target $RevitYear contains multiple versions or signer identities for $($identity.name)."}
    $identities[$key]=$true;$names[$identity.name]=$key
  }
  foreach($item in @($Payload)){
    foreach($reference in @($item.assembly.references)){
      if($reference -is [string]){throw "SafeRead target $RevitYear has a name-only dependency reference; full identity is required."}
      Assert-SafeReadExactProperties $reference @('name','version','culture','publicKeyToken') "SafeRead target $RevitYear dependency reference"
      if(Test-SafeReadRuntimeProvidedAssembly $reference $Framework){continue}
      $key=Get-SafeReadAssemblyIdentityKey $reference
      $required[$key]=$true
      if(-not $identities.ContainsKey($key)){
        if($names.ContainsKey([string]$reference.name)){throw "SafeRead target $RevitYear dependency identity mismatch for $key; packaged identity is $([string]$names[[string]$reference.name])"}
        throw "SafeRead target $RevitYear is missing exact runtime dependency $key required by $($item.assembly.name)"
      }
    }
  }
  foreach($item in @($Payload|Where-Object{@($_.PSObject.Properties.Name) -ccontains 'role' -and $_.role -ceq 'runtime_dependency'})){
    $key=Get-SafeReadAssemblyIdentityKey $item.assembly
    if(-not $required.ContainsKey($key)){throw "SafeRead target $RevitYear contains unreferenced runtime dependency $key."}
  }
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
  [void](Get-SafeReadSignatureEvidence -Path $Path -AllowedSignerThumbprints $AllowedSignerThumbprints -SignatureVerifier $SignatureVerifier)
}

function Get-SafeReadSignatureEvidence {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][string[]]$AllowedSignerThumbprints, [scriptblock]$SignatureVerifier)
  $result = if ($SignatureVerifier) { & $SignatureVerifier $Path } else {
    $signature = Get-AuthenticodeSignature -LiteralPath $Path
    [pscustomobject]@{ Status=[string]$signature.Status; Thumbprint=if($signature.SignerCertificate){$signature.SignerCertificate.Thumbprint}else{$null} }
  }
  $thumbprint = ([string]$result.Thumbprint).Replace(' ','').ToUpperInvariant()
  $allowed = @($AllowedSignerThumbprints | ForEach-Object { ([string]$_).Replace(' ','').ToUpperInvariant() })
  if ([string]$result.Status -cne 'Valid' -or $allowed -notcontains $thumbprint) { throw "SafeRead payload signature or signer allowlist validation failed: $Path" }
  if($thumbprint -cnotmatch '^[0-9A-F]{40}$'){throw "SafeRead signer thumbprint is not an exact SHA-1 certificate thumbprint: $Path"}
  [pscustomobject][ordered]@{status='Valid';thumbprint=$thumbprint}
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
  $root = Assert-SafeReadSecureTree $BundleRoot
  $manifestPath = Join-Path $root 'release-manifest.json'; $pinsPath = Join-Path $root 'package-pins.json'; $sourceReceiptPath = Join-Path $root 'source.snapshot.receipt.json'
  foreach ($path in $manifestPath,$pinsPath,$sourceReceiptPath) { if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "SafeRead bundle is missing $(Split-Path -Leaf $path)." } }
  if ((Get-SafeReadSha256 $pinsPath) -cne $AttestationPinSha256) { throw 'SafeRead package pins external pin does not match this bundle.' }
  $release = ConvertTo-SafeReadObject $manifestPath; $pins = ConvertTo-SafeReadObject $pinsPath
  Assert-SafeReadExactProperties $release @('schemaVersion','releaseId','allowedSignerThumbprints','source','targets') 'SafeRead release manifest'
  Assert-SafeReadExactProperties $pins @('schemaVersion','releaseId','releaseManifestSha256','targets') 'SafeRead package pins'
  if ($release.schemaVersion -cne $script:ReleaseSchema -or $pins.schemaVersion -cne $script:PinsSchema) { throw 'Unsupported SafeRead package schema.' }
  Assert-SafeReadReleaseId ([string]$release.releaseId)
  if ($pins.releaseId -cne $release.releaseId -or $pins.releaseManifestSha256 -cne (Get-SafeReadSha256 $manifestPath)) { throw 'SafeRead package pins do not bind the exact release.' }
  $rootNames = @(Get-ChildItem -LiteralPath $root -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('package-pins.json','release-manifest.json','source.snapshot.receipt.json','targets') -DifferenceObject $rootNames) { throw 'SafeRead bundle root has missing or extra entries.' }
  $source = $release.source
  Assert-SafeReadExactProperties $source @('path','sha256','sizeBytes','commit','proofTree','hostTree','archiveSha256') 'SafeRead release source evidence'
  if ($source.path -cne 'source.snapshot.receipt.json' -or $source.sha256 -cnotmatch '^sha256:[0-9a-f]{64}$' -or (Get-SafeReadSha256 $sourceReceiptPath) -cne $source.sha256 -or (Get-Item -LiteralPath $sourceReceiptPath).Length -ne [int64]$source.sizeBytes -or [int64]$source.sizeBytes -le 0) { throw 'SafeRead release source receipt hash/size/path mismatch.' }
  $sourceReceipt = ConvertTo-SafeReadObject $sourceReceiptPath
  Assert-SafeReadExactProperties $sourceReceipt @('schemaVersion','commit','proofTree','hostTree','archiveSha256') 'SafeRead source snapshot receipt'
  if ([int]$sourceReceipt.schemaVersion -ne 1 -or $sourceReceipt.commit -cnotmatch '^[0-9a-f]{40}$' -or $sourceReceipt.proofTree -cnotmatch '^[0-9a-f]{40}$' -or $sourceReceipt.hostTree -cnotmatch '^[0-9a-f]{40}$' -or $sourceReceipt.archiveSha256 -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'SafeRead source snapshot receipt identities are invalid or not lowercase.' }
  Assert-SafeReadCanonicalJsonBytes $sourceReceiptPath $sourceReceipt 'SafeRead source snapshot receipt'
  if ($source.commit -cne $sourceReceipt.commit -or $source.proofTree -cne $sourceReceipt.proofTree -or $source.hostTree -cne $sourceReceipt.hostTree -or $source.archiveSha256 -cne $sourceReceipt.archiveSha256) { throw 'SafeRead release source evidence does not match its snapshot receipt.' }
  $targetNames = @(Get-ChildItem -LiteralPath (Join-Path $root 'targets') -Force | ForEach-Object Name | Sort-Object)
  if (Compare-Object -ReferenceObject @('2023','2024','2025') -DifferenceObject $targetNames) { throw 'SafeRead bundle has missing or extra target directories.' }
  $targets = @($release.targets); if ($targets.Count -ne 3) { throw 'SafeRead release must declare exactly three targets.' }
  $allowed = @($release.allowedSignerThumbprints); if ($allowed.Count -eq 0) { throw 'SafeRead signer allowlist is empty.' }
  $seen = @{}; $pinTargets=@($pins.targets);$preservedProofHashes=@()
  if ($pinTargets.Count -ne 3) { throw 'SafeRead package pins must contain exactly three targets.' }
  foreach ($target in $targets) {
    Assert-SafeReadExactProperties $target @('revitYear','framework','platform','revitApi','revitApiUi','requiredPayload','proof','runtimeAttestation','manifest') 'SafeRead target'
    $year = [string]$target.revitYear; if ($seen.ContainsKey($year)) { throw "SafeRead target year is duplicated: $year" }; $seen[$year]=$true
    $expected = Get-SafeReadExpectedTarget $year
    if ($target.framework -cne $expected.Framework -or $target.platform -cne 'x64') { throw "SafeRead target $year has mixed framework/platform metadata." }
    $api = $target.revitApi
    Assert-SafeReadExactProperties $api @('contentSha256','mvid','identity') "SafeRead target $year Revit API evidence"
    Assert-SafeReadExactProperties $api.identity @('name','version','culture','publicKeyToken') "SafeRead target $year Revit API identity"
    $apiUi=$target.revitApiUi;Assert-SafeReadExactProperties $apiUi @('contentSha256','mvid','identity') "SafeRead target $year Revit API UI evidence";Assert-SafeReadExactProperties $apiUi.identity @('name','version','culture','publicKeyToken') "SafeRead target $year Revit API UI identity"
    if ($api.identity.name -cne 'RevitAPI' -or $apiUi.identity.name -cne 'RevitAPIUI' -or [int](([version]$api.identity.version).Major) -ne $expected.RevitApiMajor -or [int](([version]$apiUi.identity.version).Major) -ne $expected.RevitApiMajor -or $api.contentSha256 -cnotmatch '^sha256:[0-9a-f]{64}$' -or $apiUi.contentSha256 -cnotmatch '^sha256:[0-9a-f]{64}$' -or $api.mvid -cnotmatch '^[0-9a-f-]{36}$' -or $apiUi.mvid -cnotmatch '^[0-9a-f-]{36}$') { throw "SafeRead target $year has invalid Revit API evidence." }
    $payload = @($target.requiredPayload); if ($payload.Count -lt 2) { throw "SafeRead target $year has no loadable host/executor payload." }
    foreach ($declared in $payload) { Assert-SafeReadRelativePath ([string]$declared.path) }
    $hostPayload = @($payload | Where-Object { $_.role -ceq 'host' })
    if ($hostPayload.Count -ne 1 -or $hostPayload[0].path -cne "payload/$script:HostDll" -or -not [bool]$hostPayload[0].revitApiBound) { throw "SafeRead target $year does not contain exactly one SafeRead host payload." }
    $executorPayload = @($payload | Where-Object { $_.role -ceq 'certified_executor' })
    if ($executorPayload.Count -ne 1 -or $executorPayload[0].path -cne "payload/$script:CertifiedExecutorDll" -or -not [bool]$executorPayload[0].revitApiBound) { throw "SafeRead target $year does not contain exactly one certified executor payload." }
    foreach($other in @($payload|Where-Object role -cne 'host'|Where-Object role -cne 'certified_executor')){if($other.role -cne 'runtime_dependency' -or [bool]$other.revitApiBound){throw "SafeRead target $year has an unsupported payload role."}}
    $targetRoot = Join-Path $root "targets\$year"
    $expectedPaths = @($payload.path) + @("payload/$script:RuntimeAttestationName","payload/$script:RuntimeAttestationPinName",'proof/proof.receipt.json','proof/artifact.equivalence.json',"manifest/$script:TemplateName")
    $actualPaths = @(Get-ChildItem -LiteralPath $targetRoot -File -Recurse | ForEach-Object { $_.FullName.Substring($targetRoot.Length).TrimStart([char]92,[char]47).Replace([char]92,[char]47) } | Sort-Object)
    if (Compare-Object -ReferenceObject @($expectedPaths | Sort-Object) -DifferenceObject $actualPaths) { throw "SafeRead target $year has missing or extra files." }
    foreach ($item in $payload) {
      Assert-SafeReadExactProperties $item @('path','role','revitApiBound','sha256','sizeBytes','assembly','provenance') "SafeRead target $year payload entry"
      Assert-SafeReadExactProperties $item.assembly @('name','version','culture','publicKeyToken','targetFramework','platform','mvid','references') "SafeRead target $year payload assembly evidence"
      if ($item.path -cnotmatch '^payload/[A-Za-z0-9][A-Za-z0-9._-]*\.dll$') { throw "SafeRead payload path is not an exact DLL leaf: $($item.path)" }
      $path = Join-Path $targetRoot ($item.path.Replace('/', '\'))
      if ((Get-SafeReadSha256 $path) -cne $item.sha256 -or (Get-Item -LiteralPath $path).Length -ne [int64]$item.sizeBytes) { throw "SafeRead target $year payload hash/size mismatch: $($item.path)" }
      Invoke-SafeReadSignatureVerification -Path $path -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
      $facts = if ($AssemblyInspector) { & $AssemblyInspector $path $year $item } else { Get-SafeReadAssemblyFacts $path }
      if ($facts.Name -cne $item.assembly.name -or $facts.Version -cne $item.assembly.version -or $facts.Culture -cne $item.assembly.culture -or $facts.PublicKeyToken -cne $item.assembly.publicKeyToken -or [string]$facts.TargetFramework -cne [string]$item.assembly.targetFramework -or $facts.Platform -cne $item.assembly.platform -or $facts.Mvid -cne $item.assembly.mvid -or (ConvertTo-SafeReadCanonicalJson @($facts.AssemblyReferences)) -cne (ConvertTo-SafeReadCanonicalJson @($item.assembly.references))) { throw "SafeRead target $year assembly facts or dependency identities do not match." }
      if($item.path -cne "payload/$($facts.Name).dll"){throw "SafeRead target $year payload filename does not match its exact assembly identity."}
      if($item.role -ceq 'host' -and $facts.Name -cne 'RevitOperator.SafeReadHost'){throw "SafeRead target $year host assembly identity is invalid."};if($item.role -ceq 'certified_executor' -and $facts.Name -cne 'RevitOperator.SafeReadCertifiedExecution'){throw "SafeRead target $year certified executor assembly identity is invalid."}
      if($item.role -cin @('host','certified_executor')){if($facts.TargetFramework -cne $expected.TargetFrameworkAttribute -or $facts.Platform -cne 'Amd64'){throw "SafeRead target $year host/certified executor has wrong framework/platform."}}elseif(-not(Test-SafeReadDependencyAssemblyCompatibility ([string]$facts.TargetFramework) ([string]$facts.Platform) $expected.Framework)){throw "SafeRead target $year runtime dependency is not framework/platform compatible."}
      $revitRefs=@($facts.AssemblyReferences|Where-Object{$_.name -ceq 'RevitAPI'});$uiRefs=@($facts.AssemblyReferences|Where-Object{$_.name -ceq 'RevitAPIUI'})
      if ([bool]$item.revitApiBound) {
        if($revitRefs.Count -ne 1 -or (Get-SafeReadAssemblyIdentityKey $revitRefs[0]) -cne (Get-SafeReadAssemblyIdentityKey $api.identity)){throw "SafeRead target $year contains a cross-year or mismatched RevitAPI identity."}
        if($item.role -ceq 'host' -and ($uiRefs.Count -ne 1 -or (Get-SafeReadAssemblyIdentityKey $uiRefs[0]) -cne (Get-SafeReadAssemblyIdentityKey $apiUi.identity))){throw "SafeRead target $year host contains a mismatched RevitAPIUI identity."}
        if($item.role -ceq 'certified_executor' -and $uiRefs.Count){throw "SafeRead target $year certified executor may not reference RevitAPIUI."}
      }elseif($revitRefs.Count -or $uiRefs.Count){throw "SafeRead target $year runtime dependency may not reference RevitAPI/RevitAPIUI."}
      if($item.role -ceq 'certified_executor'){
        Assert-SafeReadExactProperties $item.provenance @('proofReceiptSha256','unsignedSha256','equivalenceReceiptSha256','canonicalPeSha256','verifierProfileId','verifierProfileSha256','verifierBundleSha256') "SafeRead target $year certified executor provenance"
        foreach($hash in $item.provenance.proofReceiptSha256,$item.provenance.unsignedSha256,$item.provenance.equivalenceReceiptSha256){if($hash -cnotmatch '^sha256:[0-9a-f]{64}$'){throw "SafeRead target $year executor provenance hash is invalid."}}
        if($item.provenance.canonicalPeSha256 -cnotmatch '^[0-9a-f]{64}$' -or [string]::IsNullOrWhiteSpace([string]$item.provenance.verifierProfileId) -or $item.provenance.verifierProfileSha256 -cnotmatch '^[0-9a-f]{64}$' -or $item.provenance.verifierBundleSha256 -cnotmatch '^[0-9a-f]{64}$'){throw "SafeRead target $year proof equivalence provenance is invalid."}
      }elseif($null -ne $item.provenance){throw "SafeRead target $year non-executor payload has proof provenance."}
    }
    Assert-SafeReadDependencyClosure $payload $expected.Framework $year
    $proofPath=Join-Path $targetRoot 'proof\proof.receipt.json'
    $proofReceipt=ConvertTo-SafeReadObject $proofPath
    Assert-SafeReadExactProperties $proofReceipt @('schemaVersion','proofKind','mode','status','certified','manifestSha256','verifierProfileId','verifierProfileSha256','verifierBundleSha256','sourceLockSha256','apiLockSha256','sdkLockSha256','trustBoundary','compilerOptions','issues','observation','artifacts') "SafeRead target $year preserved proof receipt"
    if([int]$proofReceipt.schemaVersion -ne 1 -or $proofReceipt.proofKind -cne $script:ProofKind -or $proofReceipt.mode -cne 'check' -or $proofReceipt.status -cne 'verified' -or -not [bool]$proofReceipt.certified -or @($proofReceipt.issues).Count -ne 0 -or $proofReceipt.verifierProfileId -cne 'revit-safe-read-sheet-count-kernel/v1'){throw "SafeRead target $year preserved proof receipt is not certified."}
    foreach($lockHash in $proofReceipt.manifestSha256,$proofReceipt.verifierProfileSha256,$proofReceipt.verifierBundleSha256,$proofReceipt.sourceLockSha256,$proofReceipt.apiLockSha256,$proofReceipt.sdkLockSha256){if($lockHash -cnotmatch '^[0-9a-f]{64}$'){throw "SafeRead target $year proof receipt lock hash is invalid."}}
    if((@($proofReceipt.artifacts.PSObject.Properties.Name|Sort-Object)-join ',') -cne '2023,2024,2025'){throw "SafeRead target $year proof receipt does not cover exactly all supported years."}
    $preservedArtifactProperty=@($proofReceipt.artifacts.PSObject.Properties|Where-Object Name -ceq $year);if($preservedArtifactProperty.Count -ne 1){throw "SafeRead target $year preserved proof receipt omits its artifact."};$preservedArtifact=$preservedArtifactProperty[0].Value
    Assert-SafeReadExactProperties $preservedArtifact @('fileName','sha256','length','managedCodeSha256','assemblyIdentity','targetFramework','platform') "SafeRead target $year preserved proof artifact"
    Assert-SafeReadExactProperties $target.proof @('path','sha256','sizeBytes','artifactUnsignedSha256','equivalencePath','equivalenceSha256') "SafeRead target $year proof evidence"
    $equivalencePath=Join-Path $targetRoot 'proof\artifact.equivalence.json'
    if($target.proof.path -cne 'proof/proof.receipt.json' -or $target.proof.equivalencePath -cne 'proof/artifact.equivalence.json' -or (Get-SafeReadSha256 $proofPath) -cne $target.proof.sha256 -or (Get-Item -LiteralPath $proofPath).Length -ne [int64]$target.proof.sizeBytes -or (Get-SafeReadSha256 $equivalencePath) -cne $target.proof.equivalenceSha256 -or $target.proof.sha256 -cne $executorPayload[0].provenance.proofReceiptSha256 -or $target.proof.equivalenceSha256 -cne $executorPayload[0].provenance.equivalenceReceiptSha256 -or ('sha256:'+$target.proof.artifactUnsignedSha256) -cne $executorPayload[0].provenance.unsignedSha256 -or $preservedArtifact.fileName -cne "RevitOperator.SafeReadCertifiedExecution.Revit$year.dll" -or $preservedArtifact.sha256 -cne $target.proof.artifactUnsignedSha256 -or [int64]$preservedArtifact.length -le 0 -or $preservedArtifact.assemblyIdentity -cnotmatch '^RevitOperator\.SafeReadCertifiedExecution, Version=[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+, Culture=neutral, PublicKeyToken=null$' -or $preservedArtifact.targetFramework -cne $expected.TargetFrameworkAttribute -or $preservedArtifact.platform -cne 'x64'){throw "SafeRead target $year proof evidence does not bind the certified executor."}
    $equivalence=ConvertTo-SafeReadObject $equivalencePath
    Assert-SafeReadExactProperties $equivalence @('schemaVersion','status','equivalent','proofReceiptSha256','revitYear','artifactFileName','unsignedSha256','unsignedLength','candidateSha256','candidateLength','canonicalPeSha256','verifierProfileId','verifierProfileSha256','verifierBundleSha256','allowedDifferences','issues') "SafeRead target $year equivalence receipt"
    if([int]$equivalence.schemaVersion -ne 1 -or $equivalence.status -cne 'verified' -or -not [bool]$equivalence.equivalent -or @($equivalence.issues).Count -ne 0 -or ('sha256:'+$equivalence.proofReceiptSha256) -cne $target.proof.sha256 -or $equivalence.revitYear -cne $year -or ('sha256:'+$equivalence.unsignedSha256) -cne $executorPayload[0].provenance.unsignedSha256 -or ('sha256:'+$equivalence.candidateSha256) -cne $executorPayload[0].sha256 -or $equivalence.candidateLength -ne [int64]$executorPayload[0].sizeBytes -or $equivalence.canonicalPeSha256 -cne $executorPayload[0].provenance.canonicalPeSha256 -or $equivalence.verifierProfileId -cne $executorPayload[0].provenance.verifierProfileId -or $equivalence.verifierProfileSha256 -cne $executorPayload[0].provenance.verifierProfileSha256 -or $equivalence.verifierBundleSha256 -cne $executorPayload[0].provenance.verifierBundleSha256){throw "SafeRead target $year signed PE equivalence receipt does not bind the packaged executor."}
    $preservedProofHashes += $target.proof.sha256
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
  if(@($preservedProofHashes|Sort-Object -Unique).Count -ne 1){throw 'SafeRead targets do not preserve one exact three-year proof receipt.'}
  [pscustomobject]@{ ReleaseId=$release.releaseId; ReleaseManifestSha256=Get-SafeReadSha256 $manifestPath; AttestationSha256=Get-SafeReadSha256 $pinsPath; Source=$source; SourceReceipt=$sourceReceipt; Targets=$targets; RuntimeAttestationPins=$pinTargets }
}

function Get-SafeReadUtf8Sha256 {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Content)
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Content)
  $sha=[Security.Cryptography.SHA256]::Create()
  try{'sha256:'+([BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant())}finally{$sha.Dispose()}
}

function Test-SafeReadPathWithin {
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Root)
  $full=[IO.Path]::GetFullPath($Path).TrimEnd([char]92,[char]47)
  $rootFull=[IO.Path]::GetFullPath($Root).TrimEnd([char]92,[char]47)
  if($full.Equals($rootFull,[StringComparison]::OrdinalIgnoreCase)){return $true}
  $full.StartsWith($rootFull+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)
}

function Test-SafeReadAutodeskAddinsPath {
  param([Parameter(Mandatory)][string]$Path)
  $normalized=[IO.Path]::GetFullPath($Path).Replace([char]47,[char]92)
  $normalized -match '(?i)(^|\\)Autodesk\\Revit\\Addins($|\\)'
}

function Resolve-SafeReadManifestAssemblyRoot {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path)
  if(-not[IO.Path]::IsPathRooted($Path)){throw 'SafeRead admission manifest assembly root must be an absolute path.'}
  $full=[IO.Path]::GetFullPath($Path)
  $volume=[IO.Path]::GetPathRoot($full)
  if($full.TrimEnd([char]92,[char]47).Equals($volume.TrimEnd([char]92,[char]47),[StringComparison]::OrdinalIgnoreCase)){throw 'SafeRead admission manifest assembly root may not be a volume root.'}
  $resolved=Resolve-SafeReadCanonicalPath $full -AllowMissingLeaf
  if((Test-Path -LiteralPath $resolved) -and -not(Test-Path -LiteralPath $resolved -PathType Container)){throw 'SafeRead admission manifest assembly root must be a directory or a missing directory leaf.'}
  $resolved.TrimEnd([char]92,[char]47)
}

function Resolve-SafeReadAdmissionOutputPath {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$CoordinationRoot,
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$ManifestAssemblyRoot
  )
  $coordination=Resolve-SafeReadCanonicalPath $CoordinationRoot
  if(-not(Test-Path -LiteralPath $coordination -PathType Container)){throw 'SafeRead admission coordination root must be an existing directory.'}
  $coordinationVolume=[IO.Path]::GetPathRoot($coordination)
  if($coordination.TrimEnd([char]92,[char]47).Equals($coordinationVolume.TrimEnd([char]92,[char]47),[StringComparison]::OrdinalIgnoreCase)){throw 'SafeRead admission coordination root may not be a volume root.'}
  $bundle=Resolve-SafeReadCanonicalPath $BundleRoot
  $manifestRoot=Resolve-SafeReadManifestAssemblyRoot $ManifestAssemblyRoot
  $output=Resolve-SafeReadCanonicalPath $OutputPath -AllowMissingLeaf
  if([IO.Path]::GetExtension($output) -cne '.json'){throw 'SafeRead admission output must have the exact .json extension.'}
  if((Split-Path -Parent $output) -cne $coordination){throw 'SafeRead admission output must be a direct child of the canonical coordination root.'}
  if(Test-Path -LiteralPath $output){throw "Refusing to overwrite an existing SafeRead admission receipt: $output"}
  if((Test-SafeReadAutodeskAddinsPath $coordination) -or (Test-SafeReadAutodeskAddinsPath $output)){throw 'SafeRead admission output may not be written into an Autodesk Revit Addins tree.'}
  if((Test-SafeReadPathWithin $coordination $bundle) -or (Test-SafeReadPathWithin $output $bundle)){throw 'SafeRead admission output may not be written into the package bundle.'}
  if((Test-SafeReadPathWithin $coordination $manifestRoot) -or (Test-SafeReadPathWithin $output $manifestRoot)){throw 'SafeRead admission output may not be written into the manifest assembly root.'}
  $output
}

function Initialize-SafeReadAtomicNewFilePublisher {
  if(('SafeRead.AtomicNewFilePublisher' -as [type])){return}
  Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

namespace SafeRead
{
    public static class AtomicNewFilePublisher
    {
        private const uint DELETE = 0x00010000;
        private const uint FILE_READ_ATTRIBUTES = 0x00000080;
        private const uint GENERIC_WRITE = 0x40000000;
        private const uint FILE_SHARE_READ = 0x00000001;
        private const uint FILE_SHARE_WRITE = 0x00000002;
        private const uint CREATE_NEW = 1;
        private const uint OPEN_EXISTING = 3;
        private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
        private const uint FILE_ATTRIBUTE_TEMPORARY = 0x00000100;
        private const uint FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
        private const uint FILE_FLAG_WRITE_THROUGH = 0x80000000;
        private const uint FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
        private const uint FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
        private const int FileRenameInfo = 3;
        private const int FileDispositionInfo = 4;
        private const int ERROR_FILE_EXISTS = 80;
        private const int ERROR_ALREADY_EXISTS = 183;
        private static readonly IntPtr InvalidHandleValue = new IntPtr(-1);

        [StructLayout(LayoutKind.Sequential)]
        private struct ByHandleFileInformation
        {
            public uint FileAttributes;
            public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
            public uint VolumeSerialNumber;
            public uint FileSizeHigh;
            public uint FileSizeLow;
            public uint NumberOfLinks;
            public uint FileIndexHigh;
            public uint FileIndexLow;
        }

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateFileW(
            string fileName,
            uint desiredAccess,
            uint shareMode,
            IntPtr securityAttributes,
            uint creationDisposition,
            uint flagsAndAttributes,
            IntPtr templateFile);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CloseHandle(IntPtr handle);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool DeleteFileW(string fileName);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool GetFileInformationByHandle(IntPtr handle, out ByHandleFileInformation information);

        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint pathLength, uint flags);

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool SetFileInformationByHandle(
            IntPtr handle,
            int informationClass,
            IntPtr information,
            uint bufferSize);

        private static Win32Exception NativeError(string action)
        {
            int error = Marshal.GetLastWin32Error();
            return new Win32Exception(error, action + " failed: " + new Win32Exception(error).Message);
        }

        private static string NormalizePath(string path)
        {
            string normalized = path;
            if (normalized.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase))
                normalized = @"\\" + normalized.Substring(8);
            else if (normalized.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase))
                normalized = normalized.Substring(4);
            return Path.GetFullPath(normalized).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }

        private static string GetFinalPath(IntPtr handle)
        {
            var buffer = new StringBuilder(512);
            uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0) throw NativeError("Reading the bound path");
            if (length >= buffer.Capacity)
            {
                buffer = new StringBuilder(checked((int)length + 1));
                length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
                if (length == 0 || length >= buffer.Capacity) throw NativeError("Reading the bound path");
            }
            return NormalizePath(buffer.ToString(0, checked((int)length)));
        }

        private static IntPtr OpenBoundDirectory(string canonicalDirectory)
        {
            IntPtr handle = CreateFileW(
                canonicalDirectory,
                FILE_READ_ATTRIBUTES,
                FILE_SHARE_READ | FILE_SHARE_WRITE,
                IntPtr.Zero,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                IntPtr.Zero);
            if (handle == InvalidHandleValue) throw NativeError("Binding the SafeRead admission coordination root");
            return handle;
        }

        private static ByHandleFileInformation ReadIdentity(IntPtr handle, string expectedPath)
        {
            ByHandleFileInformation information;
            if (!GetFileInformationByHandle(handle, out information))
                throw NativeError("Reading the SafeRead admission coordination root identity");
            if ((information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
                throw new IOException("SafeRead admission coordination root may not be a link or reparse point.");
            if (!String.Equals(GetFinalPath(handle), NormalizePath(expectedPath), StringComparison.OrdinalIgnoreCase))
                throw new IOException("SafeRead admission coordination root changed identity before publication.");
            return information;
        }

        private static bool SameIdentity(ByHandleFileInformation left, ByHandleFileInformation right)
        {
            return left.VolumeSerialNumber == right.VolumeSerialNumber &&
                   left.FileIndexHigh == right.FileIndexHigh &&
                   left.FileIndexLow == right.FileIndexLow;
        }

        private static string IdentityToken(ByHandleFileInformation information)
        {
            return information.VolumeSerialNumber.ToString("x8") + ":" +
                   information.FileIndexHigh.ToString("x8") + ":" +
                   information.FileIndexLow.ToString("x8");
        }

        public static string CaptureDirectoryIdentity(string canonicalDirectory)
        {
            canonicalDirectory = NormalizePath(canonicalDirectory);
            IntPtr handle = OpenBoundDirectory(canonicalDirectory);
            try { return IdentityToken(ReadIdentity(handle, canonicalDirectory)); }
            finally { CloseHandle(handle); }
        }

        private static void RevalidateBoundDirectory(IntPtr boundHandle, ByHandleFileInformation boundIdentity, string canonicalDirectory)
        {
            ReadIdentity(boundHandle, canonicalDirectory);
            IntPtr currentHandle = OpenBoundDirectory(canonicalDirectory);
            try
            {
                ByHandleFileInformation currentIdentity = ReadIdentity(currentHandle, canonicalDirectory);
                if (!SameIdentity(boundIdentity, currentIdentity))
                    throw new IOException("SafeRead admission coordination root was replaced before publication.");
            }
            finally
            {
                CloseHandle(currentHandle);
            }
        }

        private static void SetDeleteDisposition(IntPtr handle, bool deleteFile)
        {
            IntPtr disposition = Marshal.AllocHGlobal(1);
            try
            {
                Marshal.WriteByte(disposition, deleteFile ? (byte)1 : (byte)0);
                if (!SetFileInformationByHandle(handle, FileDispositionInfo, disposition, 1))
                    throw NativeError(deleteFile ? "Arming delete-on-close" : "Committing the published admission receipt");
            }
            finally
            {
                Marshal.FreeHGlobal(disposition);
            }
        }

        private static void RenameNoReplace(IntPtr handle, string targetPath)
        {
            byte[] fileName = Encoding.Unicode.GetBytes(targetPath);
            int rootOffset = IntPtr.Size == 8 ? 8 : 4;
            int lengthOffset = rootOffset + IntPtr.Size;
            int nameOffset = lengthOffset + 4;
            int bufferLength = checked(nameOffset + fileName.Length + 2);
            IntPtr rename = Marshal.AllocHGlobal(bufferLength);
            try
            {
                for (int index = 0; index < bufferLength; index++) Marshal.WriteByte(rename, index, 0);
                Marshal.WriteInt32(rename, 0, 0);
                Marshal.WriteIntPtr(rename, rootOffset, IntPtr.Zero);
                Marshal.WriteInt32(rename, lengthOffset, fileName.Length);
                Marshal.Copy(fileName, 0, IntPtr.Add(rename, nameOffset), fileName.Length);
                if (!SetFileInformationByHandle(handle, FileRenameInfo, rename, (uint)bufferLength))
                {
                    int error = Marshal.GetLastWin32Error();
                    if (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS)
                        throw new IOException("Refusing to overwrite an existing SafeRead admission receipt: " + targetPath);
                    throw new Win32Exception(error, "Publishing the SafeRead admission receipt failed: " + new Win32Exception(error).Message);
                }
            }
            finally
            {
                Marshal.FreeHGlobal(rename);
            }
        }

        public static string Publish(string canonicalDirectory, string expectedDirectoryIdentity, string targetLeafName, byte[] bytes)
        {
            if (bytes == null) throw new ArgumentNullException("bytes");
            if (String.IsNullOrWhiteSpace(expectedDirectoryIdentity)) throw new ArgumentException("The bound directory identity is required.", "expectedDirectoryIdentity");
            if (String.IsNullOrWhiteSpace(targetLeafName) ||
                !String.Equals(Path.GetFileName(targetLeafName), targetLeafName, StringComparison.Ordinal) ||
                targetLeafName == "." || targetLeafName == "..")
                throw new ArgumentException("SafeRead admission target must be one exact leaf name.", "targetLeafName");

            canonicalDirectory = NormalizePath(canonicalDirectory);
            string targetPath = Path.Combine(canonicalDirectory, targetLeafName);
            IntPtr directoryHandle = InvalidHandleValue;
            IntPtr fileHandle = InvalidHandleValue;
            string temporaryPath = null;
            bool stagingCreated = false;
            bool published = false;
            try
            {
                directoryHandle = OpenBoundDirectory(canonicalDirectory);
                ByHandleFileInformation directoryIdentity = ReadIdentity(directoryHandle, canonicalDirectory);
                if (!String.Equals(IdentityToken(directoryIdentity), expectedDirectoryIdentity, StringComparison.Ordinal))
                    throw new IOException("SafeRead admission coordination root was replaced after validation.");

                for (int attempt = 0; attempt < 16; attempt++)
                {
                    temporaryPath = Path.Combine(canonicalDirectory, ".safe-read-admission." + Guid.NewGuid().ToString("N") + ".tmp");
                    fileHandle = CreateFileW(
                        temporaryPath,
                        GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
                        0,
                        IntPtr.Zero,
                        CREATE_NEW,
                        FILE_ATTRIBUTE_NORMAL | FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_WRITE_THROUGH | FILE_FLAG_OPEN_REPARSE_POINT,
                        IntPtr.Zero);
                    if (fileHandle != InvalidHandleValue) break;
                    int error = Marshal.GetLastWin32Error();
                    if (error != ERROR_FILE_EXISTS && error != ERROR_ALREADY_EXISTS)
                        throw new Win32Exception(error, "Creating the private SafeRead admission staging file failed: " + new Win32Exception(error).Message);
                }
                if (fileHandle == InvalidHandleValue)
                    throw new IOException("Could not allocate a private SafeRead admission staging file.");
                stagingCreated = true;

                SetDeleteDisposition(fileHandle, true);

                using (var borrowedHandle = new SafeFileHandle(fileHandle, false))
                using (var stream = new FileStream(borrowedHandle, FileAccess.Write, 1048576, false))
                {
                    stream.Write(bytes, 0, bytes.Length);
                    stream.Flush(true);
                }

                RevalidateBoundDirectory(directoryHandle, directoryIdentity, canonicalDirectory);
                SetDeleteDisposition(fileHandle, false);
                try
                {
                    RenameNoReplace(fileHandle, targetPath);
                    string publishedPath = GetFinalPath(fileHandle);
                    if (!String.Equals(publishedPath, NormalizePath(targetPath), StringComparison.OrdinalIgnoreCase))
                        throw new IOException("SafeRead admission receipt did not publish to the bound canonical destination. Actual: " + publishedPath + "; expected: " + NormalizePath(targetPath));
                    published = true;
                }
                catch (Exception publicationError)
                {
                    // The file is still held with no sharing. Re-arm deletion so a
                    // lost destination race cannot strand a reusable staging file.
                    try { SetDeleteDisposition(fileHandle, true); }
                    catch (Exception cleanupError)
                    {
                        throw new IOException("SafeRead admission publication and private staging cleanup both failed.", new AggregateException(publicationError, cleanupError));
                    }
                    throw;
                }
                return targetPath;
            }
            finally
            {
                if (fileHandle != InvalidHandleValue) CloseHandle(fileHandle);
                if (stagingCreated && !published && temporaryPath != null) DeleteFileW(temporaryPath);
                if (directoryHandle != InvalidHandleValue) CloseHandle(directoryHandle);
            }
        }
    }
}
'@
}

function Publish-SafeReadAdmissionReceipt {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$OutputPath,
    [Parameter(Mandatory)][string]$CoordinationRoot,
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
    [Parameter(Mandatory)]$Receipt
  )
  Initialize-SafeReadAtomicNewFilePublisher
  $directoryIdentity=[SafeRead.AtomicNewFilePublisher]::CaptureDirectoryIdentity($CoordinationRoot)
  $output=Resolve-SafeReadAdmissionOutputPath -OutputPath $OutputPath -CoordinationRoot $CoordinationRoot -BundleRoot $BundleRoot -ManifestAssemblyRoot $ManifestAssemblyRoot
  $coordination=Resolve-SafeReadCanonicalPath $CoordinationRoot
  if((Split-Path -Parent $output) -cne $coordination){throw 'SafeRead admission output parent changed before publication.'}
  $bytes=[Text.UTF8Encoding]::new($false,$true).GetBytes((ConvertTo-SafeReadCanonicalJson $Receipt))
  [SafeRead.AtomicNewFilePublisher]::Publish($coordination,$directoryIdentity,(Split-Path -Leaf $output),$bytes)
}

function New-SafeReadAdmissionReceiptCore {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [Parameter(Mandatory)][string]$ManifestAssemblyRoot,
    [scriptblock]$SignatureVerifier,
    [scriptblock]$AssemblyInspector
  )
  $manifestAssemblyRoot=Resolve-SafeReadManifestAssemblyRoot $ManifestAssemblyRoot
  $verified=Assert-SafeReadBundle -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
  $root=(Resolve-Path -LiteralPath $BundleRoot).Path
  $releasePath=Join-Path $root 'release-manifest.json';$pinsPath=Join-Path $root 'package-pins.json'
  $release=ConvertTo-SafeReadObject $releasePath
  $allowed=@($release.allowedSignerThumbprints)
  $firstTarget=@($verified.Targets|Sort-Object revitYear)[0]
  $firstProofPath=Join-Path $root "targets\$($firstTarget.revitYear)\proof\proof.receipt.json"
  $commonProof=ConvertTo-SafeReadObject $firstProofPath
  $proofTargetPaths=@(@('2023','2024','2025')|ForEach-Object{"targets/$_/proof/proof.receipt.json"})
  $targets=@()
  foreach($target in @($verified.Targets|Sort-Object revitYear)){
    $year=[string]$target.revitYear;$targetRoot=Join-Path $root "targets\$year"
    $host=@($target.requiredPayload|Where-Object role -ceq 'host')[0]
    $executor=@($target.requiredPayload|Where-Object role -ceq 'certified_executor')[0]
    $hostPath=Join-Path $targetRoot ($host.path.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $executorPath=Join-Path $targetRoot ($executor.path.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $hostSigner=Get-SafeReadSignatureEvidence -Path $hostPath -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
    $executorSigner=Get-SafeReadSignatureEvidence -Path $executorPath -AllowedSignerThumbprints $allowed -SignatureVerifier $SignatureVerifier
    $equivalencePath=Join-Path $targetRoot ($target.proof.equivalencePath.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $equivalence=ConvertTo-SafeReadObject $equivalencePath
    $runtimePath=Join-Path $targetRoot ($target.runtimeAttestation.path.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $runtime=ConvertTo-SafeReadObject $runtimePath
    $assemblyPath=[IO.Path]::GetFullPath((Join-Path $manifestAssemblyRoot "targets\$year\payload\$script:HostDll"))
    $templatePath=Join-Path $targetRoot ($target.manifest.path.Replace('/',[IO.Path]::DirectorySeparatorChar))
    $manifestContent=New-SafeReadInstalledManifest -TemplatePath $templatePath -AssemblyPath $assemblyPath
    $manifestBytes=[Text.UTF8Encoding]::new($false).GetByteCount($manifestContent)
    $targets += [ordered]@{
      revitYear=$year
      framework=[string]$target.framework
      host=[ordered]@{path=[string]$host.path;sha256=[string]$host.sha256;sizeBytes=[int64]$host.sizeBytes;mvid=[string]$host.assembly.mvid;signerThumbprint=[string]$hostSigner.thumbprint}
      executor=[ordered]@{path=[string]$executor.path;sha256=[string]$executor.sha256;sizeBytes=[int64]$executor.sizeBytes;mvid=[string]$executor.assembly.mvid;signerThumbprint=[string]$executorSigner.thumbprint;equivalence=[ordered]@{path=[string]$target.proof.equivalencePath;sha256=[string]$target.proof.equivalenceSha256;unsignedSha256=('sha256:'+[string]$equivalence.unsignedSha256);candidateSha256=('sha256:'+[string]$equivalence.candidateSha256);canonicalPeSha256=[string]$equivalence.canonicalPeSha256}}
      runtimeAttestation=[ordered]@{path=[string]$target.runtimeAttestation.path;sha256=[string]$target.runtimeAttestation.sha256;sizeBytes=[int64]$target.runtimeAttestation.sizeBytes;state=[string]$runtime.state;issuedAtUtc=[string]$runtime.issued_at_utc;expiresAtUtc=[string]$runtime.expires_at_utc;routeId=[string]$runtime.route_id;routeContractSha256=[string]$runtime.route_contract_sha256;policySha256=[string]$runtime.policy_sha256;proofSha256=[string]$runtime.proof_sha256;executorId=[string]$runtime.executor_id;runtimeTuple=[ordered]@{hostContentSha256=[string]$runtime.runtime_tuple.host_content_sha256;hostMvid=[string]$runtime.runtime_tuple.host_mvid;revitApiContentSha256=[string]$runtime.runtime_tuple.revit_api_content_sha256;revitApiMvid=[string]$runtime.runtime_tuple.revit_api_mvid;revitVersion=[string]$runtime.runtime_tuple.revit_version}}
      renderedManifest=[ordered]@{fileName=$script:InstalledManifestName;sha256=Get-SafeReadUtf8Sha256 $manifestContent;sizeBytes=[int64]$manifestBytes;encoding='utf-8-no-bom';fields=[ordered]@{name=$script:Identity.Name;assembly=$assemblyPath;fullClassName=$script:Identity.FullClassName;addInId=$script:Identity.AddInId;vendorId=$script:Identity.VendorId;vendorDescription=$script:Identity.VendorDescription}}
    }
  }
  [pscustomobject][ordered]@{
    schema=$script:AdmissionReceiptSchema
    status='verified'
    releaseId=[string]$verified.ReleaseId
    releaseManifest=[ordered]@{path='release-manifest.json';sha256=[string]$verified.ReleaseManifestSha256}
    packagePins=[ordered]@{path='package-pins.json';externalSha256=[string]$AttestationPinSha256}
    source=[ordered]@{path=[string]$verified.Source.path;sha256=[string]$verified.Source.sha256;commit=[string]$verified.Source.commit;proofTree=[string]$verified.Source.proofTree;hostTree=[string]$verified.Source.hostTree;archiveSha256=[string]$verified.Source.archiveSha256}
    proof=[ordered]@{targetPaths=$proofTargetPaths;sha256=[string]$firstTarget.proof.sha256;proofKind=[string]$commonProof.proofKind;manifestSha256=[string]$commonProof.manifestSha256;verifierProfileId=[string]$commonProof.verifierProfileId;verifierProfileSha256=[string]$commonProof.verifierProfileSha256;verifierBundleSha256=[string]$commonProof.verifierBundleSha256;sourceLockSha256=[string]$commonProof.sourceLockSha256;apiLockSha256=[string]$commonProof.apiLockSha256;sdkLockSha256=[string]$commonProof.sdkLockSha256}
    manifestAssemblyRoot=$manifestAssemblyRoot
    targets=$targets
  }
}

function New-SafeReadAdmissionReceipt {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [Parameter(Mandatory)][string]$ManifestAssemblyRoot
  )
  New-SafeReadAdmissionReceiptCore -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ManifestAssemblyRoot
}

function Assert-SafeReadAdmissionReceiptCore {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ReceiptPath,
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [Parameter(Mandatory)][string]$ExpectedManifestAssemblyRoot,
    [scriptblock]$SignatureVerifier,
    [scriptblock]$AssemblyInspector
  )
  $resolved=Resolve-SafeReadCanonicalPath $ReceiptPath
  $receipt=ConvertTo-SafeReadObject $resolved
  Assert-SafeReadExactProperties $receipt @('schema','status','releaseId','releaseManifest','packagePins','source','proof','manifestAssemblyRoot','targets') 'SafeRead admission receipt'
  if($receipt.schema -cne $script:AdmissionReceiptSchema -or $receipt.status -cne 'verified'){throw 'SafeRead admission receipt schema/status is invalid.'}
  $canonical=ConvertTo-SafeReadCanonicalJson $receipt
  Assert-SafeReadCanonicalJsonBytes $resolved $receipt 'SafeRead admission receipt'
  $expected=New-SafeReadAdmissionReceiptCore -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ManifestAssemblyRoot $ExpectedManifestAssemblyRoot -SignatureVerifier $SignatureVerifier -AssemblyInspector $AssemblyInspector
  if($canonical -cne (ConvertTo-SafeReadCanonicalJson $expected)){throw 'SafeRead admission receipt does not match the externally verified package and preparation facts.'}
  $receipt
}

function Assert-SafeReadAdmissionReceipt {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory)][string]$ReceiptPath,
    [Parameter(Mandatory)][string]$BundleRoot,
    [Parameter(Mandatory)][string]$AttestationPinSha256,
    [Parameter(Mandatory)][string]$ExpectedManifestAssemblyRoot
  )
  Assert-SafeReadAdmissionReceiptCore -ReceiptPath $ReceiptPath -BundleRoot $BundleRoot -AttestationPinSha256 $AttestationPinSha256 -ExpectedManifestAssemblyRoot $ExpectedManifestAssemblyRoot
}

function Write-SafeReadAtomicFile {
  [CmdletBinding()]
  param([Parameter(Mandatory)][string]$Path,[Parameter(Mandatory)][string]$Content)
  $directory = Split-Path -Parent $Path; New-Item -ItemType Directory -Force -Path $directory | Out-Null
  $temporary = Join-Path $directory ('.{0}.{1}.tmp' -f (Split-Path -Leaf $Path),[guid]::NewGuid().ToString('N'))
  [IO.File]::WriteAllText($temporary,$Content,[Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,("{0}.previous.{1}" -f $Path,[guid]::NewGuid().ToString('N'))) } else { Move-Item -LiteralPath $temporary -Destination $Path }
}

Export-ModuleMember -Function Assert-SafeReadAclRecord,Assert-SafeReadStrictAclRecord,Assert-SafeReadAdmissionReceipt,Assert-SafeReadBundle,Assert-SafeReadExactProperties,Assert-SafeReadManifestXml,Assert-SafeReadReleaseId,Assert-SafeReadRelativePath,Assert-SafeReadDependencyClosure,Assert-SafeReadSecureTree,Assert-SafeReadStrictTree,ConvertTo-SafeReadCanonicalAssemblyReferences,ConvertTo-SafeReadCanonicalJson,ConvertTo-SafeReadHashtable,ConvertTo-SafeReadObject,Get-SafeReadAclRecord,Get-SafeReadAssemblyFacts,Get-SafeReadAssemblyIdentityKey,Get-SafeReadExpectedTarget,Get-SafeReadProofArtifact,Get-SafeReadRevitApiFacts,Get-SafeReadSha256,Get-SafeReadSignatureEvidence,Get-SafeReadUtf8Sha256,Invoke-SafeReadSignatureVerification,New-SafeReadAdmissionReceipt,New-SafeReadAssemblyIdentity,New-SafeReadInstalledManifest,Protect-SafeReadPathAcl,Protect-SafeReadTreeAcl,Publish-SafeReadAdmissionReceipt,Resolve-SafeReadAdmissionOutputPath,Resolve-SafeReadCanonicalPath,Resolve-SafeReadManifestAssemblyRoot,Test-SafeReadDependencyAssemblyCompatibility,Test-SafeReadRuntimeProvidedAssembly,Write-SafeReadAtomicFile
