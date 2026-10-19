[CmdletBinding()]
param([switch]$RealEngine, [string]$OutputRoot = '')
$ErrorActionPreference = 'Stop'
$publicRoot = Split-Path (Split-Path (Split-Path $PSScriptRoot))
. (Join-Path $publicRoot 'scripts\deploy\Install-Operator.ps1')
if (!$OutputRoot) { $OutputRoot = Join-Path $publicRoot ('local-work\installer-recovery-tests\' + [guid]::NewGuid().ToString('N')) }
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
[void][IO.Directory]::CreateDirectory($OutputRoot)
if ($RealEngine) {
  $enginePath = Join-Path $publicRoot 'packages\operator-deploy\OperatorDeploy\bin\Release\net8.0-windows\win-x64\OperatorDeploy.dll'
  [void][Reflection.Assembly]::LoadFrom($enginePath)
}
$results = [Collections.Generic.List[object]]::new()
$priorLocal = $env:LOCALAPPDATA; $priorRoaming = $env:APPDATA

function Get-Process { param($Name, $ErrorAction) if ($script:revitOpen) { return [pscustomobject]@{Id=123} } }
function powershell.exe { $script:calls.Add('shortcut'); $global:LASTEXITCODE = 0 }
function Invoke-OperatorDeploy([string]$Exe, [string[]]$Arguments) {
  $stage = if ($Arguments -contains '--bundle-only') {'bundle'} elseif ($Arguments -contains '--dry-run') {'plan'} else {$Arguments[0]}
  $script:calls.Add($stage)
  if ($RealEngine) {
    $options = [RevitOperator.Deployment.DeploymentOptions]::new()
    $options.Operation = $Arguments[0]
    $options.BundleOnly = $Arguments -contains '--bundle-only'
    $options.DryRun = $Arguments -contains '--dry-run'
    if ($options.Operation -eq 'update' -or $options.BundleOnly) { $options.ManifestPath = Join-Path $script:package 'manifest.json' }
    $options.LogPath = Join-Path $script:caseRoot ('engine-logs\' + [guid]::NewGuid().ToString('N') + '.log')
    $receipt = [RevitOperator.Deployment.DeploymentEngine]::new($script:context, $options, [IO.TextWriter]::Null).Execute()
    $script:receipts.Add(@{stage=$stage;ok=$receipt.Ok;exitCode=$receipt.ExitCode;message=$receipt.Message})
    return $receipt
  }
  $ok = $true; $message = 'fixture passed'
  if ($stage -eq 'plan' -and $script:needsRecovery -and
      (Get-OperatorBytesSha ([IO.File]::ReadAllBytes($script:addin))) -ne $script:expectedHash) {
    $ok=$false; $message="Installer-owned Revit add-in manifest was modified and will not be replaced or removed: $script:addin"
  }
  if ($script:failure -eq $stage -and ($stage -ne 'plan' -or $script:calls.Count -ge 3)) { $ok=$false; $message='fixture unrelated refusal' }
  if ($stage -eq 'update' -and $ok) {
    [IO.File]::WriteAllText($script:statePath, '{"schemaVersion":3,"currentRelease":"test-new"}')
  }
  return [pscustomobject]@{ok=$ok;exitCode=$(if($ok){0}else{21});message=$message;releaseVersion='test-new'}
}

try {
  $cases = if ($RealEngine) { @('fresh','legacy','owned','already-installed') } else {
    @('fresh','legacy','owned','already-installed','foreign','wrong-sha','bad-legacy-dll','wrong-year','outside-root','bundle-fails','plan-fails','update-fails','validate-fails','revit-open')
  }
  foreach ($year in @('2023','2024','2025','2026','2027')) {
    foreach ($case in $cases) {
      $script:caseRoot = Join-Path $OutputRoot "$year-$case"
      $env:LOCALAPPDATA = Join-Path $script:caseRoot 'Local App Data'
      $env:APPDATA = Join-Path $script:caseRoot 'Roaming App Data'
      $product = Join-Path $env:LOCALAPPDATA 'RevitOperator'
      $script:statePath = Join-Path $product 'deployment\state.json'
      $oldRoot = Join-Path $product 'releases\test-old'
      $script:addin = Join-Path $env:APPDATA "Autodesk\Revit\Addins\$year\RevitBridge.addin"
      $assembly = Join-Path $oldRoot "revit-operator-$year\RevitBridge.dll"
      $script:package = Join-Path $script:caseRoot 'extracted package'
      foreach ($path in @($script:statePath,$script:addin,$assembly,(Join-Path $script:package 'revit\RevitBridge.dll'))) {
        [void][IO.Directory]::CreateDirectory((Split-Path $path))
      }
      [IO.File]::WriteAllText($assembly,'fixture payload')
      [IO.File]::WriteAllText((Join-Path $script:package 'revit\RevitBridge.dll'),'new fixture payload')
      [IO.File]::WriteAllText((Join-Path $script:package 'OperatorDeploy.exe'),'fixture marker - dispatch uses real engine or test double')
      $component = @{id="revit-operator-$year";kind='revit-addin';revitYear=$year;payloadPath='revit';required=$true;installScope='user';files=@(@{path='RevitBridge.dll';size=(Get-Item -LiteralPath $assembly).Length;sha256=(Get-FileHash -LiteralPath $assembly).Hash})}
      $oldManifest = @{schemaVersion=1;releaseVersion='test-old';components=@($component)}
      [IO.File]::WriteAllText((Join-Path $oldRoot 'manifest.json'),($oldManifest|ConvertTo-Json -Depth 10))
      $incoming = $oldManifest | ConvertTo-Json -Depth 10 | ConvertFrom-Json
      $incoming.releaseVersion='test-new'
      $incoming.components[0].files[0].sha256=(Get-FileHash -LiteralPath (Join-Path $script:package 'revit\RevitBridge.dll')).Hash
      $incoming.components[0].files[0].size=(Get-Item -LiteralPath (Join-Path $script:package 'revit\RevitBridge.dll')).Length
      [IO.File]::WriteAllText((Join-Path $script:package 'manifest.json'),($incoming|ConvertTo-Json -Depth 10))
      $canonical=(Get-OperatorRegistrationText $assembly).Replace("`r`n","`n").TrimEnd([char[]]"`r`n").Replace("`n","`r`n")
      $script:expectedHash=Get-OperatorBytesSha ([Text.UTF8Encoding]::new($false).GetBytes($canonical))
      $current=$canonical.Replace($assembly,(Join-Path (Split-Path $script:addin) 'RevitOperator\RevitBridge.dll'))
      if($case -eq 'foreign'){$current=$current.Replace('<Name>RevitOperator</Name>','<Name>Foreign</Name>')}
      [IO.File]::WriteAllText($script:addin,$current)
      $state=@{schemaVersion=3;currentRelease='test-old';successfulReleases=@('test-old');ownedAddinManifests=@(@{revitYear=$year;profileId='revit-bridge-legacy';manifestFileName='RevitBridge.addin';manifestPath=$script:addin;addInId='B2883307-2852-4740-9833-281048674F77';fullClassName='RevitBridge.App';assemblyPath=$assembly;manifestSha256=$script:expectedHash})}
      if($case -in 'legacy','bad-legacy-dll','wrong-year'){$state=@{schemaVersion=1;currentRelease='test-old';successfulReleases=@('test-old')}}
      if($case -eq 'bad-legacy-dll'){[IO.File]::AppendAllText($assembly,'tampered')}
      if($case -eq 'wrong-year'){$oldManifest.components[0].revitYear='2099';[IO.File]::WriteAllText((Join-Path $oldRoot 'manifest.json'),($oldManifest|ConvertTo-Json -Depth 10))}
      if($case -eq 'wrong-sha'){$state.ownedAddinManifests[0].manifestSha256='0'*64}
      if($case -eq 'outside-root'){$state.ownedAddinManifests[0].assemblyPath=$script:addin}
      if($case -eq 'already-installed'){[IO.File]::WriteAllText($script:addin,$canonical)}
      if($case -ne 'fresh'){[IO.File]::WriteAllText($script:statePath,($state|ConvertTo-Json -Depth 10))}
      if($case -eq 'fresh'){[IO.File]::Move($script:addin,($script:addin+'.fresh-fixture-away'))}
      $before=if(Test-Path -LiteralPath $script:addin){Get-OperatorBytesSha ([IO.File]::ReadAllBytes($script:addin))}else{''}
      $script:calls=[Collections.Generic.List[string]]::new()
      $script:receipts=[Collections.Generic.List[object]]::new()
      $script:needsRecovery=$case -notin 'fresh','already-installed'
      $script:failure=switch($case){'bundle-fails'{'bundle'} 'plan-fails'{'plan'} 'update-fails'{'update'} 'validate-fails'{'validate'} default{''}}
      $script:revitOpen=$case -eq 'revit-open'
      if($RealEngine){
        $script:context=[RevitOperator.Deployment.DeploymentContext]::new()
        $script:context.LocalAppData=$env:LOCALAPPDATA; $script:context.AppData=$env:APPDATA
        $script:context.Desktop=Join-Path $script:caseRoot 'Desktop'
        $script:context.CommonAppData=Join-Path $script:caseRoot 'ProgramData'
        $script:context.ProgramFiles=Join-Path $script:caseRoot 'ProgramFiles'
        $script:context.IsRevitRunning=[Func[bool]]{$false}
        $script:context.GetEnvironmentVariable=[Func[string,string]]{param($name) return $null}
        $script:context.TryAcquireDeploymentMutex=[Func[IDisposable]]{[IO.MemoryStream]::new()}
        $revit=Join-Path $script:context.ProgramFiles "Autodesk\Revit $year\Revit.exe"
        [void][IO.Directory]::CreateDirectory((Split-Path $revit));[IO.File]::WriteAllText($revit,'fixture')
      }
      $failed=$false
      try{$output=(& {Install-OperatorPackage $script:package} 6>&1|Out-String)}catch{$failed=$true;$output=$_.Exception.Message}
      [IO.File]::WriteAllText((Join-Path $script:caseRoot 'output.txt'),$output)
      $shouldPass=$case -in 'fresh','legacy','owned','already-installed'
      if($failed -eq $shouldPass){throw "Unexpected result for $year/$case : $output"}
      if($shouldPass -and ($script:calls[-1] -ne 'shortcut' -or !$output.Contains('INSTALLATION AND VALIDATION PASSED'))){throw 'Successful path omitted validation/shortcut'}
      if(!$shouldPass -and $script:calls.Contains('shortcut')){throw 'Failure refreshed shortcut'}
      if($case -in 'foreign','wrong-sha','bad-legacy-dll','wrong-year','outside-root','bundle-fails','plan-fails','revit-open'){
        if((Get-OperatorBytesSha ([IO.File]::ReadAllBytes($script:addin))) -ne $before){throw "Refusal changed registration: $year/$case"}
      }
      if($case -eq 'update-fails' -and $script:calls.Contains('validate')){throw 'Update failure continued to validation'}
      if($case -in 'legacy','owned'){
        $backups=@(Get-ChildItem -LiteralPath (Join-Path $product 'Logs\InstallRecovery') -Filter RevitBridge.addin.before -File -Recurse)
        if($backups.Count -ne 1 -or (Get-OperatorBytesSha ([IO.File]::ReadAllBytes($backups[0].FullName))) -ne $before){throw 'Missing exact prior-registration backup'}
      }
      $results.Add(@{year=$year;case=$case;passed=$true;calls=@($script:calls);realEngineReceipts=@($script:receipts)})
    }
  }
}finally{$env:LOCALAPPDATA=$priorLocal;$env:APPDATA=$priorRoaming}
$receipt=@{at=[DateTime]::UtcNow.ToString('o');passed=$true;realEngine=[bool]$RealEngine;cases=@($results);scriptSha256=(Get-FileHash -LiteralPath (Join-Path $publicRoot 'scripts\deploy\Install-Operator.ps1')).Hash}
$receipt|ConvertTo-Json -Depth 10|Set-Content -LiteralPath (Join-Path $OutputRoot 'results.json') -Encoding utf8
Write-Host "PASS $($results.Count) cases (real engine: $RealEngine). Retained: $OutputRoot"
