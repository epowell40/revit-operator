Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-ProofSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ProofTextSha256 {
    param([Parameter(Mandatory = $true)][string]$Text)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($Text)
    return [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Write-ProofUtf8 {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Text
    )
    $parent = Split-Path -Parent $Path
    if ($parent) {
        [System.IO.Directory]::CreateDirectory($parent) | Out-Null
    }
    [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
}

function Get-ProofAssemblyIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $name = [System.Reflection.AssemblyName]::GetAssemblyName($Path)
    $culture = if ([string]::IsNullOrEmpty($name.CultureName)) { 'neutral' } else { $name.CultureName }
    $tokenBytes = $name.GetPublicKeyToken()
    $token = if ($null -eq $tokenBytes -or $tokenBytes.Length -eq 0) {
        'null'
    } else {
        [Convert]::ToHexString($tokenBytes).ToLowerInvariant()
    }
    return "$($name.Name), Version=$($name.Version), Culture=$culture, PublicKeyToken=$token"
}

function New-ProofAssemblyLock {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [ordered]@{
        path = [System.IO.Path]::GetFullPath($Path)
        sha256 = Get-ProofSha256 $Path
        identity = Get-ProofAssemblyIdentity $Path
    }
}

function Invoke-ProofDirectCompile {
    param(
        [Parameter(Mandatory = $true)][string]$CompilerPath,
        [Parameter(Mandatory = $true)][string]$FrameworkResponsePath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [Parameter(Mandatory = $true)][string[]]$SourcePaths,
        [string[]]$AdditionalReferences = @()
    )
    $responsePath = $OutputPath + '.compile.rsp'
    $lines = [System.Collections.Generic.List[string]]::new()
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
            '/target:library',
            '/debug-',
            '/utf8output',
            ('/out:"' + $OutputPath + '"'),
            ('@"' + $FrameworkResponsePath + '"'))) {
        $lines.Add($line)
    }
    foreach ($reference in $AdditionalReferences) {
        $lines.Add('/reference:"' + $reference + '"')
    }
    foreach ($source in $SourcePaths) {
        $lines.Add('"' + $source + '"')
    }
    Write-ProofUtf8 $responsePath ([string]::Join("`n", $lines) + "`n")
    $dotnet = 'C:\Program Files\dotnet\dotnet.exe'
    & $dotnet $CompilerPath '/noconfig' "@$responsePath"
    if ($LASTEXITCODE -ne 0) {
        throw "Direct fixture compilation failed for $OutputPath with exit code $LASTEXITCODE."
    }
}

function New-ProofFixtureReferences {
    param(
        [Parameter(Mandatory = $true)][string]$FixtureRoot,
        [Parameter(Mandatory = $true)][string]$OutputRoot,
        [Parameter(Mandatory = $true)][string]$CompilerPath,
        [Parameter(Mandatory = $true)][string]$FrameworkResponsePath
    )
    $common = Join-Path $FixtureRoot 'references\RevitApi.cs'
    foreach ($year in @('2023', '2024', '2025')) {
        $yearRoot = Join-Path $OutputRoot $year
        [System.IO.Directory]::CreateDirectory($yearRoot) | Out-Null
        $output = Join-Path $yearRoot 'RevitAPI.dll'
        $assemblyInfo = Join-Path $FixtureRoot ("references\AssemblyInfo$year.cs")
        Invoke-ProofDirectCompile -CompilerPath $CompilerPath -FrameworkResponsePath $FrameworkResponsePath -OutputPath $output -SourcePaths @($common, $assemblyInfo)
    }

    $forwardRoot = Join-Path $OutputRoot 'forwarder'
    [System.IO.Directory]::CreateDirectory($forwardRoot) | Out-Null
    $target = Join-Path $forwardRoot 'ForwardTarget.dll'
    Invoke-ProofDirectCompile -CompilerPath $CompilerPath -FrameworkResponsePath $FrameworkResponsePath -OutputPath $target -SourcePaths @((Join-Path $FixtureRoot 'references\ForwardTarget.cs'))
    $forwarder = Join-Path $forwardRoot 'RevitAPI.dll'
    Invoke-ProofDirectCompile -CompilerPath $CompilerPath -FrameworkResponsePath $FrameworkResponsePath -OutputPath $forwarder -SourcePaths @((Join-Path $FixtureRoot 'references\ForwardingRevitApi.cs')) -AdditionalReferences @($target)
}

