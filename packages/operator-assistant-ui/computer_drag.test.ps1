param([string]$DesktopScript = '')
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Deterministic fake input type: no Win32 calls or real desktop interaction.
Add-Type @'
using System;
using System.Collections.Generic;
public static class NativeInput {
 public static List<string> Calls = new List<string>();
 public static int FailX = int.MinValue;
 public static uint FailButton = 0;
 public static bool SetCursorPos(int x,int y) { Calls.Add("move:"+x+","+y); return x!=FailX; }
 public static void mouse_event(uint f,uint x,uint y,uint d,UIntPtr extra) { Calls.Add("button:"+f); if(f==FailButton) throw new Exception("button emission failed"); }
}
'@
. "$PSScriptRoot/computer_drag.ps1"
function Start-Sleep { param([int]$Milliseconds) }
function Get-MouseButtonFlagPair { param([string]$MouseButton) return @{Down=2;Up=4} }
$script:blockedX = [int]::MinValue
$script:lateBlockX = [int]::MinValue
$script:guards = @()
function Assert-PointInputAllowed {
 param([int]$PointX,[int]$PointY)
 $script:guards += "$PointX,$PointY"
 if ($PointX -eq $script:blockedX -or ($PointX -eq $script:lateBlockX -and [NativeInput]::Calls.Contains('button:2'))) { throw 'controller blocked' }
}
function Reset-FakeInput {
 [NativeInput]::Calls.Clear(); [NativeInput]::FailX = [int]::MinValue; [NativeInput]::FailButton=0
 $script:blockedX = [int]::MinValue; $script:lateBlockX = [int]::MinValue; $script:guards = @()
}
function Encode-Path([string]$Json) { return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Json)) }
$script:passed = 0
function Check([bool]$Condition,[string]$Message) { if (-not $Condition) { throw $Message }; $script:passed++ }
function Expect-Failure([scriptblock]$Call,[string]$Reason) {
 $caught = $false
 try { & $Call | Out-Null } catch { if ($_.Exception.Message -notlike "*$Reason*") { throw }; $caught=$true }
 Check $caught "Expected failure: $Reason"
}
$paths = @(
 '[{"x":872,"y":766},{"x":883,"y":748},{"x":901,"y":718},{"x":917,"y":692}]',
 '[{"x":872,"y":766},{"x":872,"y":760},{"x":878,"y":749},{"x":890,"y":729},{"x":903,"y":709},{"x":917,"y":692}]',
 '[{"x":839,"y":782},{"x":840,"y":780},{"x":845,"y":770},{"x":860,"y":750},{"x":880,"y":710},{"x":907,"y":671}]'
)
foreach ($json in $paths) {
 Reset-FakeInput
 $points = @(Resolve-OperatorDragPath -PathJsonBase64 (Encode-Path $json) -LegacyCoordinates @{})
 Invoke-OperatorDrag -Points $points -Button left
 $expected = @("move:$($points[0].x),$($points[0].y)",'button:2') + @($points | Select-Object -Skip 1 | ForEach-Object { "move:$($_.x),$($_.y)" }) + @('button:4')
 Check (([NativeInput]::Calls -join '|') -ceq ($expected -join '|')) 'Full retained trajectory must execute in order between down and up.'
 Check ($script:guards.Count -eq (3 * $points.Count)) 'All vertices must be guarded before input, at every move and before release.'
}
Reset-FakeInput
$points = @(Resolve-OperatorDragPath -LegacyCoordinates @{X=0;Y=0;EndX=-200;EndY=50})
Invoke-OperatorDrag -Points $points -Button middle
Check ([NativeInput]::Calls.Contains('move:0,0') -and [NativeInput]::Calls.Contains('move:-200,50')) 'Legacy valid zero/negative coordinates lost.'
foreach ($json in @('[]','[{}]','[{"x":1,"y":2},null]','[{"x":1,"y":2},{"x":"3","y":4}]','[{"x":1,"y":2},{"x":true,"y":4}]','[{"x":1,"y":2},{"x":2147483648,"y":4}]','[{"x":1,"y":2},{"x":3.5,"y":4}]','{"x":1,"y":2}')) {
 Reset-FakeInput
 Expect-Failure { Resolve-OperatorDragPath -PathJsonBase64 (Encode-Path $json) -LegacyCoordinates @{} } 'drag'
 Check ([NativeInput]::Calls.Count -eq 0) 'Malformed geometry emitted input.'
}
Expect-Failure { Resolve-OperatorDragPath -LegacyCoordinates @{X=0;Y=0} } 'endpoints'
$points = @(Resolve-OperatorDragPath -PathJsonBase64 (Encode-Path $paths[0]) -LegacyCoordinates @{})
Reset-FakeInput; $script:blockedX=883
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'controller blocked'
Check ([NativeInput]::Calls.Count -eq 0) 'Preflight guard must precede all input.'
Reset-FakeInput; $script:lateBlockX=883
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'controller blocked'
Check (([NativeInput]::Calls -join '|') -ceq 'move:872,766|button:2|move:872,766|button:4') 'Late guard failure must restore and release exactly once.'
Reset-FakeInput; [NativeInput]::FailX=883
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'positioning failed'
Check ([NativeInput]::Calls[-1] -eq 'button:4') 'Failed move must release the mouse.'
Reset-FakeInput; [NativeInput]::FailX=872
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'positioning failed'
Check (-not [NativeInput]::Calls.Contains('button:2')) 'Initial positioning failure must not press mouse.'
Reset-FakeInput; [NativeInput]::FailButton=2
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'button emission failed'
Check ([NativeInput]::Calls[-1] -eq 'button:4') 'Unknown button-down outcome must still release.'
Reset-FakeInput; [NativeInput]::FailButton=4
Expect-Failure { Invoke-OperatorDrag -Points $points -Button left } 'button emission failed'
Check ([NativeInput]::Calls[-1] -eq 'button:4') 'Button-up failure must propagate without retrying input.'
if ($DesktopScript) {
 # Execute the actual production switch branch, with the fake NativeInput above.
 $source = Get-Content -LiteralPath $DesktopScript -Raw
 $match = [regex]::Match($source, '(?s)  "drag" \{(.*?)\r?\n    break\r?\n  \}')
 if (-not $match.Success) { throw 'Production drag branch missing.' }
 $branch = [scriptblock]::Create('param([string]$DragPathJsonBase64,[int]$X,[int]$Y,[int]$EndX,[int]$EndY,[string]$Button)' + $match.Groups[1].Value)
 Reset-FakeInput
 & $branch -DragPathJsonBase64 (Encode-Path $paths[0]) -Button left
 Check ([NativeInput]::Calls.Contains('move:883,748')) 'Production branch dropped an intermediate point.'
 Reset-FakeInput
 & $branch -X 0 -Y 0 -EndX -10 -EndY 20 -Button left
 Check ([NativeInput]::Calls.Contains('move:-10,20')) 'Production branch lost scalar endpoints.'
}
Write-Output "PASS $script:passed drag geometry/guard/trajectory/cleanup assertions; fake input only"
