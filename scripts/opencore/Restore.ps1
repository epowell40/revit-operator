. "$PSScriptRoot/Common.ps1"
Assert-ClosedRevit
$receiptPath=Join-Path $OpenCoreState 'install.json'
if(!(Test-Path -LiteralPath $receiptPath)){Write-Host 'No Open Core registration to restore.';return}
$install=Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if(!(Test-Path -LiteralPath $install.manifest) -or (Get-FileHash -LiteralPath $install.manifest).Hash -ne $install.manifestSha256){throw 'The add-in registration changed after setup. Leaving it untouched.'}
if($install.previousManifestBase64){[IO.File]::WriteAllBytes($install.manifest,[Convert]::FromBase64String($install.previousManifestBase64))}
else {Remove-Item -LiteralPath $install.manifest}
Move-Item -LiteralPath $receiptPath -Destination (Join-Path $OpenCoreState ('restored-'+(Get-Date -Format 'yyyyMMddHHmmss')+'.json'))
Write-Host 'Previous add-in registration restored. Saved work and configuration are retained.'
