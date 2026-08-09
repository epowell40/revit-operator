[CmdletBinding()]
param(
    [string]$RepositoryRoot = (Split-Path -Parent $PSScriptRoot),
    [Parameter(Mandatory = $true)][string]$OutputRoot,
    [string]$PackageVersion = "0.1.0-lab"
)

$ErrorActionPreference = "Stop"
$repository = [IO.Path]::GetFullPath($RepositoryRoot)
$output = [IO.Path]::GetFullPath($OutputRoot)
$runtimeRoot = Join-Path $repository "apps\dynamic-revit-runtime"
$hostProject = Join-Path $repository "apps\revit-bridge-addin\DynamicRevitHost\DynamicRevitHost.csproj"
$capabilitiesSource = Join-Path $runtimeRoot "manifests\revit-host-capabilities.v1.json"
$sandboxSource = Join-Path $runtimeRoot "manifests\sandbox-policy.v1.json"
$verifierProject = Join-Path $runtimeRoot "DynamicRevit.PackageVerifier\DynamicRevit.PackageVerifier.csproj"

if (Test-Path -LiteralPath $output) { throw "OutputRoot already exists: $output" }
$required = @(
    "C:\Program Files\Autodesk\Revit 2023\RevitAPI.dll",
    "C:\Program Files\Autodesk\Revit 2023\RevitAPIUI.dll",
    "C:\Program Files\Autodesk\Revit 2024\RevitAPI.dll",
    "C:\Program Files\Autodesk\Revit 2024\RevitAPIUI.dll",
    "C:\Program Files\Autodesk\Revit 2025\RevitAPI.dll",
    "C:\Program Files\Autodesk\Revit 2025\RevitAPIUI.dll"
)
$missing = @($required | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) })
if ($missing.Count) { throw "Dynamic Runtime packaging requires installed Revit 2023/2024/2025 API files: $($missing -join ', ')" }

New-Item -ItemType Directory -Path $output | Out-Null
$supervisorOutput = Join-Path $output "supervisor"
$workerOutput = Join-Path $output "worker"
$manifestOutput = Join-Path $output "manifests"
New-Item -ItemType Directory -Path $manifestOutput | Out-Null

dotnet publish (Join-Path $runtimeRoot "DynamicRevitSandboxSupervisor\DynamicRevitSandboxSupervisor.csproj") -c Release -r win-x64 --self-contained false -o $supervisorOutput
if ($LASTEXITCODE) { exit $LASTEXITCODE }
# LPAC cannot depend on the user or machine-wide dotnet host. Ship the bounded worker
# with its exact runtime so the zero-capability process can start without broad reads.
dotnet publish (Join-Path $runtimeRoot "DynamicRevitWorker\DynamicRevitWorker.csproj") -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false -o $workerOutput
if ($LASTEXITCODE) { exit $LASTEXITCODE }

$hostBuilds = @(
    @{ Year = "2023"; Framework = "net48" },
    @{ Year = "2024"; Framework = "net48" },
    @{ Year = "2025"; Framework = "net8.0-windows" }
)
foreach ($hostBuild in $hostBuilds) {
    $apiPath = "C:\Program Files\Autodesk\Revit $($hostBuild.Year)"
    dotnet build $hostProject -c Release -f $hostBuild.Framework -p:RevitYear=$($hostBuild.Year) -p:RevitApiPath=$apiPath
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $source = Join-Path (Split-Path -Parent $hostProject) "bin\Revit$($hostBuild.Year)\Release\$($hostBuild.Framework)\DynamicRevitHost.dll"
    $destination = Join-Path $output "hosts\$($hostBuild.Year)"
    New-Item -ItemType Directory -Path $destination -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination (Join-Path $destination "DynamicRevitHost.dll")
}
Copy-Item -LiteralPath $capabilitiesSource -Destination (Join-Path $manifestOutput "revit-host-capabilities.v1.json")
Copy-Item -LiteralPath $sandboxSource -Destination (Join-Path $manifestOutput "sandbox-policy.v1.json")

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }
function New-Artifact([string]$RelativePath) {
    $native = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    [ordered]@{ relativePath = $RelativePath; sha256 = Get-Sha256 (Join-Path $output $native) }
}
function New-DirectoryIdentity([string]$RelativePath) {
    $native = $RelativePath.Replace('/', [IO.Path]::DirectorySeparatorChar)
    $hashOutput = @(dotnet run --project $verifierProject -c Release -- --directory-hash (Join-Path $output $native))
    if ($LASTEXITCODE) { exit $LASTEXITCODE }
    $hash = @($hashOutput | Where-Object { $_ -match '^sha256:[0-9a-f]{64}$' } | Select-Object -Last 1)
    if ($hash.Count -ne 1) { throw "Directory identity hash was not produced for $RelativePath." }
    [ordered]@{ relativePath = $RelativePath; sha256 = $hash[0] }
}

$sdkHashOutput = @(dotnet run --project $verifierProject -c Release -- --sdk-manifest-hash)
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$sdkManifestHashes = @($sdkHashOutput | Where-Object { $_ -match '^sha256:[0-9a-f]{64}$' })
if ($sdkManifestHashes.Count -ne 1) { throw "Trusted SDK manifest identity was not produced exactly once." }
$sdkManifestHash = $sdkManifestHashes[0]
$packageManifest = [ordered]@{
    schema = "dynamic-revit-runtime-package/v1"
    packageVersion = $PackageVersion
    protocolVersion = "dynamic-revit-protocol/v1"
    sdkManifestHash = $sdkManifestHash
    supervisor = New-DirectoryIdentity "supervisor"
    worker = New-DirectoryIdentity "worker"
    sdk = New-Artifact "worker/DynamicRevitSdk.dll"
    sandboxPolicy = New-Artifact "manifests/sandbox-policy.v1.json"
    sandboxProfile = "windows-lpac-v1-zero-capabilities"
    sandboxProfileVersion = "1.0.0"
    hostCapabilitiesManifestSha256 = Get-Sha256 (Join-Path $manifestOutput "revit-host-capabilities.v1.json")
    hosts = @($hostBuilds | ForEach-Object {
        [ordered]@{ revitYear = $_.Year; targetFramework = $_.Framework; artifact = New-Artifact "hosts/$($_.Year)/DynamicRevitHost.dll" }
    })
}
$packageManifestPath = Join-Path $output "dynamic-revit-runtime-package.v1.json"
$packageManifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $packageManifestPath -Encoding utf8NoBOM

dotnet run --project $verifierProject -c Release -- --verify $output $packageManifestPath $capabilitiesSource
if ($LASTEXITCODE) { exit $LASTEXITCODE }
Write-Output $packageManifestPath
