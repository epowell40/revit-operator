[CmdletBinding()]
param([string]$PackageRoot = $PSScriptRoot)

function Get-OperatorBytesSha([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}

function Get-OperatorRegistrationText([string]$Assembly) {
  $escaped = [Security.SecurityElement]::Escape($Assembly)
  return @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns>
  <AddIn Type="Application">
    <Name>RevitOperator</Name>
    <Assembly>$escaped</Assembly>
    <FullClassName>RevitBridge.App</FullClassName>
    <AddInId>B2883307-2852-4740-9833-281048674F77</AddInId>
    <VendorId>com.revitoperator</VendorId>
    <VendorDescription>Revit Operator</VendorDescription>
  </AddIn>
</RevitAddIns>
"@
}

function Find-OperatorRegistrationBytes([string]$CurrentText, [string]$Assembly, [string]$ExpectedSha) {
  $replacement = '<Assembly>' + [Security.SecurityElement]::Escape($Assembly) + '</Assembly>'
  $replaced = [regex]::new('<Assembly>[^<]*</Assembly>').Replace($CurrentText, [Text.RegularExpressions.MatchEvaluator]{ param($m) $replacement }, 1)
  foreach ($text in @($replaced, (Get-OperatorRegistrationText $Assembly))) {
    $normalized = $text.Replace("`r`n", "`n").TrimEnd([char[]]"`r`n")
    foreach ($newline in @("`n", "`r`n")) {
      foreach ($ending in @('', $newline)) {
        foreach ($bom in @($false, $true)) {
          $encoding = [Text.UTF8Encoding]::new($bom)
          [byte[]]$bytes = $encoding.GetPreamble() + $encoding.GetBytes($normalized.Replace("`n", $newline) + $ending)
          if ((Get-OperatorBytesSha $bytes) -eq $ExpectedSha) { return [pscustomobject]@{ Bytes = $bytes } }
        }
      }
    }
  }
  throw 'Cannot reconstruct the exact managed registration. No registration changed; retain the output for support.'
}

function Assert-OperatorLocalPath([string]$Path) {
  $current = [IO.Path]::GetFullPath($Path)
  while ($current) {
    if ((Test-Path -LiteralPath $current) -and
        ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
      throw "Installation path contains a link/reparse point: $current. No recovery performed."
    }
    $current = [IO.Path]::GetDirectoryName($current)
  }
}

function Invoke-OperatorDeploy([string]$Exe, [string[]]$Arguments) {
  $output = & $Exe @Arguments --quiet 2>&1
  $code = $LASTEXITCODE
  try { $result = ($output | Out-String) | ConvertFrom-Json }
  catch { throw "Installer output could not be read (exit $code): $($output | Out-String)" }
  if ([int]$result.exitCode -ne $code) { throw 'Installer exit code and receipt disagree. Stop and retain the output.' }
  Write-Host $result.message
  if ($result.logPath) { Write-Host "Installer log: $($result.logPath)" }
  return $result
}

function Restore-OperatorRegistration([string]$Year, [string]$AddinPath) {
  $productRoot = Join-Path $env:LOCALAPPDATA 'RevitOperator'
  $statePath = Join-Path $productRoot 'deployment\state.json'
  Assert-OperatorLocalPath $statePath
  Assert-OperatorLocalPath $AddinPath
  [byte[]]$stateBytes = [IO.File]::ReadAllBytes($statePath)
  $state = [Text.Encoding]::UTF8.GetString($stateBytes).TrimStart([char]0xfeff) | ConvertFrom-Json
  Write-Host "Installed state format: $($state.schemaVersion); release: $($state.currentRelease)"
  if ($state.schemaVersion -notin @(1, 2, 3)) { throw 'Unknown installed state format. No recovery performed.' }
  $records = @($state.ownedAddinManifests | Where-Object { $_.revitYear -eq $Year -and $_.manifestPath -eq $AddinPath })
  if ($state.schemaVersion -eq 1) {
    if ([string]$state.currentRelease -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Invalid legacy release name.' }
    $oldRoot = Join-Path (Join-Path $productRoot 'releases') $state.currentRelease
    $oldPath = Join-Path $oldRoot 'manifest.json'
    Assert-OperatorLocalPath $oldPath
    $oldManifest = Get-Content -LiteralPath $oldPath -Raw | ConvertFrom-Json
    if ($oldManifest.schemaVersion -ne 1 -or $oldManifest.releaseVersion -ne $state.currentRelease) { throw 'Legacy release metadata mismatch.' }
    $components = @($oldManifest.components | Where-Object { $_.kind -eq 'revit-addin' -and $_.revitYear -eq $Year })
    if ($components.Count -ne 1 -or [string]$components[0].id -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') { throw 'Cannot identify the legacy Revit component.' }
    $assembly = Join-Path (Join-Path $oldRoot $components[0].id) 'RevitBridge.dll'
    Assert-OperatorLocalPath $assembly
    $dll = @($components[0].files | Where-Object { $_.path -eq 'RevitBridge.dll' })
    if ($dll.Count -ne 1 -or $dll[0].sha256 -notmatch '^[a-fA-F0-9]{64}$' -or
        (Get-FileHash -LiteralPath $assembly -Algorithm SHA256).Hash -ne $dll[0].sha256) { throw 'Legacy DLL does not match its installed manifest.' }
    # Schema-v1 ownership is derived exactly as DeploymentEngine.ResolveCurrentOwnership does.
    # BuildAddinXml in the Windows V22 updater uses CRLF, UTF-8 without BOM and no terminal newline.
    $canonical = (Get-OperatorRegistrationText $assembly).Replace("`r`n", "`n").TrimEnd([char[]]"`r`n").Replace("`n", "`r`n")
    $records = @([pscustomobject]@{
      assemblyPath = $assembly; manifestSha256 = (Get-OperatorBytesSha ([Text.UTF8Encoding]::new($false).GetBytes($canonical)))
      addInId = 'B2883307-2852-4740-9833-281048674F77'; fullClassName = 'RevitBridge.App'
    })
  }
  if ($records.Count -ne 1) { throw 'Cannot resolve one owned registration for this Revit year.' }
  $record = $records[0]
  $expected = [string]$record.manifestSha256
  $assembly = [IO.Path]::GetFullPath([string]$record.assemblyPath)
  $releases = [IO.Path]::GetFullPath((Join-Path $productRoot 'releases')) + '\'
  Assert-OperatorLocalPath $assembly
  if ($expected -notmatch '^[a-fA-F0-9]{64}$' -or $record.addInId -ne 'B2883307-2852-4740-9833-281048674F77' -or
      $record.fullClassName -ne 'RevitBridge.App' -or !$assembly.StartsWith($releases, [StringComparison]::OrdinalIgnoreCase) -or
      !(Test-Path -LiteralPath $assembly -PathType Leaf)) { throw 'Saved registration ownership cannot be validated.' }
  [byte[]]$original = [IO.File]::ReadAllBytes($AddinPath)
  if ($original.Length -gt 131072) { throw 'Registration is unexpectedly large.' }
  $hash = Get-OperatorBytesSha $original
  $text = [Text.Encoding]::UTF8.GetString($original).TrimStart([char]0xfeff)
  if ($text -match '<!DOCTYPE') { throw 'Registration contains a DTD. No recovery performed.' }
  [xml]$xml = $text
  $entries = @($xml.SelectNodes('/RevitAddIns/AddIn'))
  if ($entries.Count -ne 1 -or $entries[0].Name -ne 'RevitOperator' -or $entries[0].Type -ne 'Application' -or
      $entries[0].FullClassName -ne 'RevitBridge.App' -or $entries[0].AddInId -ne 'B2883307-2852-4740-9833-281048674F77') {
    throw 'Registration contains an unexpected add-in. No recovery performed.'
  }
  $restored = Find-OperatorRegistrationBytes $text $assembly $expected
  $backup = Join-Path $productRoot ('Logs\InstallRecovery\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
  Assert-OperatorLocalPath $backup
  [void][IO.Directory]::CreateDirectory($backup)
  [IO.File]::WriteAllBytes((Join-Path $backup 'RevitBridge.addin.before'), $original)
  [IO.File]::WriteAllBytes((Join-Path $backup 'state.json.before'), $stateBytes)
  Write-Host "Recovery backup: $backup"
  if ((Get-OperatorBytesSha ([IO.File]::ReadAllBytes($AddinPath))) -ne $hash -or
      (Get-OperatorBytesSha ([IO.File]::ReadAllBytes($statePath))) -ne (Get-OperatorBytesSha $stateBytes)) { throw 'Installation changed during recovery; no registration replaced.' }
  $temp = $AddinPath + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
  [IO.File]::WriteAllBytes($temp, $restored.Bytes)
  [IO.File]::Replace($temp, $AddinPath, (Join-Path $backup 'RevitBridge.addin.replaced'))
  if ((Get-OperatorBytesSha ([IO.File]::ReadAllBytes($AddinPath))) -ne $expected) { throw 'Restored registration hash mismatch.' }
  return [pscustomobject]@{ Path = $AddinPath; Original = $original; Expected = $expected; StatePath = $statePath; StateBytes = $stateBytes }
}

function Install-OperatorPackage([string]$Root) {
  $ErrorActionPreference = 'Stop'
  if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { throw 'Save work and close ALL Revit versions before installing.' }
  $rootFull = [IO.Path]::GetFullPath($Root)
  $manifestPath = Join-Path $rootFull 'manifest.json'
  $exe = Join-Path $rootFull 'OperatorDeploy.exe'
  $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  $components = @($manifest.components | Where-Object { $_.kind -eq 'revit-addin' })
  if ($components.Count -ne 1 -or [string]$components[0].revitYear -notmatch '^20[0-9]{2}$') { throw 'Expected one Revit year in this full workstation package.' }
  $year = [string]$components[0].revitYear
  $addin = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year\RevitBridge.addin"
  $bundle = Invoke-OperatorDeploy $exe @('validate', '--manifest', $manifestPath, '--bundle-only')
  if (!$bundle.ok) { throw 'Package validation failed. Retain the installer log.' }
  $plan = Invoke-OperatorDeploy $exe @('update', '--manifest', $manifestPath, '--dry-run')
  if (!$plan.ok) {
    $knownFailure = "Installer-owned Revit add-in manifest was modified and will not be replaced or removed: $addin"
    if ($plan.exitCode -ne 21 -or $plan.message -cne $knownFailure) { throw 'Installer preflight failed; no automatic registration recovery applies. Retain the installer log.' }
    $recovery = Restore-OperatorRegistration $year $addin
    $plan = Invoke-OperatorDeploy $exe @('update', '--manifest', $manifestPath, '--dry-run')
    if (!$plan.ok) {
      if ((Get-OperatorBytesSha ([IO.File]::ReadAllBytes($recovery.StatePath))) -eq (Get-OperatorBytesSha $recovery.StateBytes) -and
          (Get-OperatorBytesSha ([IO.File]::ReadAllBytes($addin))) -eq $recovery.Expected) {
        [IO.File]::WriteAllBytes($addin, $recovery.Original)
        Write-Host 'Preflight refused; original registration restored.'
      }
      throw 'Installer still refuses recovery. No update started. Retain the output and backup.'
    }
  }
  $update = Invoke-OperatorDeploy $exe @('update', '--manifest', $manifestPath)
  if (!$update.ok) { throw 'Update failed. Shortcut was not refreshed. Retain the installer log.' }
  $validation = Invoke-OperatorDeploy $exe @('validate')
  if (!$validation.ok -or $validation.releaseVersion -ne $manifest.releaseVersion) { throw 'Installed validation failed or the active release differs. Retain the installer log.' }
  $shortcut = Join-Path $rootFull 'operator-desktop-pilot\operator-desktop\scripts\install_desktop_shortcut.ps1'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $shortcut -TargetMode Installed
  if ($LASTEXITCODE -ne 0) { throw 'Installation validated, but desktop shortcut creation failed.' }
  Write-Host "INSTALLATION AND VALIDATION PASSED: $($manifest.releaseVersion), Revit $year." -ForegroundColor Green
  Write-Host 'Restart Windows if an older Operator was running, then open Revit and Operator Desktop.'
}

# Dot-sourcing exposes the same helpers for isolated executable-boundary tests.
if ($MyInvocation.InvocationName -ne '.') {
  try { Install-OperatorPackage $PackageRoot; exit 0 }
  catch { Write-Host "STOP: $($_.Exception.Message)" -ForegroundColor Red; Write-Host 'Do not delete installer state or other add-ins. Send the final output and installer log to support.'; exit 1 }
}
