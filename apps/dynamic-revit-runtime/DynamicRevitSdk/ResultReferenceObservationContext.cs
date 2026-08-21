using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

public sealed partial class DynamicResultReferenceProgramContextV1
{
    private readonly DynamicBuildingSystemsEnvelopeV1[] _buildingSystemsPages;
    private readonly DynamicTrustedElementFactV1[] _trustedExternalTargets;

    public DynamicResultReferenceProgramContextV1(DynamicTaskInput input, long documentRevision,
        string resultReferenceSnapshotHash, string resultReferenceScopeHash,
        IEnumerable<DynamicBuildingSystemsEnvelopeV1> buildingSystemsPages,
        IEnumerable<DynamicTrustedElementFactV1> trustedExternalTargets)
    {
        Input = input ?? throw new ArgumentNullException(nameof(input));
        var document = input.Document;
        if (documentRevision < 0 || document == null || !DynamicCanonical.Hash(document.ProjectFingerprint) || !DynamicCanonical.Id(document.SessionId, 256))
            throw new ArgumentException("Result-reference worker context requires an exact document, session, and revision.");

        var validated = DynamicResultReferenceObservationContextAuthorityV1.ValidateAndClone(document.ProjectFingerprint, document.SessionId,
            documentRevision, resultReferenceSnapshotHash, resultReferenceScopeHash, buildingSystemsPages, trustedExternalTargets);
        ResultReferenceDocumentRevision = documentRevision;
        ResultReferenceSnapshotHash = validated.SnapshotHash;
        ResultReferenceScopeHash = validated.ScopeHash;
        BuildingSystemsRevisionHash = validated.RevisionHash;
        _buildingSystemsPages = validated.Pages;
        _trustedExternalTargets = validated.TrustedTargets;
        Plan = new DynamicResultReferenceGraphBuilderV1(DynamicWire.InputHash(input), document.ProjectFingerprint, document.SessionId, documentRevision);
    }

    public long ResultReferenceDocumentRevision { get; }
    public string ResultReferenceSnapshotHash { get; }
    public string ResultReferenceScopeHash { get; }
    public string BuildingSystemsRevisionHash { get; }
    public IReadOnlyList<DynamicBuildingSystemsEnvelopeV1> BuildingSystemsPages =>
        Array.AsReadOnly(_buildingSystemsPages.Select(DynamicResultReferenceObservationContextAuthorityV1.Clone).ToArray());
    public IReadOnlyList<DynamicBuildingSystemsFactV1> BuildingSystemsFacts =>
        Array.AsReadOnly(_buildingSystemsPages.SelectMany(page => page.Facts).Select(DynamicResultReferenceObservationContextAuthorityV1.Clone).ToArray());
    public IReadOnlyList<DynamicTrustedElementFactV1> TrustedExternalTargets =>
        Array.AsReadOnly(_trustedExternalTargets.Select(DynamicResultReferenceObservationContextAuthorityV1.Clone).ToArray());

    public DynamicExternalTargetReferenceV1 ExternalTarget(string uniqueId)
    {
        var fact = _trustedExternalTargets.SingleOrDefault(value => value.UniqueId == uniqueId)
            ?? throw new ArgumentException("Trusted external target is not present in the exact observation context.", nameof(uniqueId));
        return new DynamicExternalTargetReferenceV1
        {
            TargetUniqueId = fact.UniqueId,
            TargetElementId = fact.ElementId,
            DocumentFingerprint = fact.DocumentFingerprint,
            ExpectedCategoryStableId = fact.CategoryStableId,
            ExpectedTypeUniqueId = fact.TypeUniqueId,
            ExpectedStateHash = fact.StateHash
        };
    }
}

public static class DynamicResultReferenceObservationSetV1
{
    public const int MaximumScopes = 5;

    public static string ScopeSetHash(IEnumerable<string> scopeHashes)
    {
        var values = CanonicalHashes(scopeHashes, nameof(scopeHashes));
        return values.Length == 1 ? values[0] : DynamicWire.Sha256(DynamicCanonical.Join(
            "dynamic-revit-result-reference-scope-set/v1", DynamicCanonical.Set(values)));
    }

