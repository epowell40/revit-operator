function Get-OperatorRuntimeSourcesSha256([string]$Root) {
  $names = [string[]]@(Get-ChildItem -LiteralPath $Root -Force | Where-Object { $_.Name -cmatch '\.(?:[cm]?js)$' -or $_.Name -cin @('package.json', 'package-lock.json') } | ForEach-Object { $_.Name })
  if ($names.Count -eq 0 -or $names.Count -gt 512) { throw 'Invalid runtime source inventory' }
  [Array]::Sort($names, [StringComparer]::Ordinal)
  $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
  $text = [Text.StringBuilder]::new("operator-runtime-sources/v1`n")
  foreach ($name in $names) {
    if ($name -cnotmatch '^[A-Za-z0-9_.-]+$' -or !$seen.Add($name)) { throw 'Invalid runtime source name' }
    $file = Get-Item -LiteralPath (Join-Path $Root $name) -Force -ErrorAction Stop
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -gt 33554432) { throw "Invalid runtime source file: $name" }
    $fileSha = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($file.FullName)
    try { $digest = (($fileSha.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '') }
    finally { $stream.Dispose(); $fileSha.Dispose() }
    [void]$text.Append($name).Append([char]0).Append($digest).Append("`n")
  }
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return (($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text.ToString())) | ForEach-Object { $_.ToString('x2') }) -join '') }
  finally { $sha.Dispose() }
}
