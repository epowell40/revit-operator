using System.Text.Json;
using RevitOperator.DynamicRevitSdk;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class MepResultReferenceOperationsTests
{
    private static readonly string Document = H("document");

    [Fact]
    public void CheckedInManifestIsExactBoundedAndProductionHidden()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-mep-mutations.v1.json"));
        using var json = JsonDocument.Parse(File.ReadAllBytes(path)); var root = json.RootElement;
        Assert.Equal(DynamicMepMutationManifestV1.ManifestHash, root.GetProperty("contractManifestHash").GetString());
        Assert.Equal(DynamicMepMutationManifestV1.ContractSurfaceHash, root.GetProperty("contractSurfaceHash").GetString());
        Assert.Equal(DynamicPrimitiveManifestV1.ManifestHash, root.GetProperty("primitiveManifestHash").GetString());
        Assert.False(root.GetProperty("productionExposed").GetBoolean());
        Assert.Equal(new[] { "connect_mep", "create_elbow_fitting", "create_mep_curve", "create_transition_fitting" }, DynamicMepMutationManifestV1.All.Select(value => value.Kind).Order().ToArray());
        Assert.All(DynamicMepMutationManifestV1.All, value => Assert.True(DynamicPrimitiveManifestV1.Find(value.Kind)!.ImplementedByV1Host));
    }

    [Fact]
    public void BuilderCreatesExactCurveAndLaterConnectorGraph()
    {
        var builder = Builder(); var first = DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(0, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves");
        var second = DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(20, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves");
        DynamicMepResultReferenceBuilderV1.ConnectMep(builder, null, new[] { first.Reference("curve"), second.Reference("curve") },
            Connector(first.Reference("curve"), 10), Connector(second.Reference("curve"), 10));
        var graph = builder.Build(); DynamicMepMutationPolicyV1.ValidateGraphShape(graph);
        Assert.Equal(new[] { "create_mep_curve", "create_mep_curve", "connect_mep" }, graph.Nodes.Select(value => value.Kind));
        Assert.Equal(2, graph.Nodes[2].ResultReferences.Count); Assert.Empty(graph.Nodes[2].Outputs);
    }

    [Fact]
    public void BuilderCreatesExactElbowOutputAndRejectsFittingSubstitution()
    {
        var builder = Builder();
        var first = DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(0, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves");
        var second = DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(20, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves");
        var elbow = DynamicMepResultReferenceBuilderV1.CreateElbowFitting(builder, null, new[] { first.Reference("curve"), second.Reference("curve") },
            Connector(first.Reference("curve"), 10), Connector(second.Reference("curve"), 10), "type:elbow-a", "category:builtin:OST_PipeFitting");
        var graph = builder.Build(); DynamicMepMutationPolicyV1.ValidateGraphShape(graph);
        Assert.Equal("create_elbow_fitting", graph.Nodes[2].Kind);
        Assert.Equal("type:elbow-a", elbow.Reference("fitting").ExpectedTypeUniqueId);

        graph.Nodes[2].Outputs[0].ExpectedTypeUniqueId = "type:substituted";
        Assert.Throws<ArgumentException>(() => DynamicMepMutationPolicyV1.ValidateGraphShape(graph));
    }

    [Fact]
    public void ExactGraphShapeRejectsExtraAttributesAndWrongOutputType()
    {
        var builder = Builder(); DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(0, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves");
        var graph = builder.Build(); var node = graph.Nodes[0];
        node.Attributes = node.Attributes.Concat(new[] { new KeyValuePair<string, string>("fixture_id", "forbidden") }).ToDictionary(value => value.Key, value => value.Value);
        Assert.Throws<ArgumentException>(() => DynamicMepMutationPolicyV1.ValidateGraphShape(graph));
        graph = BuilderGraph(); graph.Nodes[0].Outputs[0].ExpectedTypeUniqueId = "type:substituted";
        Assert.Throws<ArgumentException>(() => DynamicMepMutationPolicyV1.ValidateGraphShape(graph));
    }

    [Fact]
    public void CurveAndConnectorCanonicalFormsRejectNonCanonicalOrUnboundedValues()
    {
        var curve = Curve(0, 10); var canonical = curve.Canonical(); Assert.Equal(canonical, DynamicMepCurveSpecV1.ParseCanonical(canonical).Canonical());
        curve.EndFeet.X = 20000; Assert.Throws<ArgumentException>(() => curve.Validate());
        var selector = new DynamicMepConnectorSelectorV1 { SourceIdentityHash = H("source"), ExpectedOriginFeet = new DynamicPointV1(), ExpectedDomain = "DomainPiping", ExpectedShape = "Round" };
        var encoded = selector.Canonical(); Assert.Equal(encoded, DynamicMepConnectorSelectorV1.ParseCanonical(encoded).Canonical());
        selector.ExpectedDomain = "DomainElectrical"; Assert.Throws<ArgumentException>(() => selector.Validate());
        var round = Round(0.5); Assert.Equal(round.Canonical(), DynamicMepCurveSizeV1.ParseCanonical(round.Canonical()).Canonical());
        round.WidthFeet = 1; Assert.Throws<ArgumentException>(() => round.Validate());
        var rectangular = new DynamicMepCurveSizeV1 { Shape = "Rectangular", WidthFeet = 1, HeightFeet = 0.5 };
        Assert.Equal(rectangular.Canonical(), DynamicMepCurveSizeV1.ParseCanonical(rectangular.Canonical()).Canonical());
    }

    [Fact]
    public void AuthorizationBindsReadbacksTopologyBudgetAndIsDurablyOneUse()
    {
        var budget = Budget(); var preview = Preview(budget); var key = Enumerable.Range(0, 32).Select(value => (byte)value).ToArray();
        var authorization = DynamicMepMutationPolicyV1.IssueAuthorization(preview, budget, 100, 200, key, "authorization-1"); var ledger = new Ledger();
        var hash = DynamicMepMutationPolicyV1.ValidateAndConsumeAuthorization(authorization, preview, budget, 150, key, ledger);
        Assert.StartsWith("sha256:", hash); Assert.Throws<InvalidOperationException>(() => DynamicMepMutationPolicyV1.ValidateAndConsumeAuthorization(authorization, preview, budget, 150, key, ledger));
        authorization.ReadbackSetHash = H("tampered"); Assert.Throws<InvalidOperationException>(() => DynamicMepMutationPolicyV1.ValidateAndConsumeAuthorization(authorization, preview, budget, 150, key, new Ledger()));
        var future = DynamicMepMutationPolicyV1.IssueAuthorization(preview, budget, 500, 600, key, "authorization-future");
        Assert.Throws<InvalidOperationException>(() => DynamicMepMutationPolicyV1.ValidateAndConsumeAuthorization(future, preview, budget, 150, key, new Ledger()));
    }

    [Fact]
    public void PreviewSemanticReceiptContainsNoTemporaryRevitIdsAndReadbackTamperFails()
    {
        var preview = Preview(Budget()); var serialized = JsonSerializer.Serialize(preview);
        Assert.DoesNotContain("CreatedElementId", serialized); Assert.DoesNotContain("CreatedUniqueId", serialized);
        preview.Readbacks[0].AfterStateHash = H("tampered"); Assert.ThrowsAny<Exception>(() => DynamicMepMutationPolicyV1.ValidatePreview(preview, true));
    }

    [Fact]
    public void RevitHostSourceContainsExactPreviewApplySafetyBoundary()
    {
        var host = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicMepResultReferenceMutationHost.cs")));
        var executor = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "revit-bridge-addin", "RevitBridge.Logic", "Handlers", "DynamicRuntime", "DynamicMepResultReferenceExecutor.cs")));
        Assert.Contains("DocumentChanged", host); Assert.Contains("ValidateAndConsumeAuthorization", host); Assert.Contains("group.RollBack()", host); Assert.Contains("group.Assimilate()", host);
        Assert.Contains("DynamicFailureHandlingUtil.ConfigureFailureCapture", host); Assert.Contains("failed without a modal dialog", host);
        Assert.Contains("diverged from preview", host); Assert.Contains("VerifyLiveOutputs", host); Assert.Contains("Pipe.Create", executor); Assert.Contains("Duct.Create", executor);
        Assert.Contains("ConnectTo", executor); Assert.Contains("NewTransitionFitting", executor);
        Assert.Contains("NewElbowFitting", executor);
        Assert.Contains("\"create_elbow_fitting\"", host);
        Assert.Contains("ApplyExactSize", executor); Assert.Contains("Created MEP curve dimensions differ", executor);
        Assert.Contains("mep-result-reference-pair/v1", executor); Assert.DoesNotContain("value.SourceKind + \":\" + value.SourceIdentity", executor);
    }

    private static DynamicMepMutationPreviewV1 Preview(DynamicEffectBudgetV1 budget)
    {
        var graph = BuilderGraph(); var effect = new DynamicMepSemanticEffectV1 { NodeId = graph.Nodes[0].NodeId, Kind = "create_mep_curve", AddedCount = 1,
            AddedCategoryTypeSetHash = H("types"), ModifiedSourceSetHash = H("sources"), TopologyHash = H("node-topology") };
        effect.EffectHash = DynamicMepMutationPolicyV1.SemanticEffectHash(effect);
        var declaration = graph.Nodes[0].Outputs[0]; var output = new DynamicMepSemanticOutputV1 { ProducerNodeId = graph.Nodes[0].NodeId, ResultId = declaration.ResultId,
            OutputSlot = declaration.OutputSlot, CategoryStableId = declaration.ExpectedCategoryStableId, TypeUniqueId = declaration.ExpectedTypeUniqueId, MepStateHash = H("state") };
        output.OutputHash = DynamicMepMutationPolicyV1.SemanticOutputHash(output);
        var readback = new DynamicResultReferenceMutationReadbackV1 { NodeId = graph.Nodes[0].NodeId, Kind = "create_mep_curve", SubjectIdentity = "result:curve",
            BeforeStateHash = H("absent"), AfterStateHash = H("state"), ExactValues = new Dictionary<string, string> { ["length"] = "10" } };
        readback.ReadbackHash = DynamicMepMutationPolicyV1.ReadbackHash(readback);
        var preview = new DynamicMepMutationPreviewV1 { GraphHash = graph.GraphHash, EffectBudgetHash = budget.CanonicalHash(), DocumentFingerprint = Document,
            DocumentSessionId = "session-1", DocumentRevision = 7, Effects = new[] { effect }, Outputs = new[] { output }, Readbacks = new[] { readback },
            SemanticEffectSetHash = DynamicMepMutationPolicyV1.SemanticEffectSetHash(new[] { effect }), SemanticOutputSetHash = DynamicMepMutationPolicyV1.SemanticOutputSetHash(new[] { output }),
            ReadbackSetHash = DynamicMepMutationPolicyV1.ReadbackSetHash(new[] { readback }), TopologyHash = H("topology"), RollbackVerified = true };
        preview.PreviewHash = DynamicMepMutationPolicyV1.PreviewHash(preview); return preview;
    }
    private static DynamicResultReferenceGraphV1 BuilderGraph() { var builder = Builder(); DynamicMepResultReferenceBuilderV1.CreateMepCurve(builder, Curve(0, 10), Round(0.5), "system:piping", "type:pipe-a", "category:builtin:OST_PipeCurves"); return builder.Build(); }
    private static DynamicResultReferenceGraphBuilderV1 Builder() => new(H("input"), Document, "session-1", 7);
    private static DynamicMepCurveSpecV1 Curve(double start, double end) => new() { CurveKind = "pipe", StartFeet = new DynamicPointV1 { X = start }, EndFeet = new DynamicPointV1 { X = end }, LevelUniqueId = "level-1" };
    private static DynamicMepCurveSizeV1 Round(double diameter) => new() { Shape = "Round", DiameterFeet = diameter };
    private static DynamicMepConnectorSelectorV1 Connector(DynamicSymbolicResultReferenceV1 reference, double x) => new() { SourceIdentityHash = H(reference.ResultId + "\n" + reference.OutputSlot), ExpectedOriginFeet = new DynamicPointV1 { X = x }, ExpectedDomain = "DomainPiping", ExpectedShape = "Round" };
    private static DynamicEffectBudgetV1 Budget() => new() { BudgetId = "mep-budget", TargetDocumentFingerprints = new[] { Document }, AllowedCategories = new[] { "category:builtin:OST_PipeCurves" }, AllowedSdkDomains = new[] { "mep" }, MaximumOperationCount = 8, MaximumAffectedElements = 8, MaximumCreates = 4, MaximumModifications = 4, MaximumOutputCount = 4, MaximumRegenerations = 8, FileCapabilitySetHash = H("none") };
    private static string H(string value) => DynamicWire.Sha256(value);
    private sealed class Ledger : IDynamicCoreOperationApplyAuthorizationLedgerV1 { private readonly HashSet<string> _used = new(StringComparer.Ordinal); public bool TryConsume(string authorizationHash) => _used.Add(authorizationHash); }
}
