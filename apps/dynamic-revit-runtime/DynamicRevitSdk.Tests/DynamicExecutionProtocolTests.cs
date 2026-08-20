using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class DynamicExecutionProtocolTests
{
    private static readonly string Document = H("execution-protocol-document");
    private static readonly string Snapshot = H("execution-protocol-snapshot");

    [Fact]
    public void CompletedTraceBindsEveryGraphNodeAndExactObservedFact()
    {
        var context = Context(out var fact, out _, out _);
        var provenance = context.Fact(fact, "connectors[0].origin");
        var operation = context.Plan.AddOperation("create_family_instance", null, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "created", ExpectedCategoryStableId = "category:generic-model", ExpectedTypeUniqueId = "type:generic-model" } },
            new Dictionary<string, string> { ["family_type_identity"] = "type:generic-model", ["placement"] = "1,2,3" });
        context.TraceStep("create-instance", "Create the selected observed instance.", new[] { operation }, new[] { provenance });
        context.Require("one-observed-connector", "create-instance", fact.Connectors.Count == 1,
            "Exactly one observed connector is required.", "cardinality", new[] { provenance });

        var result = context.Complete();

        Assert.Null(result.FactRequest);
        Assert.Equal("completed", result.ExecutionTrace.Outcome);
        Assert.Equal(result.Graph.GraphHash, result.ExecutionTrace.GraphHash);
        Assert.Equal(operation.NodeId, Assert.Single(result.ExecutionTrace.Steps).NodeIds.Single());
        Assert.Equal(provenance.ReferenceHash, result.ExecutionTrace.Steps[0].FactReferences[0].ReferenceHash);
        Assert.True(Assert.Single(result.ExecutionTrace.Assertions).Passed);
        Assert.False(result.ExecutionTrace.AuthorizationGranted);
        DynamicExecutionProtocolV1.ValidateTrace(result.ExecutionTrace, result.Graph, null);

        result.ExecutionTrace.Steps[0].Purpose = "substituted";
        Assert.Throws<ArgumentException>(() => DynamicExecutionProtocolV1.ValidateTrace(result.ExecutionTrace, result.Graph, null));
    }

    [Fact]
    public void TraceRejectsUnboundNodesForwardStepsAndDuplicateNodeBindings()
    {
        var context = Context(out var fact, out _, out _);
        var operation = context.Plan.AddOperation("create_family_instance", null, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "created", ExpectedCategoryStableId = "category:generic-model", ExpectedTypeUniqueId = "type:generic-model" } },
            new Dictionary<string, string> { ["family_type_identity"] = "type:generic-model", ["placement"] = "1,2,3" });
        context.TraceStep("planning-only", "A planning step without an operation.", facts: new[] { context.Fact(fact, "type") });
        Assert.Throws<ArgumentException>(() => context.Complete());

        var forward = Context(out _, out _, out _);
        Assert.Throws<ArgumentException>(() => forward.TraceStep("later", "Invalid forward dependency.", dependsOn: new[] { "missing" }));

        var duplicated = Context(out _, out _, out _);
        var duplicatedOperation = duplicated.Plan.AddOperation("create_family_instance", null, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "created", ExpectedCategoryStableId = "category:generic-model", ExpectedTypeUniqueId = "type:generic-model" } },
            new Dictionary<string, string> { ["family_type_identity"] = "type:generic-model", ["placement"] = "1,2,3" });
        duplicated.TraceStep("first", "First binding.", new[] { duplicatedOperation });
        Assert.Throws<ArgumentException>(() => duplicated.TraceStep("second", "Duplicate binding.", new[] { duplicatedOperation }));
    }

    [Fact]
    public void NeedFactsIsBoundedNonAuthorizingCanonicalAndDefensivelyCloned()
    {
        var context = Context(out _, out var currentScope, out _);
        var selector = new DynamicBuildingSystemsSelectorV1
        {
            CategoryStableIds = new[] { "category:builtin:OST_DuctCurves" }, Kinds = new[] { "mep_curve" },
            ParameterNames = new[] { "Width", "Height" }, PageSize = 32
        };

        var result = context.NeedFacts("duct-details", "Need exact downstream duct geometry and connector facts.", selector);

        Assert.Equal("needs_facts", result.ExecutionTrace.Outcome);
        Assert.Empty(result.Graph.Nodes);
        Assert.NotNull(result.FactRequest);
        Assert.False(result.FactRequest!.AuthorizationGranted);
        Assert.Contains(currentScope, result.FactRequest.KnownScopeHashes);
        Assert.Equal(result.FactRequest.RequestHash, result.ExecutionTrace.FactRequestHash);
        DynamicExecutionProtocolV1.ValidateFactRequest(result.FactRequest);
        DynamicExecutionProtocolV1.ValidateTrace(result.ExecutionTrace, null, result.FactRequest);

        selector.Kinds[0] = "equipment";
        Assert.Equal("mep_curve", result.FactRequest.Selector.Kinds[0]);

        var repeated = new DynamicBuildingSystemsSelectorV1 { ElementUniqueIds = new[] { "equipment-a" }, Kinds = new[] { "equipment" }, PageSize = 8 };
        Assert.Throws<ArgumentException>(() => context.NeedFacts("repeat", "Do not repeat an already supplied scope.", repeated));
        var cursor = new DynamicBuildingSystemsSelectorV1 { Kinds = new[] { "system" }, PageSize = 8, Cursor = "not-a-valid-program-request-cursor" };
        Assert.Throws<ArgumentException>(() => context.NeedFacts("cursor", "Cursor-bearing requests are forbidden.", cursor));
    }

    [Fact]
    public void FailedAssertionCarriesExactRepairCoordinates()
    {
        var context = Context(out var fact, out _, out _);
        var error = Assert.Throws<DynamicProgramAssertionException>(() =>
            context.Require("connector-cardinality", "select-endpoint", fact.Connectors.Count == 2,
                "Expected exactly two compatible connectors.", "cardinality", new[] { context.Fact(fact, "connectors") }));
        Assert.Equal("connector-cardinality", error.AssertionId);
        Assert.Equal("select-endpoint", error.StepId);
        Assert.Equal("cardinality", error.Kind);
    }

    [Fact]
    public void WellFormedButForeignFactProvenanceCannotBeReboundToSuppliedObservations()
    {
        var context = Context(out var fact, out _, out var page);
        var provenance = context.Fact(fact, "connectors[0].origin");
        var operation = context.Plan.AddOperation("create_family_instance", null, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = "created", ExpectedCategoryStableId = "category:generic-model", ExpectedTypeUniqueId = "type:generic-model" } },
            new Dictionary<string, string> { ["family_type_identity"] = "type:generic-model", ["placement"] = "1,2,3" });
        context.TraceStep("create", "Create from a cited observed fact.", new[] { operation }, new[] { provenance });
        var result = context.Complete();

        var forged = result.ExecutionTrace.Steps[0].FactReferences[0];
        forged.SnapshotHash = H("foreign-snapshot");
        forged.ReferenceHash = DynamicExecutionProtocolV1.FactReferenceHash(forged);
        result.ExecutionTrace.TraceHash = DynamicExecutionProtocolV1.TraceHash(result.ExecutionTrace);

        DynamicExecutionProtocolV1.ValidateTrace(result.ExecutionTrace, result.Graph, null);
        Assert.Throws<ArgumentException>(() => DynamicExecutionProtocolV1.ValidateTraceFactReferences(result.ExecutionTrace, new[] { page }));
    }

    private static DynamicResultReferenceProgramContextV1 Context(out DynamicBuildingSystemsFactV1 fact, out string scopeHash,
        out DynamicBuildingSystemsEnvelopeV1 page)
    {
        var element = new DynamicStableReferenceV1 { Kind = "element", StableId = "revit-element:equipment-a", UniqueId = "equipment-a", ElementId = 11 };
        var family = new DynamicStableReferenceV1 { Kind = "family", StableId = "revit-element:family-a", UniqueId = "family-a", ElementId = 12 };
        var type = new DynamicStableReferenceV1 { Kind = "type", StableId = "revit-element:type-a", UniqueId = "type-a", ElementId = 13 };
        var category = new DynamicStableReferenceV1 { Kind = "category", StableId = "category:builtin:OST_MechanicalEquipment", ElementId = -2001140 };
        var origin = new DynamicPointV1 { X = 1, Y = 2, Z = 3 };
        var transform = new DynamicTransformV1
        {
            Origin = origin, BasisX = new DynamicPointV1 { X = 1 }, BasisY = new DynamicPointV1 { Y = 1 }, BasisZ = new DynamicPointV1 { Z = 1 }
        };
        fact = new DynamicBuildingSystemsFactV1
        {
            Kind = "equipment", Element = element, Category = category, Family = family, Type = type, Location = origin, Orientation = transform,
            Asset = new DynamicBuildingAssetFactV1 { AssetClass = "equipment", Location = origin, Orientation = transform, Family = family, Type = type },
            Connectors = new[] { new DynamicBuildingConnectorV1
            {
                StableWithinSnapshotId = DynamicBuildingSystemsObservationPolicyV1.ConnectorStableId(Snapshot, "equipment-a", "1"),
                Origin = origin, BasisX = new DynamicPointV1 { X = 1 }, BasisY = new DynamicPointV1 { Y = 1 }, BasisZ = new DynamicPointV1 { Z = 1 },
                Domain = "DomainHvac", ConnectorType = "End", Shape = "Round", FlowDirection = "Out",
                SystemClassification = "DuctSystemType=SupplyAir", RadiusFeet = 0.25
            } }
        };
        var selector = new DynamicBuildingSystemsSelectorV1 { ElementUniqueIds = new[] { "equipment-a" }, Kinds = new[] { "equipment" }, PageSize = 8 };
        page = DynamicBuildingSystemsObservationPolicyV1.BuildPage(selector, Document, "execution-session", 7, Snapshot, new[] { fact });
        scopeHash = page.ScopeHash;
        var trusted = new DynamicTrustedElementFactV1
        {
            UniqueId = "equipment-a", ElementId = 11, DocumentFingerprint = Document, CategoryStableId = category.StableId,
            TypeUniqueId = "type-a", StateHash = H("equipment-state"), Exists = true, Verified = true, Visible = true
        };
        var input = new DynamicTaskInput { Document = new DynamicDocumentDto { ProjectFingerprint = Document, SessionId = "execution-session" } };
        return new DynamicResultReferenceProgramContextV1(input, 7, Snapshot, page.ScopeHash, new[] { page }, new[] { trusted });
    }

    private static string H(string value) => DynamicWire.Sha256(value);
}
