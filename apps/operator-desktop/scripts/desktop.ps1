param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("screenshot", "review_screenshot", "review_native_read_admission", "move", "click", "double_click", "scroll", "type", "keypress", "verified_revit_close", "cancel_native_placement", "drag", "wait", "guard_check")]
  [string]$Action,

  [int]$X = 0,
  [int]$Y = 0,
  [int]$EndX = 0,
  [int]$EndY = 0,
  [string]$Button = "left",
  [int]$ScrollY = 0,
  [int]$DelayMs = 500,
  [string]$TextBase64 = "",
  [string]$KeysJsonBase64 = "",
  [string]$DragPathJsonBase64 = "",
  [int]$ExpectedRevitProcessId = 0,
  [string]$ReviewSceneBase64 = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. "$PSScriptRoot\operator_desktop_guard.ps1"
. "$PSScriptRoot\computer_drag.ps1"
. "$PSScriptRoot\native_owned_window_focus.ps1"

# mouse_event carries a signed wheel delta in a DWORD. Numeric conversion of
# a negative Int32 throws in Windows PowerShell; preserve its actual bit pattern.
function ConvertTo-OperatorMouseWheelData {
  param([int]$Delta)
  return [BitConverter]::ToUInt32([BitConverter]::GetBytes($Delta), 0)
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$signature = @"
using System;
using System.Runtime.InteropServices;

public static class NativeInput {
  [StructLayout(LayoutKind.Sequential)]
  public struct POINT {
    public int X;
    public int Y;
  }

  [DllImport("user32.dll")]
  public static extern bool SetCursorPos(int X, int Y);

  [DllImport("user32.dll")]
  public static extern bool GetCursorPos(out POINT lpPoint);

  [DllImport("user32.dll")]
  public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);

  [DllImport("user32.dll")]
  public static extern IntPtr WindowFromPoint(POINT Point);

  [DllImport("user32.dll")]
  public static extern IntPtr GetAncestor(IntPtr hWnd, uint gaFlags);

  [DllImport("user32.dll")]
  public static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr hWnd);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeoutMs, out UIntPtr result);

  [DllImport("user32.dll")]
  public static extern int GetWindowTextLength(IntPtr hWnd);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);
}
"@

Add-Type -TypeDefinition $signature | Out-Null

$mouseFlags = @{
  LeftDown = 0x0002
  LeftUp = 0x0004
  RightDown = 0x0008
  RightUp = 0x0010
  MiddleDown = 0x0020
  MiddleUp = 0x0040
  Wheel = 0x0800
}

function Get-MouseButtonFlagPair {
  param([string]$MouseButton)

  switch ($MouseButton.ToLowerInvariant()) {
    "right" {
      return @{
        Down = $mouseFlags.RightDown
        Up = $mouseFlags.RightUp
      }
    }
    "middle" {
      return @{
        Down = $mouseFlags.MiddleDown
        Up = $mouseFlags.MiddleUp
      }
    }
    default {
      return @{
        Down = $mouseFlags.LeftDown
        Up = $mouseFlags.LeftUp
      }
    }
  }
}

