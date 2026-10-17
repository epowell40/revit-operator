$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Execute the real host planner against deterministic Win32 observations. No UI
# input, screen capture or Revit process is created by this regression test.
Add-Type @'
using System;
public static class OperatorReviewWindows {
 public struct RECT { public int Left, Top, Right, Bottom; }
 public struct POINT { public int X, Y; }
 public static int Foreground=123, Occluder=0, Foreign=0, MainWidth=1600;
 public static bool Enabled=true, Visible=true, Minimized=false;
 public static IntPtr GetForegroundWindow(){return (IntPtr)Foreground;}
 public static uint GetWindowThreadProcessId(IntPtr w,out uint p){p=w.ToInt32()==Foreign?999u:123u;return 1;}
 public static bool GetWindowRect(IntPtr w,out RECT r){r=w.ToInt32()==123?new RECT{Left=0,Top=0,Right=MainWidth,Bottom=1000}:new RECT{Left=200,Top=200,Right=800,Bottom=700};return true;}
 public static bool IsWindowVisible(IntPtr w){return Visible;}
 public static bool IsWindowEnabled(IntPtr w){return Enabled;}
 public static bool IsIconic(IntPtr w){return Minimized;}
 public static IntPtr GetWindow(IntPtr w,uint c){return w.ToInt32()==124?(IntPtr)123:IntPtr.Zero;}
 public static IntPtr GetAncestor(IntPtr w,uint f){return w;}
 public static IntPtr WindowFromPoint(POINT p){return (IntPtr)(Occluder==0?Foreground:Occluder);}
}
'@
. "$PSScriptRoot/visual_review_capture.ps1"
function Get-ReviewDesktopBounds { return @{x=0;y=0;width=3520;height=1080} }
function New-Scene {
 return @{process_id=123;view_id=41;identity_captured_at_utc=[DateTimeOffset]::UtcNow.ToString('o');visual_capture_context=@{main_window_handle='0x7B';main_window_bounds=@{x=0;y=0;width=1600;height=1000};view_rectangle=@{x=250;y=200;width=700;height=600}}}
}
$passed=0
function Expect-Failure([scriptblock]$Call,[string]$Reason) {
 $caught=$false
 try { & $Call | Out-Null } catch { if ($_.Exception.Message -notlike "*$Reason*") { throw }; $caught=$true }
 if (-not $caught) { throw "Expected failure: $Reason" }
 $script:passed++
}
$scene=New-Scene
$plan=Get-ReviewCapturePlan $scene
if ($plan.kind -ne 'revit_view' -or $plan.rectangle.width -ne 700 -or $plan.rectangle.x -ne 250) { throw 'Must select native drawing area, not desktop or main window' };$passed++
[OperatorReviewWindows]::Foreground=124;[OperatorReviewWindows]::Enabled=$false
$plan=Get-ReviewCapturePlan $scene
if ($plan.kind -ne 'revit_dialog' -or $plan.rectangle.width -ne 600 -or $plan.foreground_window_handle -ne '0x7C') { throw 'Must select owned modal only' };$passed++
# Modal capture remains possible after Idling stops, using the immutable scene.
$scene.identity_captured_at_utc=[DateTimeOffset]::UtcNow.AddMinutes(-2).ToString('o')
if ((Get-ReviewCapturePlan $scene).kind -ne 'revit_dialog') { throw 'Modal should not require a queued callback' };$passed++
[OperatorReviewWindows]::Enabled=$true
Expect-Failure { Get-ReviewCapturePlan $scene } 'not_owned_modal'
[OperatorReviewWindows]::Foreground=125;[OperatorReviewWindows]::Enabled=$false
Expect-Failure { Get-ReviewCapturePlan $scene } 'not_owned_modal'
[OperatorReviewWindows]::Foreground=123;[OperatorReviewWindows]::Enabled=$true
Expect-Failure { Get-ReviewCapturePlan $scene } 'view_rectangle_stale'
$scene=New-Scene;[OperatorReviewWindows]::Foreign=123
Expect-Failure { Get-ReviewCapturePlan $scene } 'window_owner_changed'
[OperatorReviewWindows]::Foreign=0;[OperatorReviewWindows]::Occluder=999
Expect-Failure { Get-ReviewCapturePlan $scene } 'frame_occluded'
[OperatorReviewWindows]::Occluder=0;[OperatorReviewWindows]::MainWidth=1500
Expect-Failure { Get-ReviewCapturePlan $scene } 'main_window_moved'
[OperatorReviewWindows]::MainWidth=1600;[OperatorReviewWindows]::Minimized=$true
Expect-Failure { Get-ReviewCapturePlan $scene } 'revit_not_visible'
[OperatorReviewWindows]::Minimized=$false;$scene.visual_capture_context.view_rectangle.x=-10
Expect-Failure { Get-ReviewCapturePlan $scene } 'view_rectangle_unavailable'
$scene=New-Scene;$scene.visual_capture_context.view_rectangle.width=0
Expect-Failure { Get-ReviewCapturePlan $scene } 'view_rectangle_unavailable'
Write-Output "PASS $passed exact host capture planner scenarios; no live/UI/provider calls"
