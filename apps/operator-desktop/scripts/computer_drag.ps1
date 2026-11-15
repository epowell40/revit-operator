# Shared geometry and trajectory execution for the existing guarded input host.
# This file defines functions only; dot-sourcing it never injects input.
function Resolve-OperatorDragPath {
  param([string]$PathJsonBase64, [System.Collections.IDictionary]$LegacyCoordinates)
  if ($PathJsonBase64) {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($PathJsonBase64))
    if (-not $json.TrimStart().StartsWith('[')) { throw 'Invalid drag path array.' }
    $rawPoints = ConvertFrom-Json -InputObject $json
    if ($null -eq $rawPoints) { throw 'Invalid drag path array.' }
  } else {
    foreach ($name in @('X','Y','EndX','EndY')) {
      if ($LegacyCoordinates.Keys -notcontains $name) { throw 'Drag endpoints are required.' }
    }
    $rawPoints = @(@{x=$LegacyCoordinates['X'];y=$LegacyCoordinates['Y']},@{x=$LegacyCoordinates['EndX'];y=$LegacyCoordinates['EndY']})
  }
  if ($rawPoints.Count -lt 2 -or $rawPoints.Count -gt 256) { throw 'Drag path requires 2 to 256 points.' }
  $points = @()
  foreach ($p in $rawPoints) {
    if ($null -eq $p -or $p -is [Array]) { throw 'Invalid drag point.' }
    $values = @{}
    foreach ($axis in @('x','y')) {
      $value = $null
      if ($p -is [System.Collections.IDictionary]) { $value = $p[$axis] }
      elseif ($p.PSObject.Properties[$axis]) { $value = $p.$axis }
      if ($value -isnot [ValueType] -or $value -is [bool] -or $value -is [char]) { throw 'Invalid drag coordinate.' }
      $number = [double]$value
      if ([double]::IsNaN($number) -or [double]::IsInfinity($number) -or $number -ne [Math]::Truncate($number) -or $number -lt [int]::MinValue -or $number -gt [int]::MaxValue) {
        throw 'Invalid drag integer coordinate.'
      }
      $values[$axis] = [int]$number
    }
    $points += [PSCustomObject]$values
  }
  return $points
}

function Invoke-OperatorDrag {
  param([object[]]$Points, [string]$Button)
  if ($Button -notin @('left','right','middle')) { throw 'Invalid drag mouse button.' }
  # Validate the entire path and controller targets before the first input.
  foreach ($p in $Points) { Assert-PointInputAllowed -PointX $p.x -PointY $p.y | Out-Null }
  $flags = Get-MouseButtonFlagPair -MouseButton $Button
  $start = $Points[0]
  $mouseDown = $false
  $dragFailure = $null
  if (-not [NativeInput]::SetCursorPos($start.x, $start.y)) { throw 'Drag cursor positioning failed.' }
  Start-Sleep -Milliseconds 50
  Assert-PointInputAllowed -PointX $start.x -PointY $start.y | Out-Null
  try {
    # A failing emission can still have pressed the button; always release it.
    $mouseDown = $true
    [NativeInput]::mouse_event($flags.Down, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 50
    for ($i = 1; $i -lt $Points.Count; $i++) {
      $p = $Points[$i]
      Assert-PointInputAllowed -PointX $p.x -PointY $p.y | Out-Null
      if (-not [NativeInput]::SetCursorPos($p.x, $p.y)) { throw 'Drag cursor positioning failed.' }
      Start-Sleep -Milliseconds 20
      Assert-PointInputAllowed -PointX $p.x -PointY $p.y | Out-Null
    }
    Start-Sleep -Milliseconds 100
    $end = $Points[-1]
    Assert-PointInputAllowed -PointX $end.x -PointY $end.y | Out-Null
  } catch {
    $dragFailure = $_
    try { [NativeInput]::SetCursorPos($start.x, $start.y) | Out-Null } catch { }
  } finally {
    if ($mouseDown) {
      try { [NativeInput]::mouse_event($flags.Up, 0, 0, 0, [UIntPtr]::Zero) }
      catch { if ($null -eq $dragFailure) { $dragFailure = $_ } }
    }
  }
  if ($null -ne $dragFailure) { throw $dragFailure }
}
