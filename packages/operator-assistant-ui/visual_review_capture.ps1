# Host-only capture for independent visual review. No actor rectangle, image,
# path, focus action or window selection is accepted by the tool schema.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
if (-not ('OperatorReviewWindows' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OperatorReviewWindows {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out RECT r);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr w);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr w);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr w, uint command);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr w, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
}
'@
}

function Get-ReviewRectangle([IntPtr]$Window) {
  $rectangle = New-Object OperatorReviewWindows+RECT
  if (-not [OperatorReviewWindows]::GetWindowRect($Window, [ref]$rectangle)) { throw 'visual_review_window_rectangle_unavailable' }
  return @{x=$rectangle.Left; y=$rectangle.Top; width=$rectangle.Right-$rectangle.Left; height=$rectangle.Bottom-$rectangle.Top}
}
function Test-ReviewRectangle($Rectangle) {
  if ($null -eq $Rectangle) { return $false }
  foreach ($key in @('x','y','width','height')) {
    $value = $Rectangle.$key
    if ($null -eq $value -or $value -isnot [ValueType] -or [double]$value -ne [math]::Truncate([double]$value)) { return $false }
  }
  return ($Rectangle.width -ge 40 -and $Rectangle.height -ge 40 -and $Rectangle.width -le 16000 -and $Rectangle.height -le 16000 -and $Rectangle.width*$Rectangle.height -le 24000000)
}
function Test-ReviewRectangleEqual($Left, $Right) {
  foreach ($key in @('x','y','width','height')) { if ($Left.$key -ne $Right.$key) { return $false } }
  return $true
}
function Test-ReviewContains($Outer, $Inner) {
  return ($Inner.x -ge $Outer.x -and $Inner.y -ge $Outer.y -and $Inner.x+$Inner.width -le $Outer.x+$Outer.width -and $Inner.y+$Inner.height -le $Outer.y+$Outer.height)
}
function Assert-ReviewProcess([IntPtr]$Window, [int]$ExpectedProcess) {
  [uint32]$ownerProcess = 0
  [OperatorReviewWindows]::GetWindowThreadProcessId($Window, [ref]$ownerProcess) | Out-Null
  if ($ownerProcess -ne $ExpectedProcess -or $Window -eq [IntPtr]::Zero) { throw 'visual_review_window_owner_changed' }
}
function Get-ReviewDesktopBounds {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  return @{x=$screen.X;y=$screen.Y;width=$screen.Width;height=$screen.Height}
}
function Get-ReviewCapturePlan($Scene) {
  $frame = $Scene.visual_capture_context
  if ($null -eq $frame -or $frame.main_window_handle -notmatch '^0x[0-9A-Fa-f]{1,16}$' -or -not (Test-ReviewRectangle $frame.main_window_bounds)) { throw 'visual_review_native_frame_unavailable' }
  $main = [IntPtr]([Convert]::ToInt64($frame.main_window_handle.Substring(2),16))
  Assert-ReviewProcess $main $Scene.process_id
  if (-not [OperatorReviewWindows]::IsWindowVisible($main) -or [OperatorReviewWindows]::IsIconic($main)) { throw 'visual_review_revit_not_visible' }
  if (-not (Test-ReviewRectangleEqual (Get-ReviewRectangle $main) $frame.main_window_bounds)) { throw 'visual_review_main_window_moved' }
  $foreground = [OperatorReviewWindows]::GetAncestor([OperatorReviewWindows]::GetForegroundWindow(),2)
  Assert-ReviewProcess $foreground $Scene.process_id
  if ($foreground -eq $main) {
    if (-not [OperatorReviewWindows]::IsWindowEnabled($main)) { throw 'visual_review_modal_not_foreground' }
    if ([DateTimeOffset]::UtcNow - [DateTimeOffset]::Parse($Scene.identity_captured_at_utc) -gt [TimeSpan]::FromSeconds(10)) { throw 'visual_review_view_rectangle_stale' }
    $rectangle = $frame.view_rectangle
    if (-not (Test-ReviewRectangle $rectangle) -or -not (Test-ReviewContains $frame.main_window_bounds $rectangle)) { throw 'visual_review_view_rectangle_unavailable' }
    $kind = 'revit_view'
  } else {
    # Only a genuinely modal, exact-process owned dialog. A browser, floating
    # worker pane, other application or unowned popup must never become evidence.
    if ([OperatorReviewWindows]::IsWindowEnabled($main)) { throw 'visual_review_not_owned_modal' }
    $cursor = $foreground; $owned = $false
    for ($i=0; $i -lt 8; $i++) {
      $cursor = [OperatorReviewWindows]::GetWindow($cursor,4)
      if ($cursor -eq [IntPtr]::Zero) { break }
      Assert-ReviewProcess $cursor $Scene.process_id
      if ($cursor -eq $main) { $owned=$true; break }
    }
    if (-not $owned -or -not [OperatorReviewWindows]::IsWindowVisible($foreground)) { throw 'visual_review_not_owned_modal' }
    $rectangle = Get-ReviewRectangle $foreground
    $kind = 'revit_dialog'
  }
  if (-not (Test-ReviewRectangle $rectangle)) { throw 'visual_review_frame_invalid' }
  if (-not (Test-ReviewContains (Get-ReviewDesktopBounds) $rectangle)) { throw 'visual_review_frame_offscreen' }
  # Check occlusion at a bounded grid before AND after CopyFromScreen. The
  # reviewer must still mark any visible tooltip/partial occlusion uncertain.
  foreach ($fx in @(0.02,0.5,0.98)) { foreach ($fy in @(0.02,0.5,0.98)) {
    $point = New-Object OperatorReviewWindows+POINT
    $point.X=[int]($rectangle.x+($rectangle.width-1)*$fx); $point.Y=[int]($rectangle.y+($rectangle.height-1)*$fy)
    $root=[OperatorReviewWindows]::GetAncestor([OperatorReviewWindows]::WindowFromPoint($point),2)
    if ($root -ne $foreground) { throw 'visual_review_frame_occluded' }
  } }
  return @{schema='operator.visual_review_capture.v1';kind=$kind;process_id=$Scene.process_id;view_id=$Scene.view_id;main_window_handle=$frame.main_window_handle;foreground_window_handle=('0x{0:X}' -f $foreground.ToInt64());rectangle=$rectangle;captured_at_utc=[DateTimeOffset]::UtcNow.ToString('o');selection_authority='native_view_or_owned_modal';occlusion_check='nine_point_screen_grid_not_pixel_exhaustive'}
}

