[CmdletBinding()]
param(
    [string]$TempRoot = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$proofRoot = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
. (Join-Path $proofRoot 'tests\TestSupport.ps1')

function Assert-Proof {
    param(
        [Parameter(Mandatory = $true)][bool]$Condition,
        [Parameter(Mandatory = $true)][string]$Message
    )
    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Write-ProofJson {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Value
    )
    Write-ProofUtf8 $Path (($Value | ConvertTo-Json -Depth 100) + "`n")
}

function Invoke-ProofCheck {
    param(
        [Parameter(Mandatory = $true)][string]$ToolPath,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$OutputPath,
        [int]$ExpectedExit = 0,
        [string]$ExpectedCode = ''
    )
    $toolOutput = @(& 'C:\Program Files\dotnet\dotnet.exe' $ToolPath check --manifest $ManifestPath --output-dir $OutputPath 2>&1)
    $actualExit = $LASTEXITCODE
    if ($actualExit -ne $ExpectedExit) {
        $renderedOutput = [string]::Join("`n", @($toolOutput | ForEach-Object { $_.ToString() }))
        throw "ASSERTION FAILED: check exit for $ManifestPath was $actualExit; expected $ExpectedExit.`n$renderedOutput"
    }
    $receiptPath = Join-Path $OutputPath 'proof.receipt.json'
    Assert-Proof (Test-Path -LiteralPath $receiptPath -PathType Leaf) "check did not write a receipt: $receiptPath"
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($ExpectedExit -eq 0) {
        Assert-Proof ([bool]$receipt.certified) 'successful check receipt is not certified'
        Assert-Proof ([string]$receipt.status -eq 'verified') 'successful check receipt status is not verified'
        Assert-Proof (@($receipt.issues).Count -eq 0) 'successful check receipt contains issues'
    } else {
        Assert-Proof (-not [bool]$receipt.certified) 'rejected check receipt claims certification'
        Assert-Proof ([string]$receipt.status -eq 'rejected') 'rejected check receipt has the wrong status'
        if ($ExpectedCode) {
            Assert-Proof (@($receipt.issues.code) -contains $ExpectedCode) "rejected receipt did not contain $ExpectedCode"
        }
    }
    return $receipt
}

$gitBefore = & git -C (Split-Path -Parent (Split-Path -Parent $proofRoot)) status --porcelain=v1 --untracked-files=all

if ([string]::IsNullOrEmpty($TempRoot)) {
    $TempRoot = Join-Path $env:TEMP ('revit-safe-read-proof-tests-' + [guid]::NewGuid().ToString('N'))
}
$TempRoot = [System.IO.Path]::GetFullPath($TempRoot)
if (Test-Path -LiteralPath $TempRoot) {
    Assert-Proof (@(Get-ChildItem -LiteralPath $TempRoot -Force).Count -eq 0) "caller TempRoot must be empty: $TempRoot"
} else {
    [System.IO.Directory]::CreateDirectory($TempRoot) | Out-Null
}

$poisonRoot = Join-Path $TempRoot 'ambient-msbuild-poison'
[System.IO.Directory]::CreateDirectory($poisonRoot) | Out-Null
Write-ProofUtf8 (Join-Path $poisonRoot 'Directory.Build.props') @'
<Project>
  <PropertyGroup>
    <DefineConstants>PROOF_AMBIENT_INJECTION</DefineConstants>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="Injected.cs" />
  </ItemGroup>
</Project>
'@
Write-ProofUtf8 (Join-Path $poisonRoot 'Directory.Build.targets') @'
<Project>
  <Target Name="Poison" BeforeTargets="CoreCompile">
    <Error Text="Ambient Directory.Build.targets was evaluated." />
  </Target>
</Project>
'@
Write-ProofUtf8 (Join-Path $poisonRoot 'Injected.cs') 'this is intentionally invalid C# and must never be compiled'

$bootstrapRoot = Join-Path $TempRoot 'bootstrap'
Push-Location $poisonRoot
try {
    & (Join-Path $proofRoot 'bootstrap.ps1') -Check -OutputRoot $bootstrapRoot | Out-Null
} finally {
    Pop-Location
}
$toolPath = Join-Path $bootstrapRoot 'tool\RevitSafeReadProof.dll'
Assert-Proof (Test-Path -LiteralPath $toolPath -PathType Leaf) 'direct-csc bootstrap did not produce the proof tool'
$compilerResponseText = Get-Content -LiteralPath (Join-Path $bootstrapRoot 'proof-tool.compile.rsp') -Raw
Assert-Proof ($compilerResponseText.Contains('/nostdlib+')) 'bootstrap response omitted /nostdlib+'
Assert-Proof ($compilerResponseText.Contains('/deterministic+')) 'bootstrap response omitted /deterministic+'
Assert-Proof (-not $compilerResponseText.Contains('Injected.cs')) 'ambient Compile item entered bootstrap response'

$bootstrapLock = Get-Content -LiteralPath (Join-Path $proofRoot 'bootstrap.lock.json') -Raw | ConvertFrom-Json
$compilerPath = Join-Path $bootstrapLock.sdkPath $bootstrapLock.compiler.relativePath
$frameworkResponse = Join-Path $bootstrapRoot 'framework.references.rsp'
$referenceRoot = Join-Path $TempRoot 'fixture-references'
Push-Location $poisonRoot
try {
    New-ProofFixtureReferences -FixtureRoot (Join-Path $proofRoot 'fixtures') -OutputRoot $referenceRoot -CompilerPath $compilerPath -FrameworkResponsePath $frameworkResponse
} finally {
    Pop-Location
}

$expectedPath = Join-Path $proofRoot 'fixtures\positive\expected.compact.json'
$positiveSource = Join-Path $TempRoot 'positive-source'
[System.IO.Directory]::CreateDirectory($positiveSource) | Out-Null
Copy-Item -LiteralPath (Join-Path $proofRoot 'fixtures\positive\source\CertifiedKernel.cs') -Destination (Join-Path $positiveSource 'CertifiedKernel.cs')
$crlfSourceText = (Get-Content -LiteralPath (Join-Path $positiveSource 'CertifiedKernel.cs') -Raw).Replace("`r`n", "`n").Replace("`r", "`n").Replace("`n", "`r`n")
Write-ProofUtf8 (Join-Path $positiveSource 'CertifiedKernel.cs') $crlfSourceText
$positiveManifest = Join-Path $TempRoot 'positive.manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $positiveManifest -ExpectedPath $expectedPath

$positiveOne = Join-Path $TempRoot 'positive-check-one'
$positiveTwo = Join-Path $TempRoot 'positive-check-two'
$receiptOne = Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $positiveManifest -OutputPath $positiveOne
$rawSourceHash = Get-ProofSha256 (Join-Path $positiveSource 'CertifiedKernel.cs')
$lfSourceText = (Get-Content -LiteralPath (Join-Path $positiveSource 'CertifiedKernel.cs') -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
Write-ProofUtf8 (Join-Path $positiveSource 'CertifiedKernel.cs') $lfSourceText
Assert-Proof ($rawSourceHash -ne (Get-ProofSha256 (Join-Path $positiveSource 'CertifiedKernel.cs'))) 'line-ending determinism falsifier did not change raw source bytes'
$receiptTwo = Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $positiveManifest -OutputPath $positiveTwo
foreach ($year in @('2023', '2024', '2025')) {
    $fileName = "RevitOperator.SafeReadCertifiedExecution.Revit$year.dll"
    Assert-Proof ((Get-ProofSha256 (Join-Path $positiveOne $fileName)) -eq (Get-ProofSha256 (Join-Path $positiveTwo $fileName))) "deterministic output differs for Revit $year"
    $artifactReceipt = $receiptOne.artifacts.$year
    Assert-Proof ([string]$artifactReceipt.fileName -eq $fileName) "artifact receipt filename differs for Revit $year"
    Assert-Proof ([string]$artifactReceipt.platform -eq 'x64') "artifact receipt platform differs for Revit $year"
    $expectedTargetFramework = if ($year -in @('2023', '2024')) { '.NETFramework,Version=v4.8' } else { '.NETCoreApp,Version=v8.0' }
    Assert-Proof ([string]$artifactReceipt.targetFramework -eq $expectedTargetFramework) "artifact receipt target framework differs for Revit $year"
    Assert-Proof ([string]$artifactReceipt.assemblyIdentity -like 'RevitOperator.SafeReadCertifiedExecution, Version=*') "artifact receipt assembly identity differs for Revit $year"
    $fingerprintRoot = Join-Path $TempRoot ("fingerprint-$year")
    $fingerprintOutput = @(& 'C:\Program Files\dotnet\dotnet.exe' $toolPath fingerprint --artifact (Join-Path $positiveOne $fileName) --output-dir $fingerprintRoot 2>&1)
    Assert-Proof ($LASTEXITCODE -eq 0) ("artifact fingerprint failed for Revit ${year}: " + [string]::Join("`n", @($fingerprintOutput)))
    $fingerprint = Get-Content -LiteralPath (Join-Path $fingerprintRoot 'artifact.fingerprint.json') -Raw | ConvertFrom-Json
    Assert-Proof ([string]$fingerprint.managedCodeSha256 -eq [string]$artifactReceipt.managedCodeSha256) "managed-code fingerprint differs for Revit $year"
}
Assert-Proof ((Get-ProofSha256 (Join-Path $positiveOne 'proof.receipt.json')) -eq (Get-ProofSha256 (Join-Path $positiveTwo 'proof.receipt.json'))) 'deterministic proof receipts differ'
Assert-Proof (@($receiptOne.artifacts.psobject.Properties).Count -eq 3) 'positive receipt did not contain exactly three artifacts'
Assert-Proof (@($receiptTwo.artifacts.psobject.Properties).Count -eq 3) 'second positive receipt did not contain exactly three artifacts'

$malformedArtifact = Join-Path $TempRoot 'malformed-il-artifact.dll'
$validBytes = [System.IO.File]::ReadAllBytes((Join-Path $positiveOne 'RevitOperator.SafeReadCertifiedExecution.Revit2025.dll'))
[System.IO.File]::WriteAllBytes($malformedArtifact, $validBytes[0..63])
$malformedRoot = Join-Path $TempRoot 'malformed-il-fingerprint'
$malformedOutput = @(& 'C:\Program Files\dotnet\dotnet.exe' $toolPath fingerprint --artifact $malformedArtifact --output-dir $malformedRoot 2>&1)
Assert-Proof ($LASTEXITCODE -eq 1) ("malformed artifact fingerprint exit was not rejected: " + [string]::Join("`n", @($malformedOutput)))
$malformedReceipt = Get-Content -LiteralPath (Join-Path $malformedRoot 'artifact.fingerprint.json') -Raw | ConvertFrom-Json
Assert-Proof ([string]$malformedReceipt.status -eq 'rejected') 'malformed artifact did not emit a rejected fingerprint receipt'
Assert-Proof (@($malformedReceipt.issues).Count -gt 0) 'malformed artifact receipt omitted deterministic issues'

$installedRevitPaths = @('2023', '2024', '2025') | ForEach-Object { "C:\Program Files\Autodesk\Revit $_\RevitAPI.dll" }
Assert-Proof (@($installedRevitPaths | Where-Object { -not (Test-Path -LiteralPath $_ -PathType Leaf) }).Count -eq 0) 'installed Revit target reference pair is missing'
$realTargetRoot = Join-Path $TempRoot 'installed-revit-target-inventory'
[System.IO.Directory]::CreateDirectory($realTargetRoot) | Out-Null
$realTargetManifest = Join-Path $realTargetRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $realTargetManifest -UseInstalledRevit
$realTargetOutput = @(& 'C:\Program Files\dotnet\dotnet.exe' $toolPath inventory --manifest $realTargetManifest --output-dir (Join-Path $realTargetRoot 'output') 2>&1)
Assert-Proof ($LASTEXITCODE -eq 0) ("installed Revit target inventory failed: " + [string]::Join("`n", @($realTargetOutput)))
$realTargetReceipt = Get-Content -LiteralPath (Join-Path $realTargetRoot 'output\proof.receipt.json') -Raw | ConvertFrom-Json
Assert-Proof (@($realTargetReceipt.issues).Count -eq 0) 'installed Revit target inventory contained proof issues'

$negativeCases = Get-Content -LiteralPath (Join-Path $proofRoot 'fixtures\negative\cases.json') -Raw | ConvertFrom-Json
$negativePasses = 0
foreach ($case in $negativeCases) {
    $caseRoot = Join-Path $TempRoot ('negative-' + [string]$case.name)
    $sourceRoot = Join-Path $caseRoot 'source'
    [System.IO.Directory]::CreateDirectory($sourceRoot) | Out-Null
    $sourcePath = Join-Path $sourceRoot 'CertifiedKernel.cs'
    Copy-Item -LiteralPath (Join-Path $proofRoot 'fixtures\positive\source\CertifiedKernel.cs') -Destination $sourcePath
    if ([string]$case.kind -eq 'appendSource') {
        Write-ProofUtf8 (Join-Path $sourceRoot 'Injected.cs') ([string]$case.payload)
    } elseif ([string]$case.kind -eq 'prependSource') {
        $sourceText = (Get-Content -LiteralPath $sourcePath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
        Write-ProofUtf8 $sourcePath ([string]$case.payload + $sourceText)
    } elseif ([string]$case.kind -eq 'replaceSource') {
        $sourceText = (Get-Content -LiteralPath $sourcePath -Raw).Replace("`r`n", "`n").Replace("`r", "`n")
        $find = [string]$case.find
        Assert-Proof ($sourceText.Contains($find)) "negative mutation anchor was not found for $($case.name)"
        $sourceText = $sourceText.Replace($find, [string]$case.replace)
        Write-ProofUtf8 $sourcePath $sourceText
    } else {
        throw "Unknown negative fixture kind: $($case.kind)"
    }
    $manifestPath = Join-Path $caseRoot 'manifest.json'
    $negativeCompileFiles = @(Get-ChildItem -LiteralPath $sourceRoot -Filter '*.cs' -File | Sort-Object Name | ForEach-Object { $_.Name })
    New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $sourceRoot -ReferenceRoot $referenceRoot -ManifestPath $manifestPath -ExpectedPath $expectedPath -CompileFiles $negativeCompileFiles
    $receipt = Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $manifestPath -OutputPath (Join-Path $caseRoot 'output') -ExpectedExit 1 -ExpectedCode ([string]$case.expectedCode)
    if ([string]$case.name -eq 'fake-autodesk-source') {
        $diagnosticMessages = [string]::Join("`n", @($receipt.issues.message))
        Assert-Proof ($diagnosticMessages.Contains('CS0436')) 'Autodesk shadow fixture did not exercise CS0436 rejection'
    }
    $negativePasses++
}

$duplicateRoot = Join-Path $TempRoot 'negative-duplicate-reference'
[System.IO.Directory]::CreateDirectory($duplicateRoot) | Out-Null
$duplicateManifest = Join-Path $duplicateRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $duplicateManifest -ExpectedPath $expectedPath
$duplicateObject = Get-Content -LiteralPath $duplicateManifest -Raw | ConvertFrom-Json
$duplicateObject.variants[0].revitReferences = @($duplicateObject.variants[0].revitReferences[0], $duplicateObject.variants[0].revitReferences[0])
Write-ProofJson $duplicateManifest $duplicateObject
Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $duplicateManifest -OutputPath (Join-Path $duplicateRoot 'output') -ExpectedExit 1 -ExpectedCode 'DUPLICATE_REFERENCE_IDENTITY' | Out-Null
$negativePasses++

function Invoke-ManifestNegative {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Mutate,
        [Parameter(Mandatory = $true)][string]$ExpectedCode
    )
    $caseRoot = Join-Path $TempRoot ('negative-manifest-' + $Name)
    [System.IO.Directory]::CreateDirectory($caseRoot) | Out-Null
    $manifestPath = Join-Path $caseRoot 'manifest.json'
    New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $manifestPath -ExpectedPath $expectedPath
    $manifestObject = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    & $Mutate $manifestObject
    Write-ProofJson $manifestPath $manifestObject
    Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $manifestPath -OutputPath (Join-Path $caseRoot 'output') -ExpectedExit 1 -ExpectedCode $ExpectedCode | Out-Null
}

Invoke-ManifestNegative -Name 'anycpu' -ExpectedCode 'VARIANT_PLATFORM' -Mutate { param($m) $m.variants[0].platform = 'AnyCpu' }
$negativePasses++
Invoke-ManifestNegative -Name 'wrong-tfm' -ExpectedCode 'VARIANT_TFM' -Mutate { param($m) $m.variants[0].targetFramework = 'net9.0' }
$negativePasses++
Invoke-ManifestNegative -Name 'missing-revitapi' -ExpectedCode 'REVIT_REFERENCE_SET' -Mutate { param($m) $m.variants[0].revitReferences = @() }
$negativePasses++
Invoke-ManifestNegative -Name 'missing-windows-framework' -ExpectedCode 'FRAMEWORK_SET' -Mutate { param($m) $m.variants[2].frameworks = @($m.variants[2].frameworks[0]) }
$negativePasses++
Invoke-ManifestNegative -Name 'serialization-root' -ExpectedCode 'SERIALIZATION_ROOT_MISMATCH' -Mutate { param($m) $m.policy.serializationRoots = @('SafeReadCertifiedExecution.ReadTitleRequest') }
$negativePasses++
Invoke-ManifestNegative -Name 'serialization-callsite' -ExpectedCode 'POLICY_SERIALIZATION_CALLSITES' -Mutate { param($m) $m.policy.serializationCallsites = @('Method:void missing()|assembly=missing') }
$negativePasses++

$forwarderRoot = Join-Path $TempRoot 'negative-forwarder'
[System.IO.Directory]::CreateDirectory($forwarderRoot) | Out-Null
$forwarderManifest = Join-Path $forwarderRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $forwarderManifest -ExpectedPath $expectedPath
$forwarderObject = Get-Content -LiteralPath $forwarderManifest -Raw | ConvertFrom-Json
$forwarderRevit = Join-Path $referenceRoot 'forwarder\RevitAPI.dll'
$forwarderTarget = Join-Path $referenceRoot 'forwarder\ForwardTarget.dll'
$forwarderObject.variants[0].revitReferences = @(
    [pscustomobject](New-ProofAssemblyLock $forwarderRevit),
    [pscustomobject](New-ProofAssemblyLock $forwarderTarget)
)
Write-ProofJson $forwarderManifest $forwarderObject
Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $forwarderManifest -OutputPath (Join-Path $forwarderRoot 'output') -ExpectedExit 1 -ExpectedCode 'REVIT_TYPE_FORWARDER' | Out-Null
$negativePasses++

$compilerTamperRoot = Join-Path $TempRoot 'negative-compiler-lock'
[System.IO.Directory]::CreateDirectory($compilerTamperRoot) | Out-Null
$compilerTamperManifest = Join-Path $compilerTamperRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $compilerTamperManifest -ExpectedPath $expectedPath
$compilerTamperObject = Get-Content -LiteralPath $compilerTamperManifest -Raw | ConvertFrom-Json
$compilerTamperObject.sdk.compilerSha256 = '0000000000000000000000000000000000000000000000000000000000000000'
Write-ProofJson $compilerTamperManifest $compilerTamperObject
Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $compilerTamperManifest -OutputPath (Join-Path $compilerTamperRoot 'output') -ExpectedExit 1 -ExpectedCode 'COMPILER_LOCK' | Out-Null
$negativePasses++

$sourceTamperRoot = Join-Path $TempRoot 'negative-source-lock'
[System.IO.Directory]::CreateDirectory($sourceTamperRoot) | Out-Null
$sourceTamperManifest = Join-Path $sourceTamperRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $positiveSource -ReferenceRoot $referenceRoot -ManifestPath $sourceTamperManifest -ExpectedPath $expectedPath
$sourceTamperObject = Get-Content -LiteralPath $sourceTamperManifest -Raw | ConvertFrom-Json
$sourceTamperObject.source.files[0].sha256 = '0000000000000000000000000000000000000000000000000000000000000000'
Write-ProofJson $sourceTamperManifest $sourceTamperObject
Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $sourceTamperManifest -OutputPath (Join-Path $sourceTamperRoot 'output') -ExpectedExit 1 -ExpectedCode 'SOURCE_HASH' | Out-Null
$negativePasses++

$extraFileRoot = Join-Path $TempRoot 'negative-unlocked-file'
$extraFileSource = Join-Path $extraFileRoot 'source'
[System.IO.Directory]::CreateDirectory($extraFileSource) | Out-Null
Copy-Item -LiteralPath (Join-Path $proofRoot 'fixtures\positive\source\CertifiedKernel.cs') -Destination (Join-Path $extraFileSource 'CertifiedKernel.cs')
$extraFileManifest = Join-Path $extraFileRoot 'manifest.json'
New-ProofFixtureManifest -ProofRoot $proofRoot -SourceRoot $extraFileSource -ReferenceRoot $referenceRoot -ManifestPath $extraFileManifest -ExpectedPath $expectedPath
Write-ProofUtf8 (Join-Path $extraFileSource 'Unlocked.cs') 'internal sealed class AmbientPayload { }'
Invoke-ProofCheck -ToolPath $toolPath -ManifestPath $extraFileManifest -OutputPath (Join-Path $extraFileRoot 'output') -ExpectedExit 1 -ExpectedCode 'SOURCE_EXACT_SET' | Out-Null
$negativePasses++

$gitAfter = & git -C (Split-Path -Parent (Split-Path -Parent $proofRoot)) status --porcelain=v1 --untracked-files=all
Assert-Proof ([string]::Join("`n", @($gitBefore)) -ceq [string]::Join("`n", @($gitAfter))) 'test run wrote into the repository instead of only caller temp'

[pscustomobject]@{
    Status = 'PASS'
    PositiveChecks = 2
    NegativeChecks = $negativePasses
    RevitArtifactsPerPositiveCheck = 3
    TempRoot = $TempRoot
    AmbientDirectoryBuildFalsifier = 'PASS'
    LineEndingDeterminismFalsifier = 'PASS'
    TargetLockFalsifiers = 'PASS'
    InstalledRevitTargetInventory = 'PASS'
    SerializationBoundaryFalsifiers = 'PASS'
    MultiSourceInventoryFalsifier = 'PASS'
    RepositoryWriteFalsifier = 'PASS'
    ArtifactFingerprintGate = 'PASS'
    MalformedArtifactReceiptGate = 'PASS'
}