function New-ProofFixtureManifest {
    param(
        [Parameter(Mandatory = $true)][string]$ProofRoot,
        [Parameter(Mandatory = $true)][string]$SourceRoot,
        [Parameter(Mandatory = $true)][string]$ReferenceRoot,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [string]$ExpectedPath = ''
    )
    $bootstrapLock = Get-Content -LiteralPath (Join-Path $ProofRoot 'bootstrap.lock.json') -Raw | ConvertFrom-Json
    $policy = Get-Content -LiteralPath (Join-Path $ProofRoot 'fixtures\positive\policy.json') -Raw | ConvertFrom-Json
    $sdkPath = [string]$bootstrapLock.sdkPath
    $dotnetRoot = Split-Path -Parent (Split-Path -Parent $sdkPath)
    $compilerPath = Join-Path $sdkPath $bootstrapLock.compiler.relativePath
    $codeAnalysisPath = Join-Path $sdkPath $bootstrapLock.codeAnalysis.relativePath
    $codeAnalysisCSharpPath = Join-Path $sdkPath $bootstrapLock.codeAnalysisCSharp.relativePath
    $frameworkRoot = Join-Path $dotnetRoot $bootstrapLock.framework.relativePath

    $frameworkFiles = [System.Collections.Generic.List[object]]::new()
    $frameworkInventoryLines = [System.Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $frameworkRoot -Filter '*.dll' -File | Sort-Object Name) {
        $sha = Get-ProofSha256 $file.FullName
        $identity = Get-ProofAssemblyIdentity $file.FullName
        $frameworkFiles.Add([ordered]@{
            path = $file.Name
            sha256 = $sha
            identity = $identity
        })
        $frameworkInventoryLines.Add($file.Name + '|sha256=' + $sha + '|identity=' + $identity)
    }
    $sortedFrameworkInventory = $frameworkInventoryLines.ToArray()
    [System.Array]::Sort($sortedFrameworkInventory, [System.StringComparer]::Ordinal)
    $frameworkInventory = Get-ProofTextSha256 ([string]::Join("`n", $sortedFrameworkInventory))

    $sourceFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $SourceRoot -File -Recurse | Sort-Object FullName) {
        $relative = [System.IO.Path]::GetRelativePath($SourceRoot, $file.FullName).Replace('\', '/')
        $sourceFiles.Add([ordered]@{
            path = $relative
            sha256 = Get-ProofSha256 $file.FullName
        })
    }

    $variants = [System.Collections.Generic.List[object]]::new()
    foreach ($year in @('2023', '2024', '2025')) {
        $revitPath = Join-Path $ReferenceRoot "$year\RevitAPI.dll"
        $variants.Add([ordered]@{
            revitYear = $year
            preprocessorSymbols = @("REVIT$year")
            revitReferences = @(New-ProofAssemblyLock $revitPath)
        })
    }

    $expected = if ([string]::IsNullOrEmpty($ExpectedPath)) {
        $null
    } else {
        Get-Content -LiteralPath $ExpectedPath -Raw | ConvertFrom-Json
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        proofKind = 'revit-safe-read-whole-assembly/v1'
        trustBoundary = 'Trusted local administrator, operating system, installed locked SDK/reference pack, Autodesk Revit, and Revit process; malicious local admin/OS/Revit are excluded.'
        sdk = [ordered]@{
            version = [string]$bootstrapLock.sdkVersion
            sdkPath = $sdkPath
            compilerPath = $compilerPath
            compilerSha256 = Get-ProofSha256 $compilerPath
            compilerFileVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($compilerPath).FileVersion
            codeAnalysisPath = $codeAnalysisPath
            codeAnalysisSha256 = Get-ProofSha256 $codeAnalysisPath
            codeAnalysisCSharpPath = $codeAnalysisCSharpPath
            codeAnalysisCSharpSha256 = Get-ProofSha256 $codeAnalysisCSharpPath
            languageVersion = '13.0'
        }
        framework = [ordered]@{
            name = [string]$bootstrapLock.framework.name
            version = [string]$bootstrapLock.framework.version
            targetFramework = [string]$bootstrapLock.framework.targetFramework
            referenceRoot = $frameworkRoot
            inventorySha256 = $frameworkInventory
            files = $frameworkFiles
        }
        source = [ordered]@{
            root = [System.IO.Path]::GetFullPath($SourceRoot)
            assemblyName = 'RevitSafeReadFixture'
            files = $sourceFiles
            resources = @()
        }
        variants = $variants
        policy = $policy
        expected = $expected
    }
    Write-ProofUtf8 $ManifestPath (($manifest | ConvertTo-Json -Depth 100) + "`n")
}
