# Shared eased cursor motion. Defining these functions never sends input.
function Assert-OperatorInputRunning {
  if (!$env:OPERATOR_INPUT_STOP_EVENT) { return }
  if ($env:OPERATOR_INPUT_STOP_EVENT -notmatch '^Local\\OperatorInputStop_[a-f0-9]{32}$') { throw 'OPERATOR_INPUT_STOP_UNAVAILABLE' }
  $event = $null
  try {
    $event = [Threading.EventWaitHandle]::OpenExisting($env:OPERATOR_INPUT_STOP_EVENT)
    if ($event.WaitOne(0)) { throw 'OPERATOR_INPUT_STOPPED' }
  } catch { throw 'OPERATOR_INPUT_STOPPED_OR_UNAVAILABLE' }
  finally { if ($event) { $event.Dispose() } }
}

function Get-OperatorPointerTrajectory {
  param([int]$StartX,[int]$StartY,[int]$TargetX,[int]$TargetY,[int]$MinDuration=120,[int]$MaxDuration=650)
  $dx=[double]$TargetX-$StartX; $dy=[double]$TargetY-$StartY
  $distance=[Math]::Sqrt($dx*$dx+$dy*$dy)
  if ($distance -eq 0) { return @([pscustomobject]@{x=$TargetX;y=$TargetY;delay=0}) }
  $duration=[Math]::Min($MaxDuration,[Math]::Max($MinDuration,$distance*0.55))
  $steps=[int][Math]::Ceiling($duration/16)
  for($i=1;$i -le $steps;$i++) {
    $t=$i/[double]$steps; $e=$t*$t*(3-2*$t)
    [pscustomobject]@{x=[int][Math]::Round($StartX+$dx*$e);y=[int][Math]::Round($StartY+$dy*$e);delay=16}
  }
}

function Move-OperatorCursor {
  param([int]$PointX,[int]$PointY,[scriptblock]$ValidateStep,[int]$MinDuration=120,[int]$MaxDuration=650)
  Assert-OperatorInputRunning
  $start=New-Object NativeInput+POINT
  if (![NativeInput]::GetCursorPos([ref]$start)) { throw 'Cursor position unavailable.' }
  foreach($p in @(Get-OperatorPointerTrajectory -StartX $start.X -StartY $start.Y -TargetX $PointX -TargetY $PointY -MinDuration $MinDuration -MaxDuration $MaxDuration)) {
    Assert-OperatorInputRunning
    if($ValidateStep) { & $ValidateStep $p.x $p.y | Out-Null }
    if (![NativeInput]::SetCursorPos($p.x,$p.y)) { throw 'Cursor movement failed.' }
    if($p.delay) { Start-Sleep -Milliseconds $p.delay }
  }
  Assert-OperatorInputRunning
}
