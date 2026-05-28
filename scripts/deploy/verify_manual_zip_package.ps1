[CmdletBinding(PositionalBinding = $false)]
param(
  [string[]]$PackagePath = @(),
  [long]$MinimumBytes = 35000000,
  [string[]]$Url = @()
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

if (($PackagePath.Count + $Url.Count) -eq 0) {
  throw "Pass one or more -PackagePath or -Url values."
}

$PackagePath = @($PackagePath | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim().Trim("'").Trim('"') } | Where-Object { $_ })
$Url = @($Url | ForEach-Object { $_ -split "," } | ForEach-Object { $_.Trim().Trim("'").Trim('"') } | Where-Object { $_ })

$tempDir = $null
$packages = @()

try {
  if ($Url.Count -gt 0) {
    $tempDir = Join-Path ([IO.Path]::GetTempPath()) ("revitoperator_zip_verify_{0}" -f ([Guid]::NewGuid().ToString("N")))
    New-Item -ItemType Directory -Force -Path $tempDir | Out-Null

    foreach ($u in $Url) {
      $uri = [Uri]$u
      $name = [IO.Path]::GetFileName($uri.LocalPath)
      if ([string]::IsNullOrWhiteSpace($name)) {
        $name = "download.zip"
      }
      $dest = Join-Path $tempDir $name
      Invoke-WebRequest -Uri $u -OutFile $dest -UseBasicParsing
      $packages += $dest
    }
  }

  foreach ($p in $PackagePath) {
    $packages += $p
  }

  $requiredTopLevel = @(
    "operator-desktop-pilot",
    "revit-dropin-bundle",
    "README_FIRST.md",
    "release-manifest.json",
    "test_beta_install.ps1"
  )

  $results = @()
  foreach ($package in $packages) {
    $item = Get-Item -LiteralPath $package
    if ($item.Length -lt $MinimumBytes) {
      throw "Package is too small to be a full workstation ZIP: $($item.FullName) ($($item.Length) bytes; expected at least $MinimumBytes)."
    }

    $zip = [IO.Compression.ZipFile]::OpenRead($item.FullName)
    try {
      $entryNames = @($zip.Entries | ForEach-Object { $_.FullName })
      $topLevels = @($entryNames | ForEach-Object { ($_ -split "/")[0] } | Sort-Object -Unique)
      foreach ($required in $requiredTopLevel) {
        if ($topLevels -notcontains $required) {
          throw "Package missing required top-level entry '$required': $($item.FullName)"
        }
      }

      $hasDesktopScripts = $entryNames | Where-Object { $_ -like "operator-desktop-pilot/operator-desktop/scripts/*" } | Select-Object -First 1
      if (-not $hasDesktopScripts) {
        throw "Package missing operator desktop scripts folder: $($item.FullName)"
      }

      $dll = $zip.GetEntry("revit-dropin-bundle/payload/RevitOperator/RevitBridge.dll")
      if (-not $dll) {
        throw "Package missing RevitBridge.dll payload: $($item.FullName)"
      }

      $results += [pscustomobject]@{
        Package = $item.Name
        SizeBytes = $item.Length
        DesktopEntries = @($entryNames | Where-Object { $_ -like "operator-desktop-pilot/*" }).Count
        DropInEntries = @($entryNames | Where-Object { $_ -like "revit-dropin-bundle/*" }).Count
        DllBytes = $dll.Length
      }
    } finally {
      $zip.Dispose()
    }
  }

  $results | Format-Table -AutoSize
  Write-Host "Manual ZIP package verification passed."
} finally {
  if ($tempDir -and (Test-Path $tempDir)) {
    Remove-Item -Recurse -Force -LiteralPath $tempDir
  }
}
