using System;
using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace RevitSafeReadProof;

internal sealed class ProofManifest
{
    public int SchemaVersion { get; set; }
    public string ProofKind { get; set; } = string.Empty;
    public string TrustBoundary { get; set; } = string.Empty;
    public SdkLock Sdk { get; set; } = new();
    public FrameworkLock Framework { get; set; } = new();
    public SourceLock Source { get; set; } = new();
    public List<VariantLock> Variants { get; set; } = new();
    public ProofPolicy Policy { get; set; } = new();
    public ExpectedInventories? Expected { get; set; }
}

internal sealed class SdkLock
{
    public string Version { get; set; } = string.Empty;
    public string SdkPath { get; set; } = string.Empty;
    public string CompilerPath { get; set; } = string.Empty;
    public string CompilerSha256 { get; set; } = string.Empty;
    public string CompilerFileVersion { get; set; } = string.Empty;
    public string CodeAnalysisPath { get; set; } = string.Empty;
    public string CodeAnalysisSha256 { get; set; } = string.Empty;
    public string CodeAnalysisCSharpPath { get; set; } = string.Empty;
    public string CodeAnalysisCSharpSha256 { get; set; } = string.Empty;
    public string LanguageVersion { get; set; } = string.Empty;
}

internal sealed class FrameworkLock
{
    public string Name { get; set; } = string.Empty;
    public string Version { get; set; } = string.Empty;
    public string TargetFramework { get; set; } = string.Empty;
    public string ReferenceRoot { get; set; } = string.Empty;
    public string InventorySha256 { get; set; } = string.Empty;
    public List<AssemblyFileLock> Files { get; set; } = new();
}

internal class FileLock
{
    public string Path { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
}

internal sealed class AssemblyFileLock : FileLock
{
    public string Identity { get; set; } = string.Empty;
}

internal sealed class ResourceFileLock : FileLock
{
    public string LogicalName { get; set; } = string.Empty;
    public bool IsPublic { get; set; }
}

internal sealed class SourceLock
{
    public string Root { get; set; } = string.Empty;
    public string AssemblyName { get; set; } = string.Empty;
    public List<FileLock> Files { get; set; } = new();
    public List<ResourceFileLock> Resources { get; set; } = new();
}

internal sealed class VariantLock
{
    public string RevitYear { get; set; } = string.Empty;
    public List<string> PreprocessorSymbols { get; set; } = new();
    public List<AssemblyFileLock> RevitReferences { get; set; } = new();
}

internal sealed class ProofPolicy
{
    public List<string> AllowedOperationKinds { get; set; } = new();
    public List<string> AllowedImplicitOperationKinds { get; set; } = new();
    public List<string> AllowedSensitiveSymbols { get; set; } = new();
    public List<string> AllowedAttributeSymbols { get; set; } = new();
    public List<string> AllowedMutableFields { get; set; } = new();
    public List<string> AllowedRouteLiterals { get; set; } = new();
    public List<string> AllowedListenerPrefixes { get; set; } = new();
    public List<string> SerializationRoots { get; set; } = new();
    public List<string> AllowedSerializationLeafTypes { get; set; } = new();
    public SensitiveRoles Roles { get; set; } = new();
}

internal sealed class SensitiveRoles
{
    public string HttpListenerOwnerType { get; set; } = string.Empty;
    public string HttpListenerField { get; set; } = string.Empty;
    public string ExternalEventOwnerType { get; set; } = string.Empty;
    public string ExternalEventHandlerType { get; set; } = string.Empty;
    public string ExternalEventField { get; set; } = string.Empty;
    public string ExternalEventStateField { get; set; } = string.Empty;
}

internal sealed class ExpectedInventories
{
    public InventoryExpectation Syntax { get; set; } = new();
    public InventoryExpectation Types { get; set; } = new();
    public InventoryExpectation Members { get; set; } = new();
    public InventoryExpectation SerializationClosure { get; set; } = new();
    public InventoryExpectation Resources { get; set; } = new();
    public SortedDictionary<string, VariantExpected> Variants { get; set; } = new(StringComparer.Ordinal);
}

internal sealed class VariantExpected
{
    public InventoryExpectation References { get; set; } = new();
    public InventoryExpectation SymbolBindings { get; set; } = new();
    public InventoryExpectation Methods { get; set; } = new();
    public InventoryExpectation Metadata { get; set; } = new();
    public InventoryExpectation Il { get; set; } = new();
    public string OutputSha256 { get; set; } = string.Empty;
}

internal sealed class InventoryExpectation
{
    public int Count { get; set; }
    public string Sha256 { get; set; } = string.Empty;
    public List<string> Items { get; set; } = new();
}

internal sealed class ProofIssue
{
    public ProofIssue(string code, string message)
    {
        Code = code;
        Message = message;
    }

