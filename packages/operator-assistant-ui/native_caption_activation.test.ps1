param([string]$Source = "$PSScriptRoot/native_owned_window_focus.ps1")
$ErrorActionPreference='Stop';Set-StrictMode -Version Latest
. $Source
# Fake Win32 boundaries only. The exact188 requested point was the exposed
# Revit title bar; SetForegroundWindow refused before the click was delivered.
function Get-PointWindowMetadata {param($PointX,$PointY) return $script:point}
function Get-ForegroundWindowMetadata {return $script:front}
function Throw-ControllerInputBlocked {param($Target,$Window) throw 'controller protected'}
function Set-OperatorNativeWindowForeground {param($Handle) return $false}
function Get-OperatorNativeWindowHitTest {param($Handle,$PointX,$PointY) return $script:hit}
function Set-OperatorNativeCursorPosition {param($PointX,$PointY)
 $script:moves++;if($script:mode -eq 'point_race'){$script:point.processId=999}
 if($script:mode -eq 'caption_race'){$script:hit=1}
 return $script:mode -ne 'cursor_failed'
}
function Send-OperatorNativeLeftClick {
 $script:clicks++;if($script:mode -ne 'no_activation'){$script:front=$script:point.PSObject.Copy()}
 if($script:mode -eq 'foreground_race'){$script:front.processId=999}
 if($script:mode -eq 'handle_race'){$script:front.handle='0x999'}
}
function Reset-Fixture {
 $script:ExpectedRevitProcessId=696;$script:clicks=0;$script:moves=0;$script:hit=2;$script:mode='ok'
 $script:point=[pscustomobject]@{available=$true;handle='0x123';processId=696;processName='Revit';isOperatorDesktopController=$false}
 $script:front=[pscustomobject]@{available=$true;handle='0x456';processId=500;processName='Chrome';isOperatorDesktopController=$true}
}
function Run {
 if(!(Get-Command Invoke-OperatorNativeCaptionActivation -ErrorAction SilentlyContinue)){
  # Replay the old click boundary, including the actual188 OS refusal.
  Assert-OperatorNativePointInput -PointX 2700 -PointY 16|Out-Null
  throw 'Old boundary unexpectedly admitted caption without the dedicated click contract'
 }
 return Invoke-OperatorNativeCaptionActivation -PointX 2700 -PointY 16 -MouseButton left
}
Reset-Fixture
if(!(Run) -or $clicks -ne 1 -or $front.processId -ne 696){throw 'Exact188 titlebar click must activate through one normal click'}
if((Run) -or $clicks -ne 1){throw 'Already-active window must use ordinary guarded click path'}
foreach($badHit in @(1,20,3,8,9,0,-1,$null)){
 Reset-Fixture;$hit=$badHit;if((Run) -or $clicks -ne 0 -or $moves -ne 0){throw 'Only HTCAPTION may activate'}
}
Reset-Fixture;if((Invoke-OperatorNativeCaptionActivation -PointX 2700 -PointY 16 -MouseButton right) -or $clicks){throw 'No right-click activation'}
Reset-Fixture;$ExpectedRevitProcessId=0;if((Run) -or $clicks){throw 'No unowned activation'}
foreach($bad in @('foreign','wrong_name','unavailable','controller','bad_handle','point_race','caption_race','cursor_failed','no_activation','foreground_race','handle_race')){
 Reset-Fixture
 switch($bad){
  foreign {$point.processId=999} wrong_name {$point.processName='Other'} unavailable {$point.available=$false}
  controller {$point.isOperatorDesktopController=$true} bad_handle {$point.handle='bad'}
  default {$mode=$bad}
 }
 $failed=$false;try{Run|Out-Null}catch{$failed=$true}
 if(!$failed){throw "Unsafe caption accepted: $bad"}
 $expected=if($bad -in @('no_activation','foreground_race','handle_race')){1}else{0}
 if($clicks -ne $expected){throw "Unexpected input after refusal: $bad"}
}
Write-Output 'PASS exact188 caption and22 neighboring controls; fake windows only'
