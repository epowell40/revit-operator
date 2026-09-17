// Fixed, read-only worker protocol. No caller-controlled script or command is executed.
// Keep the PowerShell host alive to avoid paying startup/CIM module costs on every
// bridge request. All listener, process and signature observations remain fresh.
export const WINDOWS_LISTENER_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$source = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
public static class OperatorListenerInspector {
  [DllImport("iphlpapi.dll", SetLastError=true)] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int family, int tableClass, uint reserved);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static int[] ListenerPids(int port) {
    var result = new HashSet<int>();
    foreach (int family in new int[] { 2, 23 }) {
      int size = 0;
      uint error = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, 3, 0);
      if (error != 122 && error != 0) throw new InvalidOperationException("TCP owner query failed: " + error);
      // The table can grow between the sizing and read calls. Retry boundedly.
      bool read = false;
      for (int attempt = 0; attempt < 3; attempt++) {
        if (size < 4 || size > 16777216) throw new InvalidOperationException("Invalid TCP table size");
        IntPtr buffer = Marshal.AllocHGlobal(size);
        try {
          int capacity = size;
          error = GetExtendedTcpTable(buffer, ref size, false, family, 3, 0);
          if (error == 122) continue;
          if (error != 0) throw new InvalidOperationException("TCP owner query failed: " + error);
          int count = Marshal.ReadInt32(buffer), rowSize = family == 2 ? 24 : 56;
          if (count < 0 || count > (capacity - 4) / rowSize) throw new InvalidOperationException("Invalid TCP owner rows");
          for (int i = 0; i < count; i++) {
            IntPtr row = IntPtr.Add(buffer, 4 + i * rowSize);
            int offset = family == 2 ? 8 : 20;
            int rowPort = Marshal.ReadByte(row, offset) * 256 + Marshal.ReadByte(row, offset + 1);
            int pid = Marshal.ReadInt32(row, family == 2 ? 20 : 52);
            if (rowPort == port && pid > 0) result.Add(pid);
          }
          read = true;
          break;
        } finally { Marshal.FreeHGlobal(buffer); }
      }
      if (!read) throw new InvalidOperationException("TCP owner table changed during inspection");
    }
    int[] pids = new int[result.Count]; result.CopyTo(pids); Array.Sort(pids); return pids;
  }
  public static string OwnerSid(Process process) {
    IntPtr token;
    if (!OpenProcessToken(process.Handle, 8, out token)) throw new InvalidOperationException("Cannot read process owner: " + Marshal.GetLastWin32Error());
    try { using (var identity = new WindowsIdentity(token)) { return identity.User.Value; } }
    finally { CloseHandle(token); }
  }
}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $requestId = $null
  $process = $null
  try {
    if ($line.Length -gt 2048) { throw 'Inspector request too large' }
    $request = ConvertFrom-Json -InputObject $line
    $requestId = [string]$request.id
    if ($requestId -notmatch '^[a-f0-9]{32}$') { throw 'Invalid request identity' }
    $port = [int]$request.port
    $preferredPid = [int]$request.preferredPid
    if ($port -lt 1 -or $port -gt 65535 -or $preferredPid -lt 0) { throw 'Invalid listener identity' }
    $hostName = [string]$request.host
    if ($hostName -notin @('127.0.0.1', 'localhost', '[::1]')) { throw 'Invalid loopback host' }
    $owners = @([OperatorListenerInspector]::ListenerPids($port))
    $pids = @($owners | Where-Object { $_ -ne 4 })
    if ($pids.Count -eq 0 -and $owners -contains 4 -and $preferredPid -gt 0) { $pids = @($preferredPid) }
    if ($pids.Count -eq 0 -and $owners -contains 4) {
      $serviceState = (& "$env:SystemRoot\System32\netsh.exe" http show servicestate view=requestq verbose=yes | Out-String)
      $target = [regex]::Escape(('http://' + $hostName + ':' + $port))
      $blocks = @([regex]::Split($serviceState, '(?im)(?=^ {8}Request queue name\s*:)') | Where-Object { $_ -match ('(?im)^\s*' + $target + '(?::[^\s/]+)?/\s*$') })
      if ($blocks.Count -ne 1) { throw 'Expected exactly one HTTP.sys request queue for the selected Revit bridge origin' }
      $pids = @([System.Diagnostics.Process]::GetProcessesByName('Revit') | ForEach-Object {
        try {
          $candidatePid = $_.Id
          if ($blocks[0] -match ('(?im)^\s*(?:(?:Process\s+)?ID|Active process attached|Controller process)\s*:\s*' + $candidatePid + '(?:\s|,|$)') -or $blocks[0] -match ('(?im)^\s*' + $candidatePid + '\s*$')) { $candidatePid }
        } finally { $_.Dispose() }
      } | Sort-Object -Unique)
    }
    if ($pids.Count -ne 1) { throw "Expected exactly one listener process on port $port; found $($pids.Count)" }
    $process = [System.Diagnostics.Process]::GetProcessById($pids[0])
    $started = $process.StartTime.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $executable = $process.MainModule.FileName
    $ownerSid = [OperatorListenerInspector]::OwnerSid($process)
    $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # No signature or listener cache: every request verifies the current file.
    $signature = Get-AuthenticodeSignature -LiteralPath $executable -ErrorAction Stop
    $afterOwners = @([OperatorListenerInspector]::ListenerPids($port))
    if ($process.HasExited -or (($owners -join ',') -cne ($afterOwners -join ','))) { throw 'Listener changed during identity inspection' }
    $snapshot = [ordered]@{
      pid = [int]$process.Id; port = $port; process_name = [IO.Path]::GetFileName($executable)
      executable_path = $executable; created_utc = $started; owner_sid = $ownerSid; current_sid = $currentSid
      owner_matches_current_user = ($ownerSid -ceq $currentSid)
      signature_status = [string]$signature.Status; signer_subject = [string]$signature.SignerCertificate.Subject
    }
    [Console]::Out.WriteLine((@{id=$requestId; snapshot=$snapshot} | ConvertTo-Json -Compress -Depth 4))
  } catch {
    [Console]::Out.WriteLine((@{id=$requestId; error=$_.Exception.Message} | ConvertTo-Json -Compress))
  } finally { if ($null -ne $process) { $process.Dispose() } }
}
`;
