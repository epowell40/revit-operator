. "$PSScriptRoot/Common.ps1"
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('operator-opencore-test-'+[Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $testRoot | Out-Null
$checks=0
try {
    $keyFile=Join-Path $testRoot 'settings.txt'
    foreach($invalid in @('OPENAI_API_KEY=PASTE_YOUR_KEY_HERE',"OPENAI_API_KEY=short",'Write-Host hacked',"OPENAI_API_KEY=synthetic-test-key-1234567890`nOTHER=bad")) {
        Set-Content -LiteralPath $keyFile $invalid
        $rejected=$false;try{Read-OpenCoreKey $keyFile | Out-Null}catch{$rejected=$true}
        if(!$rejected){throw 'Invalid settings accepted'};$checks++
    }
    Set-Content -LiteralPath $keyFile 'OPENAI_API_KEY=synthetic-test-key-1234567890'
    if((Read-OpenCoreKey $keyFile) -ne 'synthetic-test-key-1234567890'){throw 'Key parser changed value'};$checks++
    [xml]$xml=Get-ManifestText 'C:\A & B\RevitBridge.dll'
    if($xml.RevitAddIns.AddIn.Assembly -ne 'C:\A & B\RevitBridge.dll'){throw 'Manifest path escaping failed'};$checks++
    $file=Join-Path $testRoot 'atomic.txt'
    Write-OpenCoreText $file 'first';Write-OpenCoreText $file 'second'
    if([IO.File]::ReadAllText($file) -ne 'second' -or @(Get-ChildItem $testRoot -Filter '*.tmp').Count){throw 'Atomic replacement failed'};$checks++
    Write-Host "$checks Open Core setup checks passed. No add-in registration or runtime changed."
} finally {
    $resolved=[IO.Path]::GetFullPath($testRoot)
    if(!$resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -or !(Split-Path $resolved -Leaf).StartsWith('operator-opencore-test-')){throw 'Unsafe test cleanup path'}
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