function Invoke-MouseClick {
  param(
    [string]$MouseButton,
    [int]$PointX,
    [int]$PointY
  )

  $flags = Get-MouseButtonFlagPair -MouseButton $MouseButton
  Assert-PointInputAllowed -PointX $PointX -PointY $PointY
  [NativeInput]::mouse_event($flags.Down, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 50
  [NativeInput]::mouse_event($flags.Up, 0, 0, 0, [UIntPtr]::Zero)
}

function ConvertTo-SafeWindowText {
  param([AllowNull()][string]$Value)

  $safe = ([string]$Value) -replace '[\x00-\x1F\x7F]', ' '
  $safe = $safe.Trim()
  if ($safe.Length -gt 160) {
    return $safe.Substring(0, 160)
  }
  return $safe
}

function Get-RootWindowHandle {
  param([System.IntPtr]$Handle)

  if ($Handle -eq [System.IntPtr]::Zero) {
    return [System.IntPtr]::Zero
  }

  return [NativeInput]::GetAncestor($Handle, 2)
}

function Get-WindowMetadata {
  param([System.IntPtr]$Handle)

  $rootHandle = Get-RootWindowHandle -Handle $Handle
  if ($rootHandle -eq [System.IntPtr]::Zero) {
    return [PSCustomObject]@{
      available = $false
      handle = ""
      title = ""
      processId = 0
      processName = ""
      isOperatorDesktopController = $false
    }
  }

  # A title may change between GetWindowTextLength and GetWindowText. Use a
  # fixed bounded buffer so a short stale length cannot hide a controller title.
  $titleBuilder = New-Object System.Text.StringBuilder 8193
  [NativeInput]::GetWindowText($rootHandle, $titleBuilder, $titleBuilder.Capacity) | Out-Null
  $title = ConvertTo-SafeWindowText -Value $titleBuilder.ToString()
  [uint32]$processId = 0
  [NativeInput]::GetWindowThreadProcessId($rootHandle, [ref]$processId) | Out-Null
  $processName = ""
  if ($processId -gt 0) {
    try {
      $processName = ConvertTo-SafeWindowText -Value ([System.Diagnostics.Process]::GetProcessById([int]$processId).ProcessName)
    }
    catch {
      $processName = ""
    }
  }

  return [PSCustomObject]@{
    available = $true
    handle = ('0x{0:X}' -f $rootHandle.ToInt64())
    title = $title
    processId = [int]$processId
    processName = $processName
    isOperatorDesktopController = [bool](Test-OperatorDesktopControllerTitle -Title $title)
  }
}

function Get-PointWindowMetadata {
  param(
    [int]$PointX,
    [int]$PointY
  )

  $point = New-Object NativeInput+POINT
  $point.X = $PointX
  $point.Y = $PointY
  return Get-WindowMetadata -Handle ([NativeInput]::WindowFromPoint($point))
}

function Get-ForegroundWindowMetadata {
  return Get-WindowMetadata -Handle ([NativeInput]::GetForegroundWindow())
}

function Throw-ControllerInputBlocked {
  param(
    [ValidateSet("point", "foreground")]
    [string]$Target,
    [object]$Window
  )

  $payload = [PSCustomObject]@{
    code = "OPERATOR_CONTROLLER_INPUT_BLOCKED"
    target = $Target
    window = $Window
  }
  throw ("OPERATOR_CONTROLLER_INPUT_BLOCKED " + ($payload | ConvertTo-Json -Compress -Depth 4))
}

function Set-OperatorNativeWindowForeground {
  param([IntPtr]$Handle)
  return [NativeInput]::SetForegroundWindow($Handle)
}

function Get-OperatorNativeWindowHitTest {
  param([IntPtr]$Handle,[int]$PointX,[int]$PointY)
  if($PointX -lt -32768 -or $PointX -gt 32767 -or $PointY -lt -32768 -or $PointY -gt 32767){return $null}
  $packed=(([int64]($PointY -band 0xffff)) -shl 16) -bor ($PointX -band 0xffff)
  $result=[UIntPtr]::Zero
  $ok=[NativeInput]::SendMessageTimeout($Handle, 0x0084, [IntPtr]::Zero, [IntPtr]$packed, 0x0002, 100, [ref]$result)
  if($ok -eq [IntPtr]::Zero){return $null}
  return $result.ToUInt64()
}

function Set-OperatorNativeCursorPosition {
  param([int]$PointX,[int]$PointY)
  return [NativeInput]::SetCursorPos($PointX,$PointY)
}

function Send-OperatorNativeLeftClick {
  # Called only after the shared exact-owned HTCAPTION check. A normal click,
  # not a foreground-lock bypass or a second click in the model canvas.
  [NativeInput]::mouse_event($mouseFlags.LeftDown, 0, 0, 0, [UIntPtr]::Zero)
  try { Start-Sleep -Milliseconds 50 }
  finally { [NativeInput]::mouse_event($mouseFlags.LeftUp, 0, 0, 0, [UIntPtr]::Zero) }
}

function Assert-PointInputAllowed {
  param([int]$PointX,[int]$PointY)
  return Assert-OperatorNativePointInput -PointX $PointX -PointY $PointY
}

function Assert-ForegroundInputAllowed {
  $metadata = Get-ForegroundWindowMetadata
  if ($metadata.isOperatorDesktopController) {
    Throw-ControllerInputBlocked -Target "foreground" -Window $metadata
  }
  if ($ExpectedRevitProcessId -gt 0 -and (!$metadata.available -or $metadata.processId -ne $ExpectedRevitProcessId -or $metadata.processName -ne 'Revit')) {
    throw 'NATIVE_INTERACTIVE_REQUIRES_EXACT_REVIT_WINDOW'
  }
  return $metadata
}

function Get-GuardCheckPayload {
  param(
    [int]$PointX,
    [int]$PointY
  )

  $pointWindow = Get-PointWindowMetadata -PointX $PointX -PointY $PointY
  $foregroundWindow = Get-ForegroundWindowMetadata
  return [PSCustomObject]@{
    ok = $true
    action = "guard_check"
    point = [PSCustomObject]@{ x = $PointX; y = $PointY; window = $pointWindow }
    foreground = $foregroundWindow
    pointBlocked = [bool]$pointWindow.isOperatorDesktopController
    foregroundBlocked = [bool]$foregroundWindow.isOperatorDesktopController
    blocked = [bool]($pointWindow.isOperatorDesktopController -or $foregroundWindow.isOperatorDesktopController)
  }
}

function Draw-CursorMarker {
  param(
    [System.Drawing.Graphics]$Graphics,
    [int]$ScreenX,
    [int]$ScreenY,
    [int]$OriginX,
    [int]$OriginY,
    [int]$Width,
    [int]$Height
  )

  $localX = $ScreenX - $OriginX
  $localY = $ScreenY - $OriginY
  if ($localX -lt 0 -or $localY -lt 0 -or $localX -ge $Width -or $localY -ge $Height) {
    return
  }

  $outer = New-Object System.Drawing.Pen([System.Drawing.Color]::White, 5)
  $inner = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(230, 220, 38, 38), 2)
  try {
    $r = 10
    $Graphics.DrawEllipse($outer, $localX - $r, $localY - $r, $r * 2, $r * 2)
    $Graphics.DrawLine($outer, $localX - 16, $localY, $localX + 16, $localY)
    $Graphics.DrawLine($outer, $localX, $localY - 16, $localX, $localY + 16)
    $Graphics.DrawEllipse($inner, $localX - $r, $localY - $r, $r * 2, $r * 2)
    $Graphics.DrawLine($inner, $localX - 16, $localY, $localX + 16, $localY)
    $Graphics.DrawLine($inner, $localX, $localY - 16, $localX, $localY + 16)
  }
  finally {
    $outer.Dispose()
    $inner.Dispose()
  }
}

