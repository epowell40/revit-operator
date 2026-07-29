[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$RepositoryRoot,
  [Parameter(Mandatory)][string]$OutputRoot
)
$ErrorActionPreference='Stop'
function Add-TestAuthenticodeCertificateTable([string]$Path){
  $bytes=[IO.File]::ReadAllBytes($Path);$pe=[BitConverter]::ToInt32($bytes,0x3c);$optional=$pe+24;$magic=[BitConverter]::ToUInt16($bytes,$optional)
  $directories=if($magic -eq 0x10b){$optional+96}elseif($magic -eq 0x20b){$optional+112}else{throw 'Unsupported PE.'};$security=$directories+32
  $certificateOffset=[int]([Math]::Ceiling($bytes.Length/8.0)*8);$signed=New-Object byte[] ($certificateOffset+16);[Array]::Copy($bytes,$signed,$bytes.Length)
  [BitConverter]::GetBytes([uint32]$certificateOffset).CopyTo($signed,$security);[BitConverter]::GetBytes([uint32]16).CopyTo($signed,$security+4);[BitConverter]::GetBytes([uint32]16).CopyTo($signed,$certificateOffset);[BitConverter]::GetBytes([uint16]0x0200).CopyTo($signed,$certificateOffset+4);[BitConverter]::GetBytes([uint16]0x0002).CopyTo($signed,$certificateOffset+6);[Text.Encoding]::ASCII.GetBytes('TESTCERT').CopyTo($signed,$certificateOffset+8);[IO.File]::WriteAllBytes($Path,$signed)
}
& (Join-Path $PSScriptRoot '..\build_saferead_package_v2.ps1') `
  -InputManifestPath (Join-Path $PSScriptRoot 'fixtures\saferead-package-build-input.v3.json') `
  -OutputRoot $OutputRoot `
  -RepositoryRoot $RepositoryRoot `
  -SignFileAction {param($Path,$Year,$Item)if($Item.role -eq 'certified_executor'){Add-TestAuthenticodeCertificateTable $Path}} `
  -SignatureVerifier {param($Path)[pscustomobject]@{Status='Valid';Thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}}