    public static string RevisionSetHash(IEnumerable<DynamicBuildingSystemsEnvelopeV1> pages)
    {
        var values = (pages ?? throw new ArgumentNullException(nameof(pages))).ToArray();
        var groups = values.GroupBy(page => page.ScopeHash, StringComparer.Ordinal).OrderBy(group => group.Key, StringComparer.Ordinal).ToArray();
        if (groups.Length is < 1 or > MaximumScopes) throw new ArgumentException("Result-reference observation scope count is outside bounds.", nameof(pages));
        var bindings = groups.Select(group => DynamicCanonical.Join(group.Key,
            group.Select(page => page.RevisionHash).Distinct(StringComparer.Ordinal).Single())).ToArray();
        return bindings.Length == 1 ? values[0].RevisionHash : DynamicWire.Sha256(DynamicCanonical.Join(
            "dynamic-revit-result-reference-revision-set/v1", string.Join("\n", bindings)));
    }

    private static string[] CanonicalHashes(IEnumerable<string> hashes, string parameterName)
    {
        var values = (hashes ?? throw new ArgumentNullException(parameterName)).ToArray();
        if (values.Length is < 1 or > MaximumScopes || values.Any(value => !DynamicCanonical.Hash(value)) ||
            values.Distinct(StringComparer.Ordinal).Count() != values.Length)
            throw new ArgumentException("Result-reference observation scope identities are invalid, duplicated, or unbounded.", parameterName);
        return values.OrderBy(value => value, StringComparer.Ordinal).ToArray();
    }
}
internal static class DynamicResultReferenceObservationContextAuthorityV1
{
    internal sealed class Validated
    {
        internal string SnapshotHash = "";
        internal string ScopeHash = "";
        internal string RevisionHash = "";
        internal DynamicBuildingSystemsEnvelopeV1[] Pages = Array.Empty<DynamicBuildingSystemsEnvelopeV1>();
        internal DynamicTrustedElementFactV1[] TrustedTargets = Array.Empty<DynamicTrustedElementFactV1>();
    }

