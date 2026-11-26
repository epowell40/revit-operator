[CmdletBinding()]
param([ValidateSet(2023,2024,2025,2026,2027)][int]$RevitYear, [switch]$NoOpenSettings)
. "$PSScriptRoot/Common.ps1"
Assert-ClosedRevit
if(Get-NetTCPConnection -State Listen -LocalPort 7007,3907 -ErrorAction SilentlyContinue){throw 'Stop Operator with Stop-OpenCore.cmd before setup. Existing processes were not changed.'}
if (!$RevitYear) {
    $years = @(2023..2027 | Where-Object { Test-Path -LiteralPath (Join-Path $env:ProgramFiles "Autodesk/Revit $_/RevitAPI.dll") })
    if (!$years.Count) { throw 'Install a supported Autodesk Revit version (2023-2027) before setting up Operator.' }
    if ($years.Count -eq 1) { $RevitYear = $years[0] }
    else {
        Write-Host "Installed Revit versions: $($years -join ', ')"
        $choice = Read-Host 'Which Revit year should use Open Core?'
        if ($choice -notin @($years | ForEach-Object { "$_" })) { throw 'Choose one of the installed years shown above.' }
        $RevitYear = [int]$choice
    }
}
$node = Get-OpenCoreNode
$npm = Join-Path (Split-Path $node) 'npm.cmd'
if (!(Test-Path -LiteralPath $npm)) { throw 'The Node installation is missing npm.cmd. Repair Node.js, then retry.' }
$dotnetCommand = Get-Command dotnet.exe -ErrorAction SilentlyContinue
if (!$dotnetCommand) { throw 'Install the .NET 8 SDK from https://dotnet.microsoft.com/download/dotnet/8.0, then run setup again. Revit 2027 requires the .NET 10 SDK.' }
$dotnet = $dotnetCommand.Source
$sdks = & $dotnet --list-sdks
$sdkMajor = if ($RevitYear -eq 2027) { 10 } else { 8 }
if (!($sdks | Where-Object { $_ -match '^(\d+)\.' -and [int]$Matches[1] -ge $sdkMajor })) { throw "Install the .NET $sdkMajor SDK or later (not only the runtime), then run setup again." }
$revitDir = Join-Path $env:ProgramFiles "Autodesk/Revit $RevitYear"
if (!(Test-Path -LiteralPath "$revitDir/RevitAPI.dll")) { throw "Revit $RevitYear was not found. Run Setup-OpenCore.cmd -RevitYear 2023 (or your installed year)." }
$manifestDir = Join-Path $env:APPDATA "Autodesk/Revit/Addins/$RevitYear"
$manifest = Join-Path $manifestDir 'RevitBridge.addin'
foreach ($root in @($manifestDir,(Join-Path $env:ProgramData "Autodesk/Revit/Addins/$RevitYear"))) {
    if (Test-Path -LiteralPath $root) {
        foreach ($file in Get-ChildItem -LiteralPath $root -Filter '*.addin' -File) {
            if ($file.FullName -ne $manifest -and (Get-Content -LiteralPath $file.FullName -Raw) -match 'B2883307-2852-4740-9833-281048674F77|RevitBridge\.App') {
                throw "Another Operator registration exists: $($file.FullName). Disable that installation first; setup will not create duplicate add-ins."
            }
        }
    }
}
New-Item -ItemType Directory -Force $OpenCoreState | Out-Null
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$existingAcl=Get-Acl -LiteralPath $OpenCoreState
$rules=@($existingAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
$alreadyPrivate=$existingAcl.AreAccessRulesProtected -and $rules.Count -eq 1 -and
    $rules[0].IdentityReference -eq $sid -and $rules[0].AccessControlType -eq 'Allow' -and
    $rules[0].FileSystemRights -eq 'FullControl' -and $rules[0].InheritanceFlags -eq 'ContainerInherit, ObjectInherit'
if(!$alreadyPrivate){
    $acl=New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true,$false)
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
    Set-Acl -LiteralPath $OpenCoreState -AclObject $acl
}
Write-PrivateSettings
$oldPath = $env:PATH
try {
    $env:PATH = "$(Split-Path $node);$oldPath"
    foreach ($name in @('mcp-server','operator-backend','operator-desktop')) {
        Push-Location (Join-Path $OpenCoreRoot "apps/$name")
        try {
            Invoke-Checked $npm @('ci','--no-audit','--no-fund')
            if($name -ne 'operator-desktop'){Invoke-Checked $npm @('run','build')}
            else {
                Invoke-Checked $node @('--check','server.js')
                Invoke-Checked $dotnet @('build','indicator/OperatorControlIndicator.csproj','-c','Release','--nologo','--verbosity:minimal')
            }
        } finally { Pop-Location }
    }
    # Pin the supported CLI locally; never modify the user's global Codex installation.
    Invoke-Checked $npm @('install','--prefix',(Join-Path $OpenCoreState 'tools'),'--no-audit','--no-fund','--save-exact','@openai/codex@0.157.0')
    $codex = @('tools/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe','tools/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe') | ForEach-Object { Join-Path $OpenCoreState $_ } | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (!$codex) { throw 'The supported Codex Windows executable was not installed. Review the npm error and retry setup.' }
    Invoke-Checked $codex @('--version')
    $framework = if ($RevitYear -le 2024) { 'net48' } elseif ($RevitYear -le 2026) { 'net8.0-windows' } else { 'net10.0-windows' }
    $apiProperty = if ($RevitYear -le 2024) { 'RevitApiPathNet48' } elseif ($RevitYear -le 2026) { 'RevitApiPathNet8' } else { 'RevitApiPathNet10' }
    $project = Join-Path $OpenCoreRoot 'apps/revit-bridge-addin/RevitBridge/RevitBridge.csproj'
    $buildArgs = @('build',$project,'-c','Release','-f',$framework,"-p:RevitYear=$RevitYear","-p:RevitVersion=$RevitYear","-p:$apiProperty=$revitDir",'--nologo','--verbosity:minimal')
    if ($RevitYear -eq 2027) { $buildArgs += @('-p:NuGetLockFilePath=obj/Revit2027/packages.lock.json','-p:RestorePackagesWithLockFile=true') }
    Invoke-Checked $dotnet $buildArgs
    $dll = Join-Path (Split-Path $project) "bin/Release/$framework/win-x64/RevitBridge.dll"
    if (!(Test-Path -LiteralPath $dll)) { throw 'Build finished without the expected RevitBridge.dll; no registration changed.' }
    # Build the sandbox beside this add-in; never borrow another installation.
    $dynamicRoot=Join-Path (Split-Path $dll) 'dynamic-runtime'
    foreach($part in @(@{project='DynamicRevitSandboxSupervisor';folder='supervisor'},@{project='DynamicRevitWorker';folder='worker'})) {
        $runtimeProject=Join-Path $OpenCoreRoot ("apps/dynamic-revit-runtime/{0}/{0}.csproj" -f $part.project)
        Invoke-Checked $dotnet @('publish',$runtimeProject,'-c','Release','-r','win-x64','--self-contained','true','-p:PublishSingleFile=false','-o',(Join-Path $dynamicRoot $part.folder),'--nologo','--verbosity:minimal')
    }
    $runtimeFiles=@(Get-ChildItem -LiteralPath $dynamicRoot -File -Recurse | ForEach-Object {
        @{relative=$_.FullName.Substring($dynamicRoot.Length+1);sha256=(Get-FileHash -LiteralPath $_.FullName).Hash}
    })
    Write-OpenCoreText (Join-Path $OpenCoreState 'dynamic-runtime.json') (@{root=$dynamicRoot;files=$runtimeFiles} | ConvertTo-Json -Depth 5)
    $receiptPath = Join-Path $OpenCoreState 'install.json'
    $previous = if (Test-Path -LiteralPath $receiptPath) { Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json } else { $null }
    if ($previous -and $previous.revitYear -ne $RevitYear) { throw 'Restore the prior Open Core registration before selecting another Revit year.' }
    Assert-ClosedRevit
if(Get-NetTCPConnection -State Listen -LocalPort 7007,3907 -ErrorAction SilentlyContinue){throw 'Stop Operator with Stop-OpenCore.cmd before setup. Existing processes were not changed.'}
    New-Item -ItemType Directory -Force $manifestDir | Out-Null
    $before = if (Test-Path -LiteralPath $manifest) { [Convert]::ToBase64String([IO.File]::ReadAllBytes($manifest)) } else { $null }
    if ($previous -and (Get-FileHash -LiteralPath $manifest).Hash -ne $previous.manifestSha256) { throw 'The registration changed outside this setup. Restore/review it before reinstalling.' }
    $backup = if ($previous) { $previous.previousManifestBase64 } else { $before }
    # Retain recovery bytes before replacing a registration, including if receipt writing fails.
    if (!$previous) { Write-OpenCoreText (Join-Path $OpenCoreState 'previous-registration.json') (@{manifest=$manifest;previousManifestBase64=$backup} | ConvertTo-Json) }
    $text = Get-ManifestText $dll
    Write-OpenCoreText $manifest $text
    try {
        Write-OpenCoreText $receiptPath (@{schema=1;revitYear=$RevitYear;revitExe="$revitDir/Revit.exe";node=$node;codex=$codex;manifest=$manifest;manifestSha256=(Get-FileHash -LiteralPath $manifest).Hash;assembly=$dll;previousManifestBase64=$backup;installed=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json)
    } catch {
        if ([IO.File]::ReadAllText($manifest) -eq $text) {
            if($before){[IO.File]::WriteAllBytes($manifest,[Convert]::FromBase64String($before))}else{Remove-Item -LiteralPath $manifest}
        }
        throw
    }
    Write-Host 'Installed. Add your API key to OpenCore.settings.txt, then double-click Start-OpenCore.cmd.'
    Write-Host 'Keep this extracted folder: the add-in and local backend run from it. Restore-Previous-Install.cmd restores any previous registration.'
    if (!$NoOpenSettings) { Start-Process notepad.exe -ArgumentList ('"'+$OpenCoreSettings+'"') }
} finally { $env:PATH = $oldPath }
