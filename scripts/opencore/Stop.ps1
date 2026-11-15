. "$PSScriptRoot/Common.ps1"
Assert-ClosedRevit
$runtimePath=Join-Path $OpenCoreState 'runtime.json'
if(!(Test-Path -LiteralPath $runtimePath)){Write-Host 'No local backend was started by this folder.';return}
$runtime=Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$records=@($runtime)
if($runtime.PSObject.Properties['sidecar']){$records+=@($runtime.sidecar)}
# Validate every live root before stopping anything, including a partly exited run.
$roots=@(foreach($record in $records){if(Get-CimInstance Win32_Process -Filter "ProcessId=$($record.pid)"){Assert-OpenCoreProcess $record}})
if(!$roots.Count){Write-Host 'This installation is already stopped.';return}
# Snapshot only descendants of this exact owned backend, then stop that tree.
$all=@(Get-CimInstance Win32_Process)
$owned=@($roots);$front=@($roots | ForEach-Object ProcessId)
while($front.Count){$children=@($all | Where-Object ParentProcessId -in $front);$owned+=$children;$front=@($children | ForEach-Object ProcessId)}
foreach($item in @($owned | Sort-Object CreationDate -Descending)) {
    $live=Get-CimInstance Win32_Process -Filter "ProcessId=$($item.ProcessId)"
    if($live -and $live.CreationDate -eq $item.CreationDate -and $live.ExecutablePath -eq $item.ExecutablePath){Stop-Process -Id $live.ProcessId}
}
Write-Host 'This folder''s Operator interface and backend are stopped. Saved models and task records remain available.'