    internal static Validated ValidateAndClone(string documentFingerprint, string documentSessionId, long documentRevision,
        string snapshotHash, string scopeHash, IEnumerable<DynamicBuildingSystemsEnvelopeV1> pages,
        IEnumerable<DynamicTrustedElementFactV1> trustedTargets)
    {
        var pageValues = (pages ?? throw new ArgumentNullException(nameof(pages))).Take(DynamicObservationDeltaPolicyV1.MaximumRetainedPages + 1).ToArray();
        var trustedValues = (trustedTargets ?? throw new ArgumentNullException(nameof(trustedTargets))).Take(DynamicResultReferenceContractV1.MaximumTrustedExternalTargets + 1).ToArray();
        if (pageValues.Length > DynamicObservationDeltaPolicyV1.MaximumRetainedPages || trustedValues.Length > DynamicResultReferenceContractV1.MaximumTrustedExternalTargets)
            throw new ArgumentException("Result-reference observation context exceeds hard bounds.");
        if (pageValues.Length == 0)
        {
            if (trustedValues.Length != 0 || !string.IsNullOrEmpty(snapshotHash) || !string.IsNullOrEmpty(scopeHash))
                throw new ArgumentException("Result-reference observation identities or trusted targets require complete Building Systems pages.");
            return new Validated();
        }
        if (!DynamicCanonical.Hash(snapshotHash) || !DynamicCanonical.Hash(scopeHash))
            throw new ArgumentException("Result-reference observation snapshot or scope identity is invalid.");

        foreach (var page in pageValues) DynamicBuildingSystemsObservationPolicyV1.ValidateEnvelope(page);
        var first = pageValues[0];
        if (first.DocumentFingerprint != documentFingerprint || first.DocumentSessionId != documentSessionId || first.DocumentRevision != documentRevision ||
            first.SnapshotHash != snapshotHash)
            throw new ArgumentException("Building Systems pages do not bind the exact result-reference document, session, revision, and snapshot.");
        var groups = pageValues.GroupBy(page => page.ScopeHash, StringComparer.Ordinal).OrderBy(group => group.Key, StringComparer.Ordinal).ToArray();
        if (groups.Length is < 1 or > DynamicResultReferenceObservationSetV1.MaximumScopes ||
            DynamicResultReferenceObservationSetV1.ScopeSetHash(groups.Select(group => group.Key)) != scopeHash)
            throw new ArgumentException("Building Systems page scopes are substituted, duplicated, or unbounded.");
        foreach (var group in groups)
        {
            var ordered = group.OrderBy(page => page.PageOffset).ToArray();
            var groupFirst = ordered[0];
            var expectedOffset = 0;
            foreach (var page in ordered)
            {
                if (page.DocumentFingerprint != first.DocumentFingerprint || page.DocumentSessionId != first.DocumentSessionId || page.DocumentRevision != first.DocumentRevision ||
                    page.SnapshotHash != first.SnapshotHash || page.ScopeHash != groupFirst.ScopeHash || page.RevisionHash != groupFirst.RevisionHash ||
                    page.TotalCount != groupFirst.TotalCount || page.PageSize != groupFirst.PageSize || page.PageOffset != expectedOffset)
                    throw new ArgumentException("Building Systems page set is mixed, duplicated, missing, or non-contiguous.");
                expectedOffset += page.Facts.Count;
            }
            if (expectedOffset != groupFirst.TotalCount || ordered[ordered.Length - 1].NextCursor != null)
                throw new ArgumentException("Building Systems page set is incomplete.");
            if (DynamicBuildingSystemsObservationPolicyV1.RevisionHash(documentFingerprint, documentSessionId, documentRevision, snapshotHash,
                ordered.SelectMany(page => page.Facts)) != groupFirst.RevisionHash)
                throw new ArgumentException("Building Systems page-set revision identity is invalid.");
        }
        var canonicalPages = groups.SelectMany(group => group.OrderBy(page => page.PageOffset)).ToArray();
        var observed = canonicalPages.SelectMany(page => page.Facts).ToArray();
        if (observed.Length > DynamicBuildingSystemsObservationContractV1.MaximumObservedFacts ||
            observed.Select(value => value.Element.StableId).Distinct(StringComparer.Ordinal).Count() != observed.Length ||
            groups.Any(group => !group.SelectMany(page => page.Facts).Select(value => value.Element.StableId)
                .SequenceEqual(group.SelectMany(page => page.Facts).Select(value => value.Element.StableId).OrderBy(value => value, StringComparer.Ordinal))))
            throw new ArgumentException("Building Systems facts are duplicated, non-canonical, or unbounded across scopes.");

        var observedByUniqueId = observed.Where(value => value.Element.UniqueId != null)
            .ToDictionary(value => value.Element.UniqueId ?? throw new ArgumentException("Observed element unique identity is missing."), StringComparer.Ordinal);
        var trustedIds = new HashSet<string>(StringComparer.Ordinal); var trustedElementIds = new HashSet<long>();
        foreach (var trusted in trustedValues)
        {
            ValidateTrusted(trusted, documentFingerprint);
            if (!trustedIds.Add(trusted.UniqueId) || !trustedElementIds.Add(trusted.ElementId) || !observedByUniqueId.TryGetValue(trusted.UniqueId, out var fact) ||
                fact.Element.ElementId != trusted.ElementId || (fact.Category?.StableId ?? "category:none") != trusted.CategoryStableId ||
                (fact.Type?.UniqueId ?? "type:none") != trusted.TypeUniqueId || fact.Annotation != null && fact.Annotation.StateHash != trusted.StateHash ||
                fact.Tag != null && fact.Tag.StateHash != trusted.StateHash)
                throw new ArgumentException("Trusted external target is duplicated or does not exactly match an observed Building Systems fact.");
        }
        return new Validated
        {
            SnapshotHash = snapshotHash, ScopeHash = scopeHash, RevisionHash = DynamicResultReferenceObservationSetV1.RevisionSetHash(canonicalPages),
            Pages = canonicalPages.Select(Clone).ToArray(), TrustedTargets = trustedValues.Select(Clone).ToArray()
        };
    }

    private static void ValidateTrusted(DynamicTrustedElementFactV1 value, string documentFingerprint)
    {
        if (value == null || !DynamicCanonical.Id(value.UniqueId, 256) || value.ElementId < 0 || value.DocumentFingerprint != documentFingerprint ||
            !DynamicCanonical.Hash(value.DocumentFingerprint) || !DynamicCanonical.Id(value.CategoryStableId, 256) || !DynamicCanonical.Id(value.TypeUniqueId, 256) ||
            !DynamicCanonical.Hash(value.StateHash) || !value.Exists || !value.Verified || !value.Visible)
            throw new ArgumentException("Trusted external target is missing, hidden, unverified, foreign, or malformed.");
    }

    internal static DynamicBuildingSystemsEnvelopeV1 Clone(DynamicBuildingSystemsEnvelopeV1 value) => new()
    {
        Schema = value.Schema, ContractManifestHash = value.ContractManifestHash, DocumentFingerprint = value.DocumentFingerprint,
        DocumentSessionId = value.DocumentSessionId, DocumentRevision = value.DocumentRevision, SnapshotHash = value.SnapshotHash,
        RevisionHash = value.RevisionHash, ScopeHash = value.ScopeHash, PageOffset = value.PageOffset, PageSize = value.PageSize,
        TotalCount = value.TotalCount, Facts = value.Facts.Select(Clone).ToArray(), NextCursor = value.NextCursor, EnvelopeHash = value.EnvelopeHash
    };

    internal static DynamicTrustedElementFactV1 Clone(DynamicTrustedElementFactV1 value) => new()
    {
        UniqueId = value.UniqueId, ElementId = value.ElementId, DocumentFingerprint = value.DocumentFingerprint,
        CategoryStableId = value.CategoryStableId, TypeUniqueId = value.TypeUniqueId, StateHash = value.StateHash,
        Exists = value.Exists, Verified = value.Verified, Visible = value.Visible
    };

    internal static DynamicBuildingSystemsFactV1 Clone(DynamicBuildingSystemsFactV1 value) => new()
    {
        Kind = value.Kind, Element = Clone(value.Element)!, Category = Clone(value.Category), Family = Clone(value.Family), Type = Clone(value.Type),
        Host = Clone(value.Host), Level = Clone(value.Level), Workset = Clone(value.Workset), Location = Clone(value.Location),
        Orientation = Clone(value.Orientation), Curve = Clone(value.Curve), Asset = Clone(value.Asset), System = Clone(value.System), Annotation = Clone(value.Annotation), Tag = Clone(value.Tag),
        Connectors = value.Connectors.Select(Clone).ToArray(), Parameters = value.Parameters.Select(Clone).ToArray()
    };

    private static DynamicBuildingConnectorV1 Clone(DynamicBuildingConnectorV1 value) => new()
    {
        StableWithinSnapshotId = value.StableWithinSnapshotId, Origin = Clone(value.Origin)!, BasisX = Clone(value.BasisX)!, BasisY = Clone(value.BasisY)!, BasisZ = Clone(value.BasisZ)!,
        Domain = value.Domain, ConnectorType = value.ConnectorType, Shape = value.Shape, FlowDirection = value.FlowDirection,
        SystemClassification = value.SystemClassification, RadiusFeet = value.RadiusFeet, HeightFeet = value.HeightFeet, WidthFeet = value.WidthFeet,
        System = Clone(value.System), IsPhysicallyConnected = value.IsPhysicallyConnected,
        ConnectedCounterpartIds = value.ConnectedCounterpartIds.ToArray()
    };

    private static DynamicMepCurveFactV1? Clone(DynamicMepCurveFactV1? value) => value == null ? null : new DynamicMepCurveFactV1
    {
        Start = Clone(value.Start)!, End = Clone(value.End)!, CurveKind = value.CurveKind, Shape = value.Shape, DiameterFeet = value.DiameterFeet,
        HeightFeet = value.HeightFeet, WidthFeet = value.WidthFeet, OffsetFeet = value.OffsetFeet, Slope = value.Slope,
        Level = Clone(value.Level), Type = Clone(value.Type)!, Systems = value.Systems.Select(item => Clone(item)!).ToArray()
    };

    private static DynamicBuildingAssetFactV1? Clone(DynamicBuildingAssetFactV1? value) => value == null ? null : new DynamicBuildingAssetFactV1
    {
        AssetClass = value.AssetClass, Location = Clone(value.Location)!, Orientation = Clone(value.Orientation)!, Family = Clone(value.Family)!,
        Type = Clone(value.Type)!, Host = Clone(value.Host), Level = Clone(value.Level), Workset = Clone(value.Workset)
    };

    private static DynamicBuildingSystemFactV1? Clone(DynamicBuildingSystemFactV1? value) => value == null ? null : new DynamicBuildingSystemFactV1
    {
        Domain = value.Domain, Classification = value.Classification, Type = Clone(value.Type)!, Members = value.Members.Select(item => Clone(item)!).ToArray()
    };

    private static DynamicAnnotationObservationFactV1? Clone(DynamicAnnotationObservationFactV1? value) => value == null ? null : new DynamicAnnotationObservationFactV1
    {
        AnnotationClass = value.AnnotationClass, TextType = Clone(value.TextType)!, OwnerView = Clone(value.OwnerView)!, Text = value.Text, StateHash = value.StateHash
    };

    private static DynamicIndependentTagObservationFactV1? Clone(DynamicIndependentTagObservationFactV1? value) => value == null ? null : new DynamicIndependentTagObservationFactV1
    {
        TagType = Clone(value.TagType)!, TagTypeStateHash = value.TagTypeStateHash, OwnerView = Clone(value.OwnerView)!, OwnerViewStateHash = value.OwnerViewStateHash,
        TaggedTargets = value.TaggedTargets.Select(item => Clone(item)!).ToArray(), HeadPosition = Clone(value.HeadPosition)!, Orientation = value.Orientation,
        HasLeader = value.HasLeader, LeaderEndCondition = value.LeaderEndCondition, LeaderEnd = Clone(value.LeaderEnd), LeaderElbow = Clone(value.LeaderElbow), StateHash = value.StateHash
    };

    private static DynamicStableReferenceV1? Clone(DynamicStableReferenceV1? value) => value == null ? null : new DynamicStableReferenceV1
    {
        Kind = value.Kind, StableId = value.StableId, UniqueId = value.UniqueId, ElementId = value.ElementId, Name = value.Name
    };
    private static DynamicPointV1? Clone(DynamicPointV1? value) => value == null ? null : new DynamicPointV1 { X = value.X, Y = value.Y, Z = value.Z };
    private static DynamicTransformV1? Clone(DynamicTransformV1? value) => value == null ? null : new DynamicTransformV1
    {
        Origin = Clone(value.Origin)!, BasisX = Clone(value.BasisX)!, BasisY = Clone(value.BasisY)!, BasisZ = Clone(value.BasisZ)!
    };
    private static DynamicParameterValueV1 Clone(DynamicParameterValueV1 value) => new()
    {
        Identity = value.Identity, Name = value.Name, StorageKind = value.StorageKind, HasValue = value.HasValue,
        RawString = value.RawString, RawInteger = value.RawInteger, RawDouble = value.RawDouble, RawElementId = value.RawElementId,
        FormattedValue = value.FormattedValue, SpecTypeId = value.SpecTypeId, UnitTypeId = value.UnitTypeId, Scope = value.Scope, Writable = value.Writable
    };
}
