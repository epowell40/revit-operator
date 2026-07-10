param(
  [Parameter(Mandatory = $true)]
  [string]$BundleRoot,
  [string]$RevitYear = "2024",
  [switch]$ForceClientConfig,
  [string]$SigningThumbprint,
  [string]$SignToolPath,
  [string]$TimestampUrl = "http://ts.ssl.com"
)

$ErrorActionPreference = "Stop"

$payloadDir = Join-Path $BundleRoot "payload/RevitOperator"
$flatDll = Join-Path $payloadDir "RevitBridge.dll"
$nestedDll = Join-Path $payloadDir "win-x64\\RevitBridge.dll"
if (!(Test-Path $flatDll) -and !(Test-Path $nestedDll)) {
  throw "Bundle payload missing RevitBridge.dll under: $payloadDir"
}

$addinDir = Join-Path $env:APPDATA ("Autodesk/Revit/Addins/{0}" -f $RevitYear)
$deployDir = Join-Path $addinDir "RevitOperator"
if (!(Test-Path $addinDir)) { New-Item -ItemType Directory -Force -Path $addinDir | Out-Null }
if (!(Test-Path $deployDir)) { New-Item -ItemType Directory -Force -Path $deployDir | Out-Null }

if (Get-Process -Name Revit -ErrorAction SilentlyContinue) {
  throw "Revit is running. Close Revit before installing the drop-in bundle."
}

Copy-Item -Force -Recurse (Join-Path $payloadDir "*") $deployDir

$deployDll = Join-Path $deployDir "RevitBridge.dll"
if (!(Test-Path $deployDll)) {
  $deployDll = Join-Path $deployDir "win-x64\\RevitBridge.dll"
}
if (!(Test-Path $deployDll)) {
  throw "Installed payload missing RevitBridge.dll under: $deployDir"
}
$addinPath = Join-Path $addinDir "RevitBridge.addin"
$clientId = "B2883307-2852-4740-9833-281048674F77"

function Disable-DuplicateRevitBridgeManifests {
  param(
    [Parameter(Mandatory = $true)]
    [string]$PrimaryManifestPath,
    [Parameter(Mandatory = $true)]
    [string]$RevitYear
  )

  $roots = @(
    (Join-Path $env:APPDATA ("Autodesk/Revit/Addins/{0}" -f $RevitYear)),
    (Join-Path $env:ProgramData ("Autodesk/Revit/Addins/{0}" -f $RevitYear))
  ) | Where-Object { Test-Path $_ }

  $duplicates = foreach ($root in $roots) {
    Get-ChildItem -Path $root -Filter "RevitBridge.addin" -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -ne $PrimaryManifestPath }
  }

  foreach ($manifest in $duplicates) {
    $disabledPath = "{0}.disabled.{1}" -f $manifest.FullName, (Get-Date -Format "yyyyMMdd-HHmmss")
    Move-Item -LiteralPath $manifest.FullName -Destination $disabledPath -Force
    Write-Host "Disabled duplicate RevitBridge manifest: $($manifest.FullName) -> $disabledPath"
  }
}

function Set-RevitUnsignedAddinTrust {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RevitYear,
    [Parameter(Mandatory = $true)]
    [string]$ClientId
  )

  $codeSigningKey = "HKCU:\Software\Autodesk\Revit\Autodesk Revit $RevitYear\CodeSigning"
  if (!(Test-Path $codeSigningKey)) {
    New-Item -Path $codeSigningKey -Force | Out-Null
  }

  New-ItemProperty -Path $codeSigningKey -Name $ClientId -PropertyType DWord -Value 1 -Force | Out-Null
  Write-Host "Trusted unsigned add-in in Revit CodeSigning registry: $ClientId"
}

function Sign-RevitOperatorAssemblies {
  param(
    [Parameter(Mandatory = $true)]
    [string]$DeployDir,
    [Parameter(Mandatory = $true)]
    [string]$SigningThumbprint,
    [Parameter(Mandatory = $true)]
    [string]$SignToolPath,
    [Parameter(Mandatory = $true)]
    [string]$TimestampUrl
  )

  if (!(Test-Path $SignToolPath)) {
    throw "signtool.exe not found: $SignToolPath"
  }

  $targets = Get-ChildItem -Path $DeployDir -Filter "RevitBridge*.dll" -File -ErrorAction SilentlyContinue
  if (!$targets) {
    throw "No RevitBridge*.dll files found under $DeployDir to sign."
  }

  foreach ($target in $targets) {
    & $SignToolPath sign /sha1 $SigningThumbprint /tr $TimestampUrl /td sha256 /fd sha256 $target.FullName
    if ($LASTEXITCODE -ne 0) {
      throw "signtool failed for $($target.FullName) with exit code $LASTEXITCODE"
    }
    Write-Host "Signed assembly: $($target.FullName)"
  }
}

if ($SigningThumbprint -or $SignToolPath) {
  if (!$SigningThumbprint -or !$SignToolPath) {
    throw "Provide both -SigningThumbprint and -SignToolPath when signing is enabled."
  }

  Sign-RevitOperatorAssemblies -DeployDir $deployDir -SigningThumbprint $SigningThumbprint -SignToolPath $SignToolPath -TimestampUrl $TimestampUrl
}

$xml = @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>RevitOperator</Name>
    <Assembly>$deployDll</Assembly>
    <FullClassName>RevitBridge.App</FullClassName>
    <AddInId>$clientId</AddInId>
    <VendorId>com.revitoperator</VendorId>
    <VendorDescription>Revit Operator</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
Set-Content -Path $addinPath -Value $xml -Encoding UTF8
Disable-DuplicateRevitBridgeManifests -PrimaryManifestPath $addinPath -RevitYear $RevitYear
Set-RevitUnsignedAddinTrust -RevitYear $RevitYear -ClientId $clientId

$bundleManifest = Join-Path $BundleRoot "manifest.json"
if (Test-Path $bundleManifest) {
  Copy-Item -Force $bundleManifest (Join-Path $deployDir "manifest.json")
}

$clientConfigSource = Join-Path $BundleRoot "config\operator-client.json"
$clientConfigDir = Join-Path $env:LOCALAPPDATA "RevitOperator\config"
$clientConfigDest = Join-Path $clientConfigDir "operator-client.json"
if (Test-Path $clientConfigSource) {
  if (!(Test-Path $clientConfigDest) -or $ForceClientConfig) {
    New-Item -ItemType Directory -Force -Path $clientConfigDir | Out-Null
    Copy-Item -Force $clientConfigSource $clientConfigDest
    Write-Host "Installed Operator client config: $clientConfigDest"
  } else {
    Write-Host "Operator client config already exists; leaving unchanged: $clientConfigDest"
  }
}

Write-Host "Installed Revit Operator bundle"
Write-Host "Addin manifest: $addinPath"
Write-Host "Assembly path:  $deployDll"
