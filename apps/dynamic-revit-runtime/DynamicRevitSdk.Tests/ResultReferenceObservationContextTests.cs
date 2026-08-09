using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class ResultReferenceObservationContextTests
{
    private static readonly string Document = H("context-document");
    private static readonly string Snapshot = H("context-snapshot");

    [Fact]
    public void ContextValidatesCompleteSharedPagesAndExposesOnlyDefensiveCopies()
    {
        var (pages, facts) = ContextData(); var originalPageHash = pages[0].EnvelopeHash; var originalState = facts[0].StateHash;
        var context = new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash, pages, facts);

        Assert.Equal(7, context.ResultReferenceDocumentRevision);
        Assert.Equal(Snapshot, context.ResultReferenceSnapshotHash);
        Assert.Equal(pages[0].ScopeHash, context.ResultReferenceScopeHash);
        Assert.Equal(pages[0].RevisionHash, context.BuildingSystemsRevisionHash);
        Assert.Equal(2, context.BuildingSystemsPages.Count);
        Assert.Equal(2, context.BuildingSystemsFacts.Count);
        Assert.Equal(2, context.TrustedExternalTargets.Count);

        pages[0].EnvelopeHash = H("mutated-source-page"); facts[0].StateHash = H("mutated-source-target");
        var exposedPages = context.BuildingSystemsPages; var exposedTargets = context.TrustedExternalTargets;
        exposedPages[0].EnvelopeHash = H("mutated-exposed-page"); exposedPages[0].Facts[0].Element.UniqueId = "substituted";
        exposedTargets[0].StateHash = H("mutated-exposed-target");
        Assert.Equal(originalPageHash, context.BuildingSystemsPages[0].EnvelopeHash);
        Assert.Equal(originalState, context.TrustedExternalTargets[0].StateHash);
        Assert.Equal("equipment-a", context.BuildingSystemsFacts[0].Element.UniqueId);

        var target = context.ExternalTarget("equipment-a");
        Assert.Equal(11, target.TargetElementId);
        Assert.Equal(originalState, target.ExpectedStateHash);
        Assert.Equal(Document, target.DocumentFingerprint);
    }

    [Fact]
    public void ContextRejectsMixedIncompleteStaleUnobservedAndUnboundedAuthorities()
    {
        var (pages, facts) = ContextData();
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, H("wrong-snapshot"), pages[0].ScopeHash, pages, facts));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, H("wrong-scope"), pages, facts));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 8, Snapshot, pages[0].ScopeHash, pages, facts));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash, new[] { pages[0] }, facts));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash, pages.Reverse(), facts));

        var unobserved = Trusted("not-observed", 99); unobserved.TypeUniqueId = "type";
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash, pages, new[] { unobserved }));
        var hidden = Trusted("equipment-a", 11); hidden.Visible = false;
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash, pages, new[] { hidden }));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, pages[0].ScopeHash,
            Enumerable.Repeat(pages[0], DynamicResultReferenceContractV1.MaximumBuildingSystemsPages + 1), Array.Empty<DynamicTrustedElementFactV1>()));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, "", "", Array.Empty<DynamicBuildingSystemsEnvelopeV1>(), facts));
    }

    private static (DynamicBuildingSystemsEnvelopeV1[] Pages, DynamicTrustedElementFactV1[] Facts) ContextData()
    {
        var observed = new[] { Asset("equipment-a", 11), Asset("equipment-b", 12) };
        var firstSelector = new DynamicBuildingSystemsSelectorV1 { PageSize = 1 };
        var first = DynamicBuildingSystemsObservationPolicyV1.BuildPage(firstSelector, Document, "context-session", 7, Snapshot, observed);
        var second = DynamicBuildingSystemsObservationPolicyV1.BuildPage(new DynamicBuildingSystemsSelectorV1 { PageSize = 1, Cursor = first.NextCursor }, Document, "context-session", 7, Snapshot, observed);
        return (new[] { first, second }, new[] { Trusted("equipment-a", 11), Trusted("equipment-b", 12) });
    }

    private static DynamicBuildingSystemsFactV1 Asset(string uniqueId, long elementId)
    {
        var element = Ref("element", uniqueId, elementId); var family = Ref("family", "family", 20); var type = Ref("type", "type", 21);
        var category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_MechanicalEquipment", ElementId = -2001140 };
        var origin = Point(elementId, 0, 0); var transform = new DynamicTransformV1 { Origin = origin, BasisX = Point(1, 0, 0), BasisY = Point(0, 1, 0), BasisZ = Point(0, 0, 1) };
        return new DynamicBuildingSystemsFactV1
        {
            Kind = "equipment", Element = element, Category = category, Family = family, Type = type, Location = origin, Orientation = transform,
            Asset = new DynamicBuildingAssetFactV1 { AssetClass = "equipment", Location = origin, Orientation = transform, Family = family, Type = type }
        };
    }

    private static DynamicTrustedElementFactV1 Trusted(string uniqueId, long elementId) => new()
    {
        UniqueId = uniqueId, ElementId = elementId, DocumentFingerprint = Document,
        CategoryStableId = "category:builtin:OST_MechanicalEquipment", TypeUniqueId = "type", StateHash = H("state-" + uniqueId),
        Exists = true, Verified = true, Visible = true
    };
    private static DynamicTaskInput Input() => new() { Document = new DynamicDocumentDto { ProjectFingerprint = Document, SessionId = "context-session" } };
    private static DynamicStableReferenceV1 Ref(string kind, string uniqueId, long elementId) => new() { Kind = kind, StableId = "revit-element:" + uniqueId, UniqueId = uniqueId, ElementId = elementId };
    private static DynamicPointV1 Point(double x, double y, double z) => new() { X = x, Y = y, Z = z };
    private static string H(string value) => DynamicWire.Sha256(value);
}
