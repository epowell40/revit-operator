param([string]$BeforeHost = '')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# All window reads/activation below are fakes. No Win32, capture or desktop input.
if($BeforeHost){
 $source=Get-Content -Raw -LiteralPath $BeforeHost
 $start=$source.IndexOf('function Assert-PointInputAllowed {')
 $end=$source.IndexOf("`n}",$start)+2
 Invoke-Expression ($source.Substring($start,$end-$start).Replace('Assert-PointInputAllowed','Assert-OperatorNativePointInput'))
}else{. "$PSScriptRoot/native_owned_window_focus.ps1"}
function Get-PointWindowMetadata {param($PointX,$PointY) return $script:point}
function Get-ForegroundWindowMetadata {return $script:front}
function Throw-ControllerInputBlocked {param($Target,$Window) throw 'controller protected'}
function Set-OperatorNativeWindowForeground {param($Handle)
 $script:activations++
 if($script:activateMode -eq 'false'){return $false}
 if($script:activateMode -ne 'unchanged'){$script:front=$script:point.PSObject.Copy()}
 if($script:activateMode -eq 'point_changed'){$script:point.processId=456}
 if($script:activateMode -eq 'handle_changed'){$script:point.handle='0x999'}
 return $true
}
function Reset-Fixture {
 $script:ExpectedRevitProcessId=123;$script:activations=0;$script:activateMode='ok'
 $script:point=[pscustomobject]@{available=$true;handle='0x123';processId=123;processName='Revit';isOperatorDesktopController=$false}
 $script:front=[pscustomobject]@{available=$true;handle='0x456';processId=456;processName='Chrome';isOperatorDesktopController=$false}
}
function Reject([scriptblock]$Mutate,[int]$ExpectedActivations){
 Reset-Fixture; & $Mutate;$failed=$false
 try{Assert-OperatorNativePointInput -PointX 2700 -PointY 473|Out-Null}catch{$failed=$true}
 if(!$failed -or $script:activations -ne $ExpectedActivations){throw "Unsafe input accepted or wrong activation count: $script:activations"}
}
Reset-Fixture
Assert-OperatorNativePointInput -PointX 2700 -PointY 473|Out-Null
if($activations -ne 1 -or $front.processId -ne 123){throw 'Exact owned Revit point must activate once and recheck before input'}
Assert-OperatorNativePointInput -PointX 2700 -PointY 473|Out-Null
if($activations -ne 1){throw 'Already foreground must not reactivate'}
Reject {$point.processId=456} 0
Reject {$point.processName='Other'} 0
Reject {$point.available=$false} 0
Reject {$point.isOperatorDesktopController=$true} 0
Reject {$point.handle='garbage'} 0
Reject {$point.handle='0x0'} 0
Reject {$script:activateMode='false'} 1
Reject {$script:activateMode='unchanged'} 1
Reject {$script:activateMode='point_changed'} 1
Reject {$script:activateMode='handle_changed'} 1
Reset-Fixture;$ExpectedRevitProcessId=0
Assert-OperatorNativePointInput -PointX 1 -PointY 2|Out-Null
if($activations -ne 0){throw 'Ordinary input must not gain automatic focus'}
Write-Output 'PASS owned foreground and ten refusal neighbors; fake windows only'