function Escape-SendKeysText {
  param([string]$Text)

  $escaped = $Text.Replace("{", "{{}").Replace("}", "{}}")
  foreach ($char in @("+", "^", "%", "~", "(", ")")) {
    $escaped = $escaped.Replace($char, "{$char}")
  }
  return $escaped
}

function Get-SendKeysToken {
  param([string]$Key)

  $normalized = $Key.ToUpperInvariant()
  $map = @{
    "ENTER" = "{ENTER}"
    "RETURN" = "{ENTER}"
    "TAB" = "{TAB}"
    "ESC" = "{ESC}"
    "ESCAPE" = "{ESC}"
    "BACKSPACE" = "{BACKSPACE}"
    "DELETE" = "{DELETE}"
    "DEL" = "{DELETE}"
    "INSERT" = "{INSERT}"
    "HOME" = "{HOME}"
    "END" = "{END}"
    "PGUP" = "{PGUP}"
    "PAGEUP" = "{PGUP}"
    "PGDN" = "{PGDN}"
    "PAGEDOWN" = "{PGDN}"
    "UP" = "{UP}"
    "DOWN" = "{DOWN}"
    "LEFT" = "{LEFT}"
    "RIGHT" = "{RIGHT}"
    "SPACE" = " "
    "F1" = "{F1}"
    "F2" = "{F2}"
    "F3" = "{F3}"
    "F4" = "{F4}"
    "F5" = "{F5}"
    "F6" = "{F6}"
    "F7" = "{F7}"
    "F8" = "{F8}"
    "F9" = "{F9}"
    "F10" = "{F10}"
    "F11" = "{F11}"
    "F12" = "{F12}"
  }

  if ($map.ContainsKey($normalized)) {
    return $map[$normalized]
  }

  if ($normalized.Length -eq 1) {
    return Escape-SendKeysText -Text $normalized
  }

  throw "Unsupported key: $Key"
}

function Send-Keys {
  param([string[]]$Keys)

  $modifiers = ""
  $remaining = New-Object System.Collections.Generic.List[string]

  foreach ($key in $Keys) {
    switch ($key.ToUpperInvariant()) {
      "CTRL" { $modifiers += "^" }
      "CONTROL" { $modifiers += "^" }
      "ALT" { $modifiers += "%" }
      "SHIFT" { $modifiers += "+" }
      default { $remaining.Add($key) | Out-Null }
    }
  }

  if ($remaining.Count -eq 0) {
    return
  }

  if ($modifiers -ne "" -and $remaining.Count -eq 1) {
    $token = Get-SendKeysToken -Key $remaining[0]
    Assert-ForegroundInputAllowed | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait($modifiers + $token)
    return
  }

  foreach ($key in $remaining) {
    Assert-ForegroundInputAllowed | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait((Get-SendKeysToken -Key $key))
    Start-Sleep -Milliseconds 50
  }
}

