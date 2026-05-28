param(
  [Parameter(Mandatory = $true)]
  [string]$iterDir,

  [Parameter(Mandatory = $true)]
  [string]$aiViewName,

  [Parameter(Mandatory = $true)]
  [string]$humanViewName,

  [int]$cols,
  [int]$rows,
  [int]$padding
)

$ErrorActionPreference = "Stop"

if (-not $PSBoundParameters.ContainsKey('cols')) { $cols = 3 }
if (-not $PSBoundParameters.ContainsKey('rows')) { $rows = 3 }
if (-not $PSBoundParameters.ContainsKey('padding')) { $padding = 0 }

function Find-Image([string]$dir, [string]$viewName) {
  $pattern = "*$viewName*.jpg"
  $img = Get-ChildItem -Path $dir -Filter $pattern | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $img) {
    throw "Could not find image in '$dir' matching '$pattern'"
  }
  return $img.FullName
}

function Ensure-Assembly {
  try {
    Add-Type -AssemblyName System.Drawing | Out-Null
  } catch {
    throw "Failed to load System.Drawing. $_"
  }
}

function Crop-Tiles([string]$src, [string]$prefix, [string]$outDir, [int]$cols, [int]$rows, [int]$padding) {
  $img = [System.Drawing.Image]::FromFile($src)
  try {
    $W = $img.Width
    $H = $img.Height

    $tileW = [int][Math]::Floor(($W - ($padding * ($cols - 1))) / $cols)
    $tileH = [int][Math]::Floor(($H - ($padding * ($rows - 1))) / $rows)

    for ($r = 0; $r -lt $rows; $r++) {
      for ($c = 0; $c -lt $cols; $c++) {
        $x = $c * ($tileW + $padding)
        $y = $r * ($tileH + $padding)

        $rect = New-Object System.Drawing.Rectangle($x, $y, $tileW, $tileH)
        $bmp = New-Object System.Drawing.Bitmap $tileW, $tileH
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        try {
          $g.DrawImage($img, 0, 0, $rect, [System.Drawing.GraphicsUnit]::Pixel)
          $name = "{0}_tile_r{1}_c{2}.png" -f $prefix, $r, $c
          $dst = Join-Path $outDir $name
          $bmp.Save($dst, [System.Drawing.Imaging.ImageFormat]::Png)
        } finally {
          $g.Dispose()
          $bmp.Dispose()
        }
      }
    }
  } finally {
    $img.Dispose()
  }
}

if (-not (Test-Path $iterDir)) { throw "iterDir not found: $iterDir" }
Ensure-Assembly

$aiPath = Find-Image $iterDir $aiViewName
$humanPath = Find-Image $iterDir $humanViewName

Crop-Tiles -src $aiPath -prefix "ai" -outDir $iterDir -cols $cols -rows $rows -padding $padding
Crop-Tiles -src $humanPath -prefix "human" -outDir $iterDir -cols $cols -rows $rows -padding $padding

Write-Host "Tiled images written to $iterDir"