    public string Code { get; }
    public string Message { get; }
}

internal sealed class VariantObservation
{
    [JsonIgnore]
    public byte[] EmittedBytes { get; set; } = Array.Empty<byte>();

    public InventoryExpectation References { get; set; } = new();
    public InventoryExpectation SymbolBindings { get; set; } = new();
    public InventoryExpectation Methods { get; set; } = new();
    public InventoryExpectation Metadata { get; set; } = new();
    public InventoryExpectation Il { get; set; } = new();
    public string OutputSha256 { get; set; } = string.Empty;
}

internal sealed class ProofObservation
{
    public InventoryExpectation Syntax { get; set; } = new();
    public InventoryExpectation Types { get; set; } = new();
    public InventoryExpectation Members { get; set; } = new();
    public InventoryExpectation SerializationClosure { get; set; } = new();
    public InventoryExpectation Resources { get; set; } = new();
    public SortedDictionary<string, VariantObservation> Variants { get; set; } = new(StringComparer.Ordinal);

    public ExpectedInventories ToExpected()
    {
        var result = new ExpectedInventories
        {
            Syntax = Syntax,
            Types = Types,
            Members = Members,
            SerializationClosure = SerializationClosure,
            Resources = Resources,
        };
        foreach (var pair in Variants)
        {
            result.Variants.Add(pair.Key, new VariantExpected
            {
                References = pair.Value.References,
                SymbolBindings = pair.Value.SymbolBindings,
                Methods = pair.Value.Methods,
                Metadata = pair.Value.Metadata,
                Il = pair.Value.Il,
                OutputSha256 = pair.Value.OutputSha256,
            });
        }
        return result;
    }
}

internal sealed class ProofReceipt
{
    public int SchemaVersion { get; set; } = 1;
    public string ProofKind { get; set; } = Constants.ProofKind;
    public string Mode { get; set; } = string.Empty;
    public string Status { get; set; } = string.Empty;
    public bool Certified { get; set; }
    public string ManifestSha256 { get; set; } = string.Empty;
    public string TrustBoundary { get; set; } = string.Empty;
    public List<string> CompilerOptions { get; set; } = new();
    public List<ProofIssue> Issues { get; set; } = new();
    public ProofObservation Observation { get; set; } = new();
    public SortedDictionary<string, ArtifactReceipt> Artifacts { get; set; } = new(StringComparer.Ordinal);
}

internal sealed class ArtifactReceipt
{
    public string FileName { get; set; } = string.Empty;
    public string Sha256 { get; set; } = string.Empty;
    public long Length { get; set; }
}

internal static class Constants
{
    public const string ProofKind = "revit-safe-read-whole-assembly/v1";
    public const string TrustBoundary = "Trusted local administrator, operating system, installed locked SDK/reference pack, Autodesk Revit, and Revit process; malicious local admin/OS/Revit are excluded.";

    public static readonly string[] CompilerOptions =
    {
        "/noconfig",
        "/nostdlib+",
        "/deterministic+",
        "/optimize+",
        "/checked+",
        "/unsafe-",
        "/warn:9999",
        "/warnaserror+",
        "/nullable:enable",
        "/langversion:13.0",
        "/target:library",
        "/debug-",
        "/utf8output",
    };
}