function Get-VirtualScreenBounds {
  return [System.Windows.Forms.SystemInformation]::VirtualScreen
}

function Get-ScreenDescriptors {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $descriptors = New-Object System.Collections.Generic.List[object]
  $index = 0
  foreach ($screen in $screens) {
    $bounds = $screen.Bounds
    $workingArea = $screen.WorkingArea
    $descriptors.Add([PSCustomObject]@{
      index = $index
      deviceName = $screen.DeviceName
      primary = $screen.Primary
      x = $bounds.X
      y = $bounds.Y
      width = $bounds.Width
      height = $bounds.Height
      workingX = $workingArea.X
      workingY = $workingArea.Y
      workingWidth = $workingArea.Width
      workingHeight = $workingArea.Height
    }) | Out-Null
    $index += 1
  }
  return $descriptors
}

switch ($Action) {
  "review_native_read_admission" {
    if (-not $ReviewSceneBase64 -or $ReviewSceneBase64.Length -gt 16384) { throw 'visual_review_scene_invalid' }
    $scene = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ReviewSceneBase64)) | ConvertFrom-Json
    . "$PSScriptRoot\visual_review_capture.ps1"
    Get-OperatorReviewNativeReadAdmission $scene | ConvertTo-Json -Compress -Depth 6
    break
  }
  "review_screenshot" {
    if (-not $ReviewSceneBase64 -or $ReviewSceneBase64.Length -gt 16384) { throw 'visual_review_scene_invalid' }
    $scene = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ReviewSceneBase64)) | ConvertFrom-Json
    . "$PSScriptRoot\visual_review_capture.ps1"
    Get-OperatorVisualReviewCapture $scene | ConvertTo-Json -Compress -Depth 6
    break
  }
  "screenshot" {
    $bounds = Get-VirtualScreenBounds
    $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $cursorPoint = New-Object NativeInput+POINT
    $hasCursor = [NativeInput]::GetCursorPos([ref]$cursorPoint)
    if ($hasCursor) {
      Draw-CursorMarker -Graphics $graphics -ScreenX $cursorPoint.X -ScreenY $cursorPoint.Y -OriginX $bounds.X -OriginY $bounds.Y -Width $bounds.Width -Height $bounds.Height
    }
    $cursorPayload = $null
    if ($hasCursor) {
      $cursorPayload = @{
        x = $cursorPoint.X
        y = $cursorPoint.Y
        relativeX = $cursorPoint.X - $bounds.X
        relativeY = $cursorPoint.Y - $bounds.Y
        visible = ($cursorPoint.X -ge $bounds.X -and $cursorPoint.Y -ge $bounds.Y -and $cursorPoint.X -lt ($bounds.X + $bounds.Width) -and $cursorPoint.Y -lt ($bounds.Y + $bounds.Height))
      }
    }

    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)

    $result = @{
      x = $bounds.X
      y = $bounds.Y
      width = $bounds.Width
      height = $bounds.Height
      monitorCount = [System.Windows.Forms.Screen]::AllScreens.Count
      monitors = Get-ScreenDescriptors
      cursor = $cursorPayload
      imageBase64 = [Convert]::ToBase64String($stream.ToArray())
    }

    $graphics.Dispose()
    $bitmap.Dispose()
    $stream.Dispose()

    $result | ConvertTo-Json -Compress
    break
  }
  "move" {
    Assert-PointInputAllowed -PointX $X -PointY $Y | Out-Null
    [NativeInput]::SetCursorPos($X, $Y) | Out-Null
    break
  }
  "click" {
    if (Invoke-OperatorNativeCaptionActivation -PointX $X -PointY $Y -MouseButton $Button) { break }
    Assert-PointInputAllowed -PointX $X -PointY $Y | Out-Null
    [NativeInput]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 50
    Invoke-MouseClick -MouseButton $Button -PointX $X -PointY $Y
    break
  }
  "double_click" {
    Assert-PointInputAllowed -PointX $X -PointY $Y | Out-Null
    [NativeInput]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 50
    Invoke-MouseClick -MouseButton $Button -PointX $X -PointY $Y
    Start-Sleep -Milliseconds 100
    Invoke-MouseClick -MouseButton $Button -PointX $X -PointY $Y
    break
  }
  "scroll" {
    Assert-PointInputAllowed -PointX $X -PointY $Y | Out-Null
    [NativeInput]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 50
    Assert-PointInputAllowed -PointX $X -PointY $Y | Out-Null
    [NativeInput]::mouse_event($mouseFlags.Wheel, 0, 0, (ConvertTo-OperatorMouseWheelData -Delta $ScrollY), [UIntPtr]::Zero)
    break
  }
  "type" {
    Assert-ForegroundInputAllowed | Out-Null
    $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TextBase64))
    Assert-ForegroundInputAllowed | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait((Escape-SendKeysText -Text $text))
    break
  }
  "keypress" {
    Assert-ForegroundInputAllowed | Out-Null
    $json = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($KeysJsonBase64))
    $keys = $json | ConvertFrom-Json
    $keyList = New-Object System.Collections.Generic.List[string]

    foreach ($key in $keys) {
      $keyList.Add([string]$key) | Out-Null
    }

    Send-Keys -Keys $keyList.ToArray()
    break
  }
  "cancel_native_placement" {
    if ($ExpectedRevitProcessId -le 0) { throw 'NATIVE_INTERACTIVE_EXACT_PROCESS_REQUIRED' }
    $owned = Get-Process -Id $ExpectedRevitProcessId -ErrorAction Stop
    if ($owned.ProcessName -ne 'Revit') { throw 'NATIVE_INTERACTIVE_EXACT_PROCESS_REQUIRED' }
    $ownedWindow = $owned.MainWindowHandle
    if ($ownedWindow -eq [IntPtr]::Zero) { throw 'NATIVE_INTERACTIVE_WINDOW_UNAVAILABLE' }
    $ownedWindowProcess = [uint32]0
    [NativeInput]::GetWindowThreadProcessId($ownedWindow, [ref]$ownedWindowProcess) | Out-Null
    if ($ownedWindowProcess -ne [uint32]$ExpectedRevitProcessId) { throw 'NATIVE_INTERACTIVE_WINDOW_CHANGED' }
    # Host cancellation only: no activation and no keyboard input to whichever
    # app the user focused to press Pause. Fixed Escape targets the owned Revit
    # window, while the original native result retains every committed effect.
    $down = [NativeInput]::PostMessage($ownedWindow, 0x0100, [IntPtr]0x1B, [IntPtr]::Zero)
    $up = [NativeInput]::PostMessage($ownedWindow, 0x0101, [IntPtr]0x1B, [IntPtr]::Zero)
    if (!$down -or !$up) { throw 'NATIVE_INTERACTIVE_CANCEL_POST_FAILED' }
    [pscustomobject]@{ process_id=$ExpectedRevitProcessId; escape_posted=$true; native_result_required=$true } | ConvertTo-Json -Compress
    break
  }
  "verified_revit_close" {
    if ($ExpectedRevitProcessId -le 0) {
      throw "An exact native Revit process ID is required before fixture close."
    }
    $revitProcess = Get-Process -Id $ExpectedRevitProcessId -ErrorAction Stop
    if ($revitProcess.ProcessName -ne "Revit") {
      throw "The expected fixture process is not Revit."
    }
    $foreground = [NativeInput]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) {
      throw "No foreground window is available for verified Revit close."
    }
    $foregroundProcessId = [uint32]0
    [NativeInput]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) | Out-Null
    if ($foregroundProcessId -ne [uint32]$ExpectedRevitProcessId) {
      throw "The foreground window does not belong to the exact native Revit process."
    }
    $titleLength = [NativeInput]::GetWindowTextLength($foreground)
    $windowTitle = New-Object System.Text.StringBuilder ($titleLength + 1)
    [NativeInput]::GetWindowText($foreground, $windowTitle, $windowTitle.Capacity) | Out-Null
    if ($windowTitle.ToString() -notmatch 'Autodesk Revit') {
      throw "The foreground Revit window title could not be verified."
    }
    Assert-ForegroundInputAllowed | Out-Null
    [System.Windows.Forms.SendKeys]::SendWait("^w")
    [PSCustomObject]@{
      status = "Close Requested Via Verified Revit UI"
      process_id = $ExpectedRevitProcessId
      window_title = $windowTitle.ToString()
      command = "Ctrl+W"
    } | ConvertTo-Json -Compress
    break
  }
  "drag" {
    $dragPoints = @(Resolve-OperatorDragPath -PathJsonBase64 $DragPathJsonBase64 -LegacyCoordinates $PSBoundParameters)
    Invoke-OperatorDrag -Points $dragPoints -Button $Button
    break
  }
  "wait" {
    Start-Sleep -Milliseconds $DelayMs
    break
  }
  "guard_check" {
    Get-GuardCheckPayload -PointX $X -PointY $Y | ConvertTo-Json -Compress -Depth 5
    break
  }
}
