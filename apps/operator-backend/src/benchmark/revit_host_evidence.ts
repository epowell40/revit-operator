import { execFileSync } from "node:child_process";
import os from "node:os";
import type { RevitHostEvidence } from "./revit_preflight.js";

export function collectLocalRevitHostEvidence(): RevitHostEvidence | undefined {
  if (os.platform() !== "win32") return { platform: os.platform(), checked_at: new Date().toISOString() };
  const script = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$processes = @(Get-Process Revit | ForEach-Object {
  [pscustomobject]@{
    id = $_.Id
    path = $_.Path
    main_window_title = $_.MainWindowTitle
    responding = $_.Responding
    start_time = if ($_.StartTime) { $_.StartTime.ToString('o') } else { $null }
  }
})
$modalWindows = @()
if ($processes.Count -gt 0) {
  Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class RevitOperatorPreflightWindows {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
}
"@ | Out-Null
  $processIds = @{}
  foreach ($p in $processes) { $processIds[[int]$p.id] = $true }
  $windows = New-Object System.Collections.Generic.List[object]
  $callback = [RevitOperatorPreflightWindows+EnumWindowsProc]{
    param($hwnd,$lparam)
    if([RevitOperatorPreflightWindows]::IsWindowVisible($hwnd)){
      $procId = 0
      [void][RevitOperatorPreflightWindows]::GetWindowThreadProcessId($hwnd, [ref]$procId)
      if($processIds.ContainsKey([int]$procId)){
        $sb = New-Object System.Text.StringBuilder 512
        [void][RevitOperatorPreflightWindows]::GetWindowText($hwnd,$sb,$sb.Capacity)
        $title = $sb.ToString()
        if($title.Trim().Length -gt 0){
          $windows.Add([pscustomobject]@{ process_id = [int]$procId; title = $title })
        }
      }
    }
    return $true
  }
  [void][RevitOperatorPreflightWindows]::EnumWindows($callback,[IntPtr]::Zero)
  $modalWindows = @($windows | Where-Object { $_.title -notmatch '^Autodesk Revit\b' -and $_.title -notmatch '^[0-9a-fA-F-]{36}Monitor$' })
}
$start = (Get-Date).AddMinutes(-20)
$events = @(Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=$start} | Where-Object {
  ($_.ProviderName -like '*Application Error*' -or $_.ProviderName -like '*.NET Runtime*' -or $_.ProviderName -like '*Windows Error Reporting*') -and
  ($_.Message -like '*Revit.exe*' -or $_.Message -like '*Application: Revit.exe*')
} | Select-Object -First 10 | ForEach-Object {
  $message = $_.Message
  $faultingModule = $null
  $exceptionCode = $null
  $exitCode = $null
  if ($message -match 'Faulting module name:\s*([^,\r\n]+)') { $faultingModule = $Matches[1].Trim() }
  if ($message -match 'Exception code:\s*([^\s\r\n]+)') { $exceptionCode = $Matches[1].Trim() }
  if ($message -match 'exit code\s+([^\.\s\r\n]+)') { $exitCode = $Matches[1].Trim() }
  [pscustomobject]@{
    time_created = $_.TimeCreated.ToString('o')
    provider_name = $_.ProviderName
    id = $_.Id
    message = $message
    faulting_module = $faultingModule
    exception_code = $exceptionCode
    exit_code = $exitCode
  }
})
[pscustomobject]@{
  platform = 'win32'
  checked_at = (Get-Date).ToString('o')
  revit_processes = $processes
  modal_windows = $modalWindows
  recent_crash_events = $events
} | ConvertTo-Json -Depth 8 -Compress
`;
  try {
    const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true
    }).trim();
    return output ? JSON.parse(output) as RevitHostEvidence : undefined;
  } catch (error) {
    return {
      platform: "win32",
      checked_at: new Date().toISOString(),
      collection_error: error instanceof Error ? error.message : String(error)
    };
  }
}
