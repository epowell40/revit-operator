Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
# Revit can inherit a PowerShell 7 module path. Its ribbon launches Windows
# PowerShell; resolve that host's built-in modules before inherited modules.
$nativeModules = Join-Path $PSHOME 'Modules'
$env:PSModulePath = $nativeModules + [IO.Path]::PathSeparator + $env:PSModulePath
$OpenCoreRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$OpenCoreState = Join-Path $OpenCoreRoot '.opencore'
$OpenCoreSettings = Join-Path $OpenCoreRoot 'OpenCore.settings.txt'

function Read-OpenCoreKey([string]$Path = $OpenCoreSettings) {
    if (!(Test-Path -LiteralPath $Path)) { throw 'Run Setup-OpenCore.cmd first, then add your API key to OpenCore.settings.txt.' }
    $entries = @(Get-Content -LiteralPath $Path | Where-Object { $_.Trim() -and !$_.Trim().StartsWith('#') })
    if ($entries.Count -ne 1 -or $entries[0] -notmatch '^\s*OPENAI_API_KEY\s*=\s*(\S+)\s*$') {
        throw 'OpenCore.settings.txt must contain one OPENAI_API_KEY=your-key line. It is configuration, not a PowerShell script.'
    }
    $value = $Matches[1]
    if ($value -eq 'PASTE_YOUR_KEY_HERE' -or $value.Length -lt 20) { throw 'Add your OpenAI API key to OpenCore.settings.txt, save it, then run Start-OpenCore.cmd again.' }
    return $value
}

function Assert-ClosedRevit {
    if (Get-Process -Name Revit -ErrorAction SilentlyContinue) { throw 'Close Revit first so the add-in and local connection can be selected safely. Your open model has not been changed.' }
}

function Assert-OpenCoreProcess($Runtime) {
    $process=Get-CimInstance Win32_Process -Filter "ProcessId=$($Runtime.pid)"
    if(!$process -or [IO.Path]::GetFullPath($process.ExecutablePath) -ne [IO.Path]::GetFullPath($Runtime.node) -or
      ([DateTimeOffset]$process.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() -ne ([DateTimeOffset]$Runtime.started).ToUnixTimeMilliseconds() -or
      !$process.CommandLine.Contains($Runtime.entry)) {
        throw 'The process does not match this installation. Nothing was started or stopped.'
    }
    return $process
}

function Invoke-Checked([string]$File, [string[]]$Arguments) {
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed (exit $LASTEXITCODE). Correct the reported error and run setup again." }
}

function Get-OpenCoreNode {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if (!$command) { throw 'Install Node.js 22.23.4 or newer supported LTS from https://nodejs.org/en/download, reopen this folder, then run setup again.' }
    $node = [IO.Path]::GetFullPath($command.Source)
    $v = [version]((& $node -p 'process.versions.node').Trim())
    if (!(($v.Major -eq 22 -and $v -ge [version]'22.23.4') -or ($v.Major -eq 24 -and $v -ge [version]'24.22.1') -or ($v.Major -eq 26 -and $v -ge [version]'26.12.1'))) {
        throw "Node $v is unsupported. Install a supported Node LTS (22.23.4+ or 24.22.1+) and reopen this folder. No global settings were changed."
    }
    return $node
}

function Write-PrivateSettings {
    if (Test-Path -LiteralPath $OpenCoreSettings) { return }
    @('# Keep this file private. API usage is billed to your OpenAI account.', '# Paste the key after the equals sign; do not add quotes.', 'OPENAI_API_KEY=PASTE_YOUR_KEY_HERE') | Set-Content -LiteralPath $OpenCoreSettings -Encoding UTF8
    $acl = New-Object Security.AccessControl.FileSecurity
    $acl.SetAccessRuleProtection($true, $false)
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','Allow')))
    Set-Acl -LiteralPath $OpenCoreSettings -AclObject $acl
}

function Get-ManifestText([string]$Assembly) {
    $escaped = [Security.SecurityElement]::Escape($Assembly)
    return @"
<?xml version="1.0" encoding="utf-8"?>
<RevitAddIns><AddIn Type="Application"><Name>RevitOperator</Name><Assembly>$escaped</Assembly><FullClassName>RevitBridge.App</FullClassName><AddInId>B2883307-2852-4740-9833-281048674F77</AddInId><VendorId>com.revitoperator</VendorId><VendorDescription>BIMTools Revit Operator Open Core</VendorDescription></AddIn></RevitAddIns>
"@
}

function Write-OpenCoreText([string]$Path, [string]$Text) {
    $temporary = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temporary,$Text,(New-Object Text.UTF8Encoding($false)))
        if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary,$Path,[NullString]::Value) }
        else { [IO.File]::Move($temporary,$Path) }
    } finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary} }
}

function Assert-OpenCoreRuntime($Receipt,[string]$ExpectedRoot) {
    $root=[IO.Path]::GetFullPath($ExpectedRoot).TrimEnd([char[]]@('\','/'))
    if([IO.Path]::GetFullPath($Receipt.root) -ne $root){throw 'Runtime receipt belongs to another installation.'}
    $files=@(Get-ChildItem -LiteralPath $root -Recurse -File)
    if(!$Receipt.files.Count -or $files.Count -ne $Receipt.files.Count){throw 'Runtime file inventory changed. Run setup again.'}
    $seen=@{}
    foreach($entry in $Receipt.files){
        $path=[IO.Path]::GetFullPath((Join-Path $root $entry.relative))
        if(!$path.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase) -or $seen.ContainsKey($path)){throw 'Runtime receipt contains an invalid path.'}
        $seen[$path]=$true
        if((Get-FileHash -LiteralPath $path).Hash -ne $entry.sha256){throw 'Runtime content changed. Run setup again.'}
    }
    foreach($relative in @('supervisor/DynamicRevitSandboxSupervisor.exe','worker/DynamicRevitWorker.exe')){
        if(!(Test-Path -LiteralPath (Join-Path $root $relative))){throw 'Generated-code runtime is incomplete. Run setup again.'}
    }
}