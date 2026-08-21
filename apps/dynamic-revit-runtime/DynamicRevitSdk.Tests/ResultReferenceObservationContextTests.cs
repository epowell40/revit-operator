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
        Assert.True(context.BuildingSystemsFacts[0].Connectors[0].IsPhysicallyConnected);
        Assert.Single(context.BuildingSystemsFacts[0].Connectors[0].ConnectedCounterpartIds);

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

    [Fact]
    public void TextNoteObservationCarriesExactTextTypeViewAndStateIntoTrustedContext()
    {
        var state = H("text-note-exact-state"); var type = Ref("type", "text-type", 31); var view = Ref("view", "owner-view", 32);
        var category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_TextNotes", ElementId = -2000300 };
        var observed = new DynamicBuildingSystemsFactV1
        {
            Kind = "text_note", Element = Ref("element", "text-note-a", 30), Category = category, Type = type, Location = Point(4, 5, 0),
            Annotation = new DynamicAnnotationObservationFactV1
            {
                AnnotationClass = "text_note", TextType = type, OwnerView = view, Text = "PANELBOARD - SEE SCHEDULE", StateHash = state
            }
        };
        var selector = new DynamicBuildingSystemsSelectorV1 { ElementUniqueIds = new[] { "text-note-a" }, Kinds = new[] { "text_note" }, PageSize = 1 };
        var page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, Document, "context-session", 7, Snapshot, new[] { observed });
        var trusted = new DynamicTrustedElementFactV1
        {
            UniqueId = "text-note-a", ElementId = 30, DocumentFingerprint = Document,
            CategoryStableId = category.StableId, TypeUniqueId = "text-type", StateHash = state, Exists = true, Verified = true, Visible = true
        };

        var context = new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, page.ScopeHash, new[] { page }, new[] { trusted });

        Assert.Equal("text_note", Assert.Single(context.BuildingSystemsFacts).Kind);
        Assert.Equal("PANELBOARD - SEE SCHEDULE", context.BuildingSystemsFacts[0].Annotation!.Text);
        Assert.Equal("text-type", context.BuildingSystemsFacts[0].Annotation!.TextType.UniqueId);
        Assert.Equal("owner-view", context.BuildingSystemsFacts[0].Annotation!.OwnerView.UniqueId);
        Assert.Equal(state, context.ExternalTarget("text-note-a").ExpectedStateHash);

        trusted.StateHash = H("substituted-state");
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, page.ScopeHash, new[] { page }, new[] { trusted }));
    }

    [Fact]
    public void CreateTagProgramDerivesEveryHostBindingFromObservedNeighborFacts()
    {
        var target = Asset("equipment-a", 11); var tagType = Ref("type", "equipment-tag-type", 51); var ownerView = Ref("view", "electrical-plan", 52);
        var tagCategory = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_ElectricalEquipmentTags", ElementId = -2005000 };
        var head = Point(8, 9, 0); var leaderEnd = Point(6, 7, 0); var leaderElbow = Point(7, 8, 0);
        var observedTag = new DynamicBuildingSystemsFactV1
        {
            Kind = "independent_tag", Element = Ref("element", "neighbor-tag", 50), Category = tagCategory, Type = tagType, Location = head,
            Tag = new DynamicIndependentTagObservationFactV1
            {
                TagType = tagType, TagTypeStateHash = H("tag-type-state"), OwnerView = ownerView, OwnerViewStateHash = H("owner-view-state"),
                TaggedTargets = new[] { target.Element }, HeadPosition = head, Orientation = "horizontal", HasLeader = true, LeaderEndCondition = "Free",
                LeaderEnd = leaderEnd, LeaderElbow = leaderElbow, StateHash = H("neighbor-tag-state")
            }
        };
        var selector = new DynamicBuildingSystemsSelectorV1 { ElementUniqueIds = new[] { "equipment-a", "neighbor-tag" }, Kinds = new[] { "equipment", "independent_tag" }, PageSize = 8 };
        var page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, Document, "context-session", 7, Snapshot, new[] { target, observedTag });
        var trusted = Trusted("equipment-a", 11);
        var context = new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, page.ScopeHash, new[] { page }, new[] { trusted });

        var neighborFact = context.BuildingSystemsFacts.Single(fact => fact.Kind == "independent_tag");
        var neighbor = neighborFact.Tag!; var targetUniqueId = Assert.Single(neighbor.TaggedTargets).UniqueId!;
        var leaderEnabled = neighbor.HasLeader && neighbor.LeaderEnd != null && neighbor.LeaderElbow != null;
        context.Plan.CreateTag(context.ExternalTarget(targetUniqueId), neighbor.OwnerView.UniqueId!, neighbor.OwnerViewStateHash,
            neighbor.TagType.UniqueId!, neighbor.TagTypeStateHash, neighborFact.Category!.StableId, neighbor.HeadPosition, neighbor.Orientation,
            leaderEnabled, leaderEnabled ? neighbor.LeaderElbow : null, leaderEnabled ? neighbor.LeaderEnd : null, "created-tag");
        var node = Assert.Single(context.Plan.Build().Nodes);

        Assert.Equal(neighbor.OwnerView.UniqueId, node.Attributes["view_unique_id"]);
        Assert.Equal(neighbor.OwnerViewStateHash, node.Attributes["expected_view_state_hash"]);
        Assert.Equal(neighbor.TagType.UniqueId, node.Attributes["tag_type_unique_id"]);
        Assert.Equal(neighbor.TagTypeStateHash, node.Attributes["expected_tag_type_state_hash"]);
        Assert.Equal(targetUniqueId, node.Attributes["target_unique_id"]);
        Assert.Equal(neighbor.Orientation, node.Attributes["tag_orientation"]);
        Assert.Equal(neighborFact.Category.StableId, node.Outputs[0].ExpectedCategoryStableId);
    }

    [Fact]
    public void ContextAcceptsCanonicalMultiScopeSetAndRejectsOverlapOrSubstitution()
    {
        var firstSelector = new DynamicBuildingSystemsSelectorV1
        {
            ElementUniqueIds = new[] { "equipment-a" }, Kinds = new[] { "equipment" }, PageSize = 8
        };
        var secondSelector = new DynamicBuildingSystemsSelectorV1
        {
            ElementUniqueIds = new[] { "equipment-b" }, Kinds = new[] { "equipment" }, PageSize = 8
        };
        var first = DynamicBuildingSystemsObservationPolicyV1.BuildPage(firstSelector, Document, "context-session", 7, Snapshot,
            new[] { Asset("equipment-a", 11) });
        var second = DynamicBuildingSystemsObservationPolicyV1.BuildPage(secondSelector, Document, "context-session", 7, Snapshot,
            new[] { Asset("equipment-b", 12) });
        var scopeSet = DynamicResultReferenceObservationSetV1.ScopeSetHash(new[] { first.ScopeHash, second.ScopeHash });
        var context = new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot, scopeSet,
            new[] { second, first }, new[] { Trusted("equipment-a", 11), Trusted("equipment-b", 12) });

        Assert.Equal(2, context.BuildingSystemsFacts.Count);
        Assert.Equal(scopeSet, context.ResultReferenceScopeHash);
        Assert.Equal(DynamicResultReferenceObservationSetV1.RevisionSetHash(new[] { first, second }),
            context.BuildingSystemsRevisionHash);
        Assert.Equal(new[] { first.ScopeHash, second.ScopeHash }.OrderBy(value => value),
            context.BuildingSystemsPages.Select(page => page.ScopeHash));

        var overlapSelector = new DynamicBuildingSystemsSelectorV1
        {
            ElementUniqueIds = new[] { "equipment-a" }, Kinds = new[] { "equipment" },
            ParameterNames = new[] { "Comments" }, PageSize = 8
        };
        var overlap = DynamicBuildingSystemsObservationPolicyV1.BuildPage(overlapSelector, Document, "context-session", 7, Snapshot,
            new[] { Asset("equipment-a", 11) });
        var overlapSet = DynamicResultReferenceObservationSetV1.ScopeSetHash(new[] { first.ScopeHash, overlap.ScopeHash });
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot,
            overlapSet, new[] { first, overlap }, new[] { Trusted("equipment-a", 11) }));
        Assert.Throws<ArgumentException>(() => new DynamicResultReferenceProgramContextV1(Input(), 7, Snapshot,
            H("substituted-scope-set"), new[] { first, second }, Array.Empty<DynamicTrustedElementFactV1>()));
    }

    [Fact]
    public void ObservationDeltaBindsPriorRequestKnownScopesAndOnlyNewCompletePages()
    {
        var selector = new DynamicBuildingSystemsSelectorV1
        {
            ElementUniqueIds = new[] { "equipment-b" }, Kinds = new[] { "equipment" }, PageSize = 8
        };
        var page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, Document, "context-session", 7, Snapshot,
            new[] { Asset("equipment-b", 12) });
        var delta = new DynamicObservationDeltaV1
        {
            TurnIndex = 1, PriorFactRequestHash = H("fact-request"), SnapshotHash = Snapshot,
            DocumentRevision = 7, KnownScopeHashes = new[] { H("known-scope") },
            NewScopeHash = page.ScopeHash, Pages = new[] { page }
        };
        delta.DeltaHash = DynamicObservationDeltaPolicyV1.Hash(delta);
        DynamicObservationDeltaPolicyV1.Validate(delta);

        delta.PriorFactRequestHash = H("substituted-request");
        Assert.Throws<ArgumentException>(() => DynamicObservationDeltaPolicyV1.Validate(delta));
        delta.PriorFactRequestHash = H("fact-request");
        delta.DeltaHash = DynamicObservationDeltaPolicyV1.Hash(delta);
        delta.TurnIndex = 2;
        delta.KnownScopeHashes = new[] { H("known-scope") };
        delta.DeltaHash = DynamicObservationDeltaPolicyV1.Hash(delta);
        Assert.Throws<ArgumentException>(() => DynamicObservationDeltaPolicyV1.Validate(delta));
        delta.TurnIndex = 1;
        delta.KnownScopeHashes = new[] { page.ScopeHash };
        delta.DeltaHash = DynamicObservationDeltaPolicyV1.Hash(delta);
        Assert.Throws<ArgumentException>(() => DynamicObservationDeltaPolicyV1.Validate(delta));
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
            Asset = new DynamicBuildingAssetFactV1 { AssetClass = "equipment", Location = origin, Orientation = transform, Family = family, Type = type },
            Connectors = new[] { new DynamicBuildingConnectorV1 {
                StableWithinSnapshotId = DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, uniqueId, "1"),
                Origin = origin, BasisX = Point(1, 0, 0), BasisY = Point(0, 1, 0), BasisZ = Point(0, 0, 1),
                Domain = "DomainHvac", ConnectorType = "End", Shape = "Round", FlowDirection = "Out",
                SystemClassification = "DuctSystemType=SupplyAir", RadiusFeet = 0.25, IsPhysicallyConnected = true,
                ConnectedCounterpartIds = new[] { DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "counterpart-" + uniqueId, "2") }
            } }
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
