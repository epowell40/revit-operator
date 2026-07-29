using System;
using System.Collections.Generic;

namespace RevitSafeReadProof;

internal sealed class LockedInputs
{
    public string ManifestDirectory { get; set; } = string.Empty;
    public string SourceRoot { get; set; } = string.Empty;
    public List<LockedSourceFile> Sources { get; set; } = new();
    public List<LockedResourceFile> Resources { get; set; } = new();
    public SortedDictionary<string, List<string>> FrameworkReferences { get; set; } = new(StringComparer.Ordinal);
    public SortedDictionary<string, List<string>> RevitReferences { get; set; } = new(StringComparer.Ordinal);
}

internal sealed class LockedSourceFile
{
    public string LogicalPath { get; set; } = string.Empty;
    public string FullPath { get; set; } = string.Empty;
    public byte[] Bytes { get; set; } = Array.Empty<byte>();
}

internal sealed class LockedResourceFile
{
    public string LogicalPath { get; set; } = string.Empty;
    public string LogicalName { get; set; } = string.Empty;
    public bool IsPublic { get; set; }
    public byte[] Bytes { get; set; } = Array.Empty<byte>();
}

internal sealed class VerificationResult
{
    public List<ProofIssue> Issues { get; set; } = new();
    public ProofObservation Observation { get; set; } = new();
}

internal sealed class PublicAbiInspection
{
    public InventoryExpectation Inventory { get; set; } = new();
    public string EntryPointResultType { get; set; } = string.Empty;
}