function Get-OperatorVisualReviewCapture($Scene) {
  $dpi = [OperatorReviewWindows]::SetThreadDpiAwarenessContext([IntPtr](-4))
  $bitmap=$null; $graphics=$null; $stream=$null
  try {
    $before = Get-ReviewCapturePlan $Scene
    $rectangle = $before.rectangle
    $bitmap = New-Object System.Drawing.Bitmap($rectangle.width,$rectangle.height)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $graphics.CopyFromScreen([System.Drawing.Point]::new($rectangle.x,$rectangle.y),[System.Drawing.Point]::Empty,[System.Drawing.Size]::new($rectangle.width,$rectangle.height))
    $after = Get-ReviewCapturePlan $Scene
    if ($before.kind -ne $after.kind -or $before.foreground_window_handle -ne $after.foreground_window_handle -or -not (Test-ReviewRectangleEqual $before.rectangle $after.rectangle)) { throw 'visual_review_frame_changed_during_capture' }
    $stream = New-Object System.IO.MemoryStream
    $bitmap.Save($stream,[System.Drawing.Imaging.ImageFormat]::Png)
    return @{image_base64=[Convert]::ToBase64String($stream.ToArray());frame=$before}
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }; if ($null -ne $graphics) { $graphics.Dispose() }; if ($null -ne $bitmap) { $bitmap.Dispose() }
    if ($dpi -ne [IntPtr]::Zero) { [OperatorReviewWindows]::SetThreadDpiAwarenessContext($dpi) | Out-Null }
  }
}
