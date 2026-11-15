Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
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
    $acl = Get-Acl -LiteralPath $OpenCoreSettings
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
