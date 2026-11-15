. "$PSScriptRoot/Common.ps1"
Assert-ClosedRevit
$runtimePath=Join-Path $OpenCoreState 'runtime.json'
if(!(Test-Path -LiteralPath $runtimePath)){Write-Host 'No local backend was started by this folder.';return}
$runtime=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$process=Get-CimInstance Win32_Process -Filter "ProcessId=$($runtime.pid)"
if(!$process){Write-Host 'The local backend is already stopped.';return}
# CIM reports microseconds, Process.StartTime may include finer ticks. Compare
# their common millisecond precision while retaining PID, executable and entry.
if([IO.Path]::GetFullPath($process.ExecutablePath) -ne [IO.Path]::GetFullPath($runtime.node) -or ([DateTimeOffset]$process.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ne ([DateTimeOffset]$runtime.started).ToUnixTimeMilliseconds() -or !$process.CommandLine.Contains($runtime.entry)) {
    throw 'The process does not match this installation. Nothing was stopped.'
}
# Snapshot only descendants of this exact owned backend, then stop that tree.
$all=@(Get-CimInstance Win32_Process)
$owned=@($process);$front=@($process.ProcessId)
while($front.Count){$children=@($all | Where-Object ParentProcessId -in $front);$owned+=$children;$front=@($children | ForEach-Object ProcessId)}
foreach($item in @($owned | Sort-Object CreationDate -Descending)) {
    $live=Get-CimInstance Win32_Process -Filter "ProcessId=$($item.ProcessId)"
    if($live -and $live.CreationDate -eq $item.CreationDate -and $live.ExecutablePath -eq $item.ExecutablePath){Stop-Process -Id $live.ProcessId}
}
Write-Host 'This folder''s local Operator backend is stopped. Saved models and task records remain available.'
