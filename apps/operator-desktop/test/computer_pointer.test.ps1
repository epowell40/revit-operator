$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# No user32 imports. The sink records motion without controlling the desktop.
Add-Type @'
using System;
using System.Collections.Generic;
public static class NativeInput {
 public struct POINT { public int X,Y; }
 public static List<POINT> Moves = new List<POINT>();
 public static bool GetCursorPos(out POINT p) { p=new POINT {X=-200,Y=40};return true; }
 public static bool SetCursorPos(int x,int y) { Moves.Add(new POINT {X=x,Y=y});return true; }
}
'@
. "$PSScriptRoot/../scripts/computer_pointer.ps1"
Add-Type -Path "$PSScriptRoot/../indicator/EscapeGesture.cs"
function Check($condition,$message) {if(!$condition){throw $message}}
$g=New-Object EscapeGesture
Check (!$g.Observe($true,$false,100)) 'First Escape stopped work'
Check (!$g.Observe($true,$false,110)) 'Held Escape stopped work'
Check (!$g.Observe($false,$false,120)) 'Release stopped work'
Check (!$g.Observe($true,$true,130)) 'Injected Escape stopped work'
Check ($g.Observe($true,$false,500)) 'Second physical Escape did not stop'
Check (!$g.Observe($true,$false,510)) 'Stop was not latched'
$g=New-Object EscapeGesture
$null=$g.Observe($true,$false,100);$null=$g.Observe($false,$false,110)
Check (!$g.Observe($true,$false,800)) 'Slow independent Escape stopped work'
$name='Local\OperatorInputStop_'+[Guid]::NewGuid().ToString('N')
$old=$env:OPERATOR_INPUT_STOP_EVENT
$event=New-Object Threading.EventWaitHandle($false,[Threading.EventResetMode]::ManualReset,$name)
try {
 $env:OPERATOR_INPUT_STOP_EVENT=$name
 $points=@(Get-OperatorPointerTrajectory -StartX -200 -StartY 40 -TargetX 1000 -TargetY 200)
 Check ($points.Count -gt 20 -and $points.Count -le 41) 'Unbounded or jumping trajectory'
 Check ($points[-1].x -eq 1000 -and $points[-1].y -eq 200) 'Lost endpoint'
 for($i=1;$i -lt $points.Count;$i++) {Check ($points[$i].x -ge $points[$i-1].x) 'Motion reversed'}
 $script:stopAt=0
 function Start-Sleep {param([int]$Milliseconds) if($script:stopAt -and [NativeInput]::Moves.Count -ge $script:stopAt){$event.Set()|Out-Null}}
 Move-OperatorCursor -PointX 1000 -PointY 200
 Check ([NativeInput]::Moves.Count -eq $points.Count) 'Production movement skipped interpolation'
 [NativeInput]::Moves.Clear();$script:stopAt=3;$caught=$false
 try {Move-OperatorCursor -PointX 1000 -PointY 200} catch { $caught=$_.Exception.Message -like '*OPERATOR_INPUT_STOPPED*' }
 Check ($caught -and [NativeInput]::Moves.Count -eq 3) 'Input continued after stop'
 $event.Reset()|Out-Null;[NativeInput]::Moves.Clear();$script:stopAt=0;$caught=$false
 try {Move-OperatorCursor -PointX 1000 -PointY 200 -ValidateStep {param($x,$y) if($x -gt -190){throw 'target denied'}}} catch {$caught=$_.Exception.Message -eq 'target denied'}
 Check $caught 'Intermediate point guard was ignored'
 $event.Dispose();$event=$null;$caught=$false
 try {Assert-OperatorInputRunning} catch {$caught=$_.Exception.Message -like '*STOPPED_OR_UNAVAILABLE*'}
 Check $caught 'Missing owner event allowed input'
 Write-Output 'PASS Escape edges, trajectory, intermediate guards and immediate input stop; fake input only'
} finally {if($event){$event.Dispose()};$env:OPERATOR_INPUT_STOP_EVENT=$old}
