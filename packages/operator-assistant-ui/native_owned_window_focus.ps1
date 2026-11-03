# Shared native-input host guard. Callers retain live assignment/Pause/operation
# authorization. These callbacks inspect OS windows; this function grants none.
function Invoke-OperatorNativeCaptionActivation {
 param([int]$PointX,[int]$PointY,[string]$MouseButton)
 # This handles only an explicit single left click on the native title bar.
 # A normal Windows mouse activation is distinct from SetForegroundWindow.
 # Never synthesize an extra click, task-switch, or deliver model-area input
 # when the expected Revit window is not already foreground.
 if($ExpectedRevitProcessId -le 0 -or $MouseButton -ne 'left'){return $false}
 $point=Get-PointWindowMetadata -PointX $PointX -PointY $PointY
 if($point.isOperatorDesktopController){Throw-ControllerInputBlocked -Target 'point' -Window $point}
 if(!$point.available -or $point.processId -ne $ExpectedRevitProcessId -or $point.processName -ne 'Revit'){
  throw 'NATIVE_INTERACTIVE_REQUIRES_EXACT_REVIT_WINDOW'
 }
 $front=Get-ForegroundWindowMetadata
 if($front.available -and $front.processId -eq $ExpectedRevitProcessId -and $front.processName -eq 'Revit'){return $false}
 $handleText=[string]$point.handle
 if($handleText -notmatch '^0x[0-9a-fA-F]{1,16}$'){throw 'NATIVE_INTERACTIVE_WINDOW_HANDLE_UNVERIFIED'}
 $handleValue=[Convert]::ToInt64($handleText.Substring(2),16)
 if($handleValue -le 0){throw 'NATIVE_INTERACTIVE_WINDOW_HANDLE_UNVERIFIED'}
 $handle=[IntPtr]$handleValue
 if((Get-OperatorNativeWindowHitTest -Handle $handle -PointX $PointX -PointY $PointY) -ne 2){return $false}
 if(!(Set-OperatorNativeCursorPosition -PointX $PointX -PointY $PointY)){throw 'NATIVE_INTERACTIVE_CURSOR_POSITION_REFUSED'}
 # Recheck after cursor motion and immediately before the one requested click.
 $point=Get-PointWindowMetadata -PointX $PointX -PointY $PointY
 if($point.isOperatorDesktopController){Throw-ControllerInputBlocked -Target 'point' -Window $point}
 if(!$point.available -or $point.handle -ne $handleText -or $point.processId -ne $ExpectedRevitProcessId -or
    $point.processName -ne 'Revit' -or (Get-OperatorNativeWindowHitTest -Handle $handle -PointX $PointX -PointY $PointY) -ne 2){
  throw 'NATIVE_INTERACTIVE_CAPTION_TARGET_CHANGED'
 }
 Send-OperatorNativeLeftClick
 $point=Get-PointWindowMetadata -PointX $PointX -PointY $PointY
 $front=Get-ForegroundWindowMetadata
 if(!$point.available -or !$front.available -or $point.isOperatorDesktopController -or $front.isOperatorDesktopController -or
    $point.handle -ne $handleText -or $front.handle -ne $handleText -or
    $point.processId -ne $ExpectedRevitProcessId -or $front.processId -ne $ExpectedRevitProcessId -or
    $point.processName -ne 'Revit' -or $front.processName -ne 'Revit'){
  throw 'NATIVE_INTERACTIVE_CAPTION_ACTIVATION_NOT_CONFIRMED'
 }
 return $true
}

function Assert-OperatorNativePointInput {
 param([int]$PointX,[int]$PointY)
 $metadata=Get-PointWindowMetadata -PointX $PointX -PointY $PointY
 if($metadata.isOperatorDesktopController){Throw-ControllerInputBlocked -Target 'point' -Window $metadata}
 if($ExpectedRevitProcessId -gt 0){
  $foreground=Get-ForegroundWindowMetadata
  if(!$metadata.available -or $metadata.processId -ne $ExpectedRevitProcessId -or $metadata.processName -ne 'Revit'){
   throw 'NATIVE_INTERACTIVE_REQUIRES_EXACT_REVIT_WINDOW'
  }
  if(!$foreground.available -or $foreground.processId -ne $ExpectedRevitProcessId -or $foreground.processName -ne 'Revit'){
   # Activate only the already observed, exposed, exact-owned target window.
   # No task switching, fabricated click, repeated attempt, or foreground-lock bypass.
   $handleText=[string]$metadata.handle
   if($handleText -notmatch '^0x[0-9a-fA-F]{1,16}$'){throw 'NATIVE_INTERACTIVE_WINDOW_HANDLE_UNVERIFIED'}
   $handleValue=[Convert]::ToInt64($handleText.Substring(2),16)
   if($handleValue -le 0){throw 'NATIVE_INTERACTIVE_WINDOW_HANDLE_UNVERIFIED'}
   if(!(Set-OperatorNativeWindowForeground -Handle ([IntPtr]$handleValue))){throw 'NATIVE_INTERACTIVE_FOREGROUND_ACTIVATION_REFUSED'}
   $metadata=Get-PointWindowMetadata -PointX $PointX -PointY $PointY
   $foreground=Get-ForegroundWindowMetadata
   if($metadata.isOperatorDesktopController){Throw-ControllerInputBlocked -Target 'point' -Window $metadata}
   if(!$metadata.available -or !$foreground.available -or $metadata.handle -ne $handleText -or
      $foreground.handle -ne $handleText -or $metadata.processId -ne $ExpectedRevitProcessId -or
      $foreground.processId -ne $ExpectedRevitProcessId -or $metadata.processName -ne 'Revit' -or $foreground.processName -ne 'Revit'){
    throw 'NATIVE_INTERACTIVE_REQUIRES_EXACT_REVIT_WINDOW'
   }
  }
 }
 return $metadata
}
