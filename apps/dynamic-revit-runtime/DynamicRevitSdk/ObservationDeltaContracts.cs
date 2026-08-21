using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicObservationDeltaPolicyV1
{
    public const string Schema = "dynamic-revit-worker-observation-delta/v1";
    public const int MaximumTurns = 5;
    public const int MaximumPagesPerScope = 64;
    public const int MaximumRetainedPages = MaximumTurns * MaximumPagesPerScope;

    public static string Hash(DynamicObservationDeltaV1 value) => DynamicWire.Sha256(DynamicCanonical.Join(
        Schema, value.TurnIndex.ToString(System.Globalization.CultureInfo.InvariantCulture),
        value.PriorFactRequestHash, value.SnapshotHash,
        value.DocumentRevision.ToString(System.Globalization.CultureInfo.InvariantCulture),
        DynamicCanonical.Set(value.KnownScopeHashes), value.NewScopeHash,
        string.Join("\n", value.Pages.Select(page => page.EnvelopeHash))));

    public static void Validate(DynamicObservationDeltaV1 value)
    {
        if (value == null || value.Schema != Schema || value.TurnIndex is < 1 or >= MaximumTurns ||
            !DynamicCanonical.Hash(value.PriorFactRequestHash) || !DynamicCanonical.Hash(value.SnapshotHash) ||
            value.DocumentRevision < 0 || !DynamicCanonical.Hash(value.NewScopeHash) ||
            value.KnownScopeHashes == null || value.Pages == null)
            throw new ArgumentException("Observation delta envelope is malformed.");
        var known = value.KnownScopeHashes;
        if (known.Length is < 1 or >= MaximumTurns || known.Length != value.TurnIndex || known.Any(hash => !DynamicCanonical.Hash(hash)) ||
            known.Distinct(StringComparer.Ordinal).Count() != known.Length ||
            !known.SequenceEqual(known.OrderBy(hash => hash, StringComparer.Ordinal)) ||
            known.Contains(value.NewScopeHash, StringComparer.Ordinal))
            throw new ArgumentException("Observation delta known/new scope identities are invalid.");
        var pages = value.Pages.ToArray();
        if (pages.Length is < 1 or > MaximumPagesPerScope)
            throw new ArgumentException("Observation delta page count is outside bounds.");
        foreach (var page in pages) DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(page);
        var first = pages[0];
        if (first.ScopeHash != value.NewScopeHash || first.SnapshotHash != value.SnapshotHash ||
            first.DocumentRevision != value.DocumentRevision || first.PageOffset != 0)
            throw new ArgumentException("Observation delta does not bind its declared snapshot, revision, and new scope.");
        var expectedOffset = 0;
        foreach (var page in pages)
        {
            if (page.ScopeHash != first.ScopeHash || page.SnapshotHash != first.SnapshotHash ||
                page.DocumentRevision != first.DocumentRevision || page.DocumentFingerprint != first.DocumentFingerprint ||
                page.DocumentSessionId != first.DocumentSessionId || page.RevisionHash != first.RevisionHash ||
                page.TotalCount != first.TotalCount || page.PageSize != first.PageSize || page.PageOffset != expectedOffset)
                throw new ArgumentException("Observation delta pages are mixed, missing, or non-contiguous.");
            expectedOffset += page.Facts.Count;
        }
        if (expectedOffset != first.TotalCount || pages[pages.Length - 1].NextCursor != null ||
            value.DeltaHash != Hash(value))
            throw new ArgumentException("Observation delta is incomplete or has an invalid identity.");
    }
}

public sealed class DynamicObservationDeltaV1
{
    public string Schema { get; set; } = DynamicObservationDeltaPolicyV1.Schema;
    public int TurnIndex { get; set; }
    public string PriorFactRequestHash { get; set; } = "";
    public string SnapshotHash { get; set; } = "";
    public long DocumentRevision { get; set; }
    public string[] KnownScopeHashes { get; set; } = Array.Empty<string>();
    public string NewScopeHash { get; set; } = "";
    public IReadOnlyList<DynamicBuildingSystemsEnvelopeV1> Pages { get; set; } = Array.Empty<DynamicBuildingSystemsEnvelopeV1>();
    public string DeltaHash { get; set; } = "";
}
