[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$OutputRoot,

    [switch]$Check
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-Equal {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )
    if ($Expected -cne $Actual) {
        throw "$Name mismatch. Expected '$Expected'; actual '$Actual'."
    }
}

function Quote-Rsp {
    param([Parameter(Mandatory = $true)][string]$Value)
    return '"' + $Value.Replace('"', '\"') + '"'
}

$scriptRoot = Split-Path -Parent $PSCommandPath
$outputFull = [System.IO.Path]::GetFullPath($OutputRoot)
if ([string]::IsNullOrWhiteSpace($outputFull)) {
    throw 'OutputRoot must resolve to a non-empty path.'
}

$lockPath = Join-Path $scriptRoot 'bootstrap.lock.json'
$lock = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
Assert-Equal 'bootstrap schema' 1 ([int]$lock.schemaVersion)

$dotnetRoot = Split-Path -Parent (Split-Path -Parent $lock.sdkPath)
$compilerPath = Join-Path $lock.sdkPath $lock.compiler.relativePath
$codeAnalysisPath = Join-Path $lock.sdkPath $lock.codeAnalysis.relativePath
$codeAnalysisCSharpPath = Join-Path $lock.sdkPath $lock.codeAnalysisCSharp.relativePath
$frameworkRoot = Join-Path $dotnetRoot $lock.framework.relativePath

foreach ($lockedFile in @(
        @($compilerPath, $lock.compiler),
        @($codeAnalysisPath, $lock.codeAnalysis),
        @($codeAnalysisCSharpPath, $lock.codeAnalysisCSharp))) {
    $path = [string]$lockedFile[0]
    $entry = $lockedFile[1]
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Locked bootstrap file is missing: $path"
    }
    Assert-Equal "SHA-256 for $path" ([string]$entry.sha256) (Get-Sha256 $path)
    Assert-Equal "file version for $path" ([string]$entry.fileVersion) ([System.Diagnostics.FileVersionInfo]::GetVersionInfo($path).FileVersion)
}

$referenceFiles = @(Get-ChildItem -LiteralPath $frameworkRoot -Filter '*.dll' -File | Sort-Object Name)
Assert-Equal 'framework DLL count' ([int]$lock.framework.dllCount) $referenceFiles.Count
$frameworkLines = @($referenceFiles | ForEach-Object { $_.Name + ':' + (Get-Sha256 $_.FullName) })
$frameworkText = [string]::Join("`n", $frameworkLines)
$frameworkBytes = [System.Text.Encoding]::UTF8.GetBytes($frameworkText)
$frameworkHash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($frameworkBytes)).ToLowerInvariant()
Assert-Equal 'framework inventory SHA-256' ([string]$lock.framework.inventorySha256) $frameworkHash

if ($Check) {
    if (Test-Path -LiteralPath $outputFull) {
        $existing = @(Get-ChildItem -LiteralPath $outputFull -Force)
        if ($existing.Count -ne 0) {
            throw "Check mode requires an empty caller-owned OutputRoot: $outputFull"
        }
    }
}

[System.IO.Directory]::CreateDirectory($outputFull) | Out-Null
$toolRoot = Join-Path $outputFull 'tool'
[System.IO.Directory]::CreateDirectory($toolRoot) | Out-Null

$refsRspPath = Join-Path $outputFull 'framework.references.rsp'
$compileRspPath = Join-Path $outputFull 'proof-tool.compile.rsp'
$toolDllPath = Join-Path $toolRoot 'RevitSafeReadProof.dll'

$referenceLines = [System.Collections.Generic.List[string]]::new()
foreach ($referenceFile in $referenceFiles) {
    $referenceLines.Add('/reference:' + (Quote-Rsp $referenceFile.FullName))
}
$referenceLines.Add('/reference:' + (Quote-Rsp $codeAnalysisPath))
$referenceLines.Add('/reference:' + (Quote-Rsp $codeAnalysisCSharpPath))
[System.IO.File]::WriteAllLines($refsRspPath, $referenceLines, [System.Text.UTF8Encoding]::new($false))

$sourceFiles = @(Get-ChildItem -LiteralPath (Join-Path $scriptRoot 'src') -Filter '*.cs' -File | Sort-Object Name)
if ($sourceFiles.Count -eq 0) {
    throw 'No proof-tool sources were found.'
}

$compileLines = [System.Collections.Generic.List[string]]::new()
foreach ($line in @(
        '/nostdlib+',
        '/deterministic+',
        '/optimize+',
        '/checked+',
        '/unsafe-',
        '/warn:9999',
        '/warnaserror+',
        '/nullable:enable',
        '/langversion:13.0',
        '/target:exe',
        '/debug-',
        '/utf8output',
        '/fullpaths',
        '/errorendlocation',
        ('/out:' + (Quote-Rsp $toolDllPath)),
        ('@' + (Quote-Rsp $refsRspPath)))) {
    $compileLines.Add($line)
}
foreach ($sourceFile in $sourceFiles) {
    $compileLines.Add((Quote-Rsp $sourceFile.FullName))
}
[System.IO.File]::WriteAllLines($compileRspPath, $compileLines, [System.Text.UTF8Encoding]::new($false))

$dotnetExe = Join-Path $dotnetRoot 'dotnet.exe'
& $dotnetExe $compilerPath '/noconfig' "@$compileRspPath"
if ($LASTEXITCODE -ne 0) {
    throw "Direct csc bootstrap failed with exit code $LASTEXITCODE."
}

Copy-Item -LiteralPath $codeAnalysisPath -Destination (Join-Path $toolRoot 'Microsoft.CodeAnalysis.dll')
Copy-Item -LiteralPath $codeAnalysisCSharpPath -Destination (Join-Path $toolRoot 'Microsoft.CodeAnalysis.CSharp.dll')

$runtimeConfig = [ordered]@{
    runtimeOptions = [ordered]@{
        tfm = [string]$lock.framework.targetFramework
        framework = [ordered]@{
            name = [string]$lock.runtime.frameworkName
            version = [string]$lock.runtime.frameworkVersion
        }
        rollForward = 'Disable'
    }
}
$runtimeConfigPath = Join-Path $toolRoot 'RevitSafeReadProof.runtimeconfig.json'
$runtimeConfig | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $runtimeConfigPath -Encoding utf8NoBOM

$receipt = [ordered]@{
    schemaVersion = 1
    mode = $(if ($Check) { 'check' } else { 'build' })
    certifiedOutput = $false
    reason = 'This bootstraps the verifier directly; only verifier receipts certify candidate host output.'
    sdkVersion = [string]$lock.sdkVersion
    compilerSha256 = Get-Sha256 $compilerPath
    frameworkInventorySha256 = $frameworkHash
    frameworkResponseSha256 = Get-Sha256 $refsRspPath
    compilerResponseSha256 = Get-Sha256 $compileRspPath
    proofToolSha256 = Get-Sha256 $toolDllPath
    outputRoot = $outputFull
}
$bootstrapReceiptPath = Join-Path $outputFull 'bootstrap.receipt.json'
$receipt | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $bootstrapReceiptPath -Encoding utf8NoBOM

[pscustomobject]@{
    Tool = $toolDllPath
    RuntimeConfig = $runtimeConfigPath
    Receipt = $bootstrapReceiptPath
    CompilerResponse = $compileRspPath
    FrameworkResponse = $refsRspPath
}
