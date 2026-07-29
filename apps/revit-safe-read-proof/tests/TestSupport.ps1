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

function Get-ProofFrameworkDefinitions {
    param([Parameter(Mandatory = $true)][string]$Year)
    if ($Year -in @('2023', '2024')) {
        return ,([ordered]@{
            name = '.NETFramework'
            version = '4.8'
            targetFramework = 'net48'
            referenceRoot = 'C:\Program Files (x86)\Reference Assemblies\Microsoft\Framework\.NETFramework\v4.8'
        })
    }
    return @(
        [ordered]@{
            name = 'Microsoft.NETCore.App.Ref'
            version = '8.0.19'
            targetFramework = 'net8.0-windows'
            referenceRoot = 'C:\Program Files\dotnet\packs\Microsoft.NETCore.App.Ref\8.0.19\ref\net8.0'
        },
        [ordered]@{
            name = 'Microsoft.WindowsDesktop.App.Ref'
            version = '8.0.19'
            targetFramework = 'net8.0-windows'
            referenceRoot = 'C:\Program Files\dotnet\packs\Microsoft.WindowsDesktop.App.Ref\8.0.19\ref\net8.0'
        }
    )
}

function New-ProofFrameworkLock {
    param([Parameter(Mandatory = $true)]$Definition)
    $root = [string]$Definition.referenceRoot
    $files = [System.Collections.Generic.List[object]]::new()
    $inventory = [System.Collections.Generic.List[string]]::new()
    foreach ($file in Get-ChildItem -LiteralPath $root -Filter '*.dll' -File -Recurse | Sort-Object FullName) {
        try { [void][System.Reflection.AssemblyName]::GetAssemblyName($file.FullName) } catch { continue }
        $relative = [System.IO.Path]::GetRelativePath($root, $file.FullName).Replace('\', '/')
        $sha = Get-ProofSha256 $file.FullName
        $identity = Get-ProofAssemblyIdentity $file.FullName
        $files.Add([ordered]@{ path = $relative; sha256 = $sha; identity = $identity })
        $inventory.Add($relative + '|sha256=' + $sha + '|identity=' + $identity)
    }
    $lines = $inventory.ToArray()
    [System.Array]::Sort($lines, [System.StringComparer]::Ordinal)
    return [ordered]@{
        name = [string]$Definition.name
        version = [string]$Definition.version
        targetFramework = [string]$Definition.targetFramework
        referenceRoot = $root
        inventorySha256 = Get-ProofTextSha256 ([string]::Join("`n", $lines))
        files = $files
    }
}

function New-ProofFrameworkResponse {
    param(
        [Parameter(Mandatory = $true)][string]$Year,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($definition in @(Get-ProofFrameworkDefinitions $Year)) {
        foreach ($file in Get-ChildItem -LiteralPath ([string]$definition.referenceRoot) -Filter '*.dll' -File -Recurse | Sort-Object FullName) {
            try { [void][System.Reflection.AssemblyName]::GetAssemblyName($file.FullName) } catch { continue }
            $lines.Add('/reference:"' + $file.FullName + '"')
        }
    }
    Write-ProofUtf8 $Path ([string]::Join("`n", $lines) + "`n")
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
    $ui = Join-Path $FixtureRoot 'references\RevitApiUi.cs'
    foreach ($year in @('2023', '2024', '2025')) {
        $yearRoot = Join-Path $OutputRoot $year
        [System.IO.Directory]::CreateDirectory($yearRoot) | Out-Null
        $targetFrameworkResponse = Join-Path $yearRoot 'framework.rsp'
        New-ProofFrameworkResponse -Year $year -Path $targetFrameworkResponse
        $output = Join-Path $yearRoot 'RevitAPI.dll'
        $assemblyInfo = Join-Path $FixtureRoot ("references\AssemblyInfo$year.cs")
        Invoke-ProofDirectCompile -CompilerPath $CompilerPath -FrameworkResponsePath $targetFrameworkResponse -OutputPath $output -SourcePaths @($common, $assemblyInfo)
        $uiOutput = Join-Path $yearRoot 'RevitAPIUI.dll'
        Invoke-ProofDirectCompile -CompilerPath $CompilerPath -FrameworkResponsePath $targetFrameworkResponse -OutputPath $uiOutput -SourcePaths @($ui, $assemblyInfo) -AdditionalReferences @($output)
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
        [string]$ExpectedPath = '',
        [string[]]$CompileFiles = @('CertifiedKernel.cs'),
        [switch]$UseInstalledRevit
    )
    $bootstrapLock = Get-Content -LiteralPath (Join-Path $ProofRoot 'bootstrap.lock.json') -Raw | ConvertFrom-Json
    $policy = Get-Content -LiteralPath (Join-Path $ProofRoot 'fixtures\positive\execution-policy.json') -Raw | ConvertFrom-Json
    $certifiedIdentity = 'RevitOperator.SafeReadCertifiedExecution, Version=0.0.0.0, Culture=neutral, PublicKeyToken=null'
    $policy.entryPointMethod = "Method:global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel.Execute(global::Autodesk.Revit.DB.Document document)|assembly=$certifiedIdentity"
    $policy.publicAbi = @(
        "PUBLIC_MEMBER|Method:bool global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Succeeded.get|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Method:global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel.Execute(global::Autodesk.Revit.DB.Document document)|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Method:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Count.get|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Method:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.FailureCode.get|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Property:bool global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Succeeded { get; }|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Property:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.Count { get; }|assembly=$certifiedIdentity",
        "PUBLIC_MEMBER|Property:int global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult.FailureCode { get; }|assembly=$certifiedIdentity",
        "PUBLIC_TYPE|NamedType:class global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountKernel|assembly=$certifiedIdentity",
        "PUBLIC_TYPE|NamedType:class global::RevitOperator.SafeReadCertifiedExecution.CertifiedSheetCountResult|assembly=$certifiedIdentity"
    )
    $policy.allowedAttributeSymbols = @(
        'NamedType:class global::System.Reflection.AssemblyMetadataAttribute|assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089',
        'NamedType:class global::System.Runtime.Versioning.TargetFrameworkAttribute|assembly=mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089',
        'NamedType:class global::System.Reflection.AssemblyMetadataAttribute|assembly=System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a',
        'NamedType:class global::System.Runtime.Versioning.TargetFrameworkAttribute|assembly=System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
    )
    $sensitive = [System.Collections.Generic.List[string]]::new()
    foreach ($year in @('2023', '2024', '2025')) {
        $revitDirectory = if ($UseInstalledRevit) { "C:\Program Files\Autodesk\Revit $year" } else { Join-Path $ReferenceRoot $year }
        $apiIdentity = Get-ProofAssemblyIdentity (Join-Path $revitDirectory 'RevitAPI.dll')
        foreach ($id in @(
            "Property:bool global::Autodesk.Revit.DB.APIObject.IsValidObject { get; }|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.APIObject.IsValidObject.get|assembly=$apiIdentity",
            "Property:bool global::Autodesk.Revit.DB.Document.IsValidObject { get; }|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.Document.IsValidObject.get|assembly=$apiIdentity",
            "Property:bool global::Autodesk.Revit.DB.Document.IsModifiable { get; }|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.Document.IsModifiable.get|assembly=$apiIdentity",
            "Property:bool global::Autodesk.Revit.DB.Document.IsModified { get; }|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.Document.IsModified.get|assembly=$apiIdentity",
            "Method:global::Autodesk.Revit.DB.FilteredElementCollector global::Autodesk.Revit.DB.FilteredElementCollector.OfClass(global::System.Type type)|assembly=$apiIdentity",
            "Method:global::Autodesk.Revit.DB.FilteredElementIterator global::Autodesk.Revit.DB.FilteredElementCollector.GetElementIterator()|assembly=$apiIdentity",
            "Method:global::Autodesk.Revit.DB.FilteredElementCollector.FilteredElementCollector(global::Autodesk.Revit.DB.Document document)|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.FilteredElementIterator.MoveNext()|assembly=$apiIdentity",
            "Property:global::Autodesk.Revit.DB.Element global::Autodesk.Revit.DB.FilteredElementIterator.Current { get; }|assembly=$apiIdentity",
            "Method:global::Autodesk.Revit.DB.Element global::Autodesk.Revit.DB.FilteredElementIterator.Current.get|assembly=$apiIdentity",
            "Property:bool global::Autodesk.Revit.DB.ViewSheet.IsPlaceholder { get; }|assembly=$apiIdentity",
            "Method:bool global::Autodesk.Revit.DB.ViewSheet.IsPlaceholder.get|assembly=$apiIdentity",
            "Method:void global::Autodesk.Revit.DB.APIObject.Dispose()|assembly=$apiIdentity",
            "NamedType:class global::Autodesk.Revit.DB.ViewSheet|assembly=$apiIdentity"
        )) { $sensitive.Add($id) }
    }
    foreach ($runtimeIdentity in @(
        'mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089',
        'System.Runtime, Version=8.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
    )) {
        $sensitive.Add("Method:void global::System.IDisposable.Dispose()|assembly=$runtimeIdentity")
    }
    $policy.allowedSensitiveSymbols = $sensitive.ToArray()
    $sdkPath = [string]$bootstrapLock.sdkPath
    $dotnetRoot = Split-Path -Parent (Split-Path -Parent $sdkPath)
    $compilerPath = Join-Path $sdkPath $bootstrapLock.compiler.relativePath
    $codeAnalysisPath = Join-Path $sdkPath $bootstrapLock.codeAnalysis.relativePath
    $codeAnalysisCSharpPath = Join-Path $sdkPath $bootstrapLock.codeAnalysisCSharp.relativePath

    $sourceFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($relativeInput in $CompileFiles) {
        $file = Get-Item -LiteralPath (Join-Path $SourceRoot $relativeInput)
        $relative = [System.IO.Path]::GetRelativePath($SourceRoot, $file.FullName).Replace('\', '/')
        $sourceFiles.Add([ordered]@{
            path = $relative
            sha256 = Get-ProofTextSha256 ((Get-Content -LiteralPath $file.FullName -Raw).Replace("`r`n", "`n").Replace("`r", "`n"))
        })
    }

    $variants = [System.Collections.Generic.List[object]]::new()
    foreach ($year in @('2023', '2024', '2025')) {
        $revitDirectory = if ($UseInstalledRevit) { "C:\Program Files\Autodesk\Revit $year" } else { Join-Path $ReferenceRoot $year }
        $revitPath = Join-Path $revitDirectory 'RevitAPI.dll'
        $frameworks = @((Get-ProofFrameworkDefinitions $year) | ForEach-Object { [pscustomobject](New-ProofFrameworkLock $_) })
        $variants.Add([ordered]@{
            revitYear = $year
            targetFramework = if ($year -in @('2023', '2024')) { 'net48' } else { 'net8.0-windows' }
            platform = 'x64'
            preprocessorSymbols = @("REVIT$year")
            frameworks = $frameworks
            revitReferences = @((New-ProofAssemblyLock $revitPath))
        })
    }

    $expected = if ([string]::IsNullOrEmpty($ExpectedPath)) {
        $null
    } else {
        Get-Content -LiteralPath $ExpectedPath -Raw | ConvertFrom-Json
    }

    $manifest = [ordered]@{
        schemaVersion = 1
        proofKind = 'revit-safe-read-certified-kernel/v1'
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
        source = [ordered]@{
            root = [System.IO.Path]::GetFullPath($SourceRoot)
            assemblyName = 'RevitOperator.SafeReadCertifiedExecution'
            textNormalization = 'utf8-lf'
            files = $sourceFiles
            resources = @()
        }
        variants = $variants
        policy = $policy
        expected = $expected
    }
    Write-ProofUtf8 $ManifestPath (($manifest | ConvertTo-Json -Depth 100) + "`n")
}
