using RevitOperator.DynamicRevitSdk;
using System.Text.Json;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class CoreOperationsTests
{
    private static readonly byte[] Key = Enumerable.Range(1, 32).Select(value => (byte)value).ToArray();
    private const long Now = 2_000_000_000;

    [Fact]
    public void TypedBuildersHaveExactVersionedCanonicalGoldenIdentities()
    {
        var graph = Graph();

        Assert.Equal(new[] { "set_parameter", "rotate_element", "change_type", "delete_element" }, graph.Nodes.Select(node => node.Kind));
        Assert.All(graph.Nodes, node => Assert.Equal(node.NodeId, DynamicOperationGraphV1Admission.NodeId(node)));
        Assert.Equal("internal_revit_units", graph.Nodes[0].Attributes["value_semantics"]);
        Assert.Equal("double", graph.Nodes[0].Attributes["expected_storage_kind"]);
        Assert.Equal("sha256:54ccd5547e936917e79bff795bf1b1ba914d528a72f42a03e5711c2d1093d4f4", graph.GraphHash);
        Assert.Equal("sha256:f1939b669d6b424fa429c2c43299a02f320d95f4496b1e1d93800e934d4da417", DynamicCoreOperationManifestV1.ManifestHash);
        Assert.Equal("sha256:61e31affc945becb522ed60ae8b49c3770b5a950c53999f9ee1434d957296a19", DynamicCoreOperationManifestV1.ContractSurfaceHash);
    }

    [Fact]
    public void CheckedInPackageManifestBindsContractSurfaceAndPrimitiveRotation()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-operations-core.v1.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        Assert.Equal(DynamicCoreOperationManifestV1.ManifestHash, root.GetProperty("contractManifestHash").GetString());
        Assert.Equal(DynamicCoreOperationManifestV1.ContractSurfaceHash, root.GetProperty("contractSurfaceHash").GetString());
        Assert.Equal(DynamicPrimitiveManifestV1.ManifestHash, root.GetProperty("primitiveManifestHash").GetString());
        Assert.False(root.GetProperty("productionExposed").GetBoolean());
        Assert.Equal(DynamicCoreOperationManifestV1.All.Select(value => value.Kind).Order(), root.GetProperty("primitives").EnumerateArray().Select(value => value.GetProperty("kind").GetString()).Order());
    }

    [Fact]
    public void BuilderCoversEveryTypedParameterStorageWithoutUntypedEscapeHatch()
    {
        var builder = Builder(4);
        builder.SetString("a", "parameter:builtin:1", "instance", "hello", H("a-state"), H("a-param"));
        builder.SetInteger("b", "parameter:builtin:2", "type", -12, H("b-state"), H("b-param"), "b-type");
        builder.SetDoubleInternal("c", "parameter:builtin:3", "instance", 1.25, "autodesk.spec.aec:length-2.0.0", "autodesk.unit.unit:feet-1.0.0", H("c-state"), H("c-param"));
        builder.SetElementId("d", "parameter:builtin:4", "instance", -1, H("d-state"), H("d-param"));
        var nodes = builder.Build().Nodes;

        Assert.Equal(new[] { "string", "integer", "double", "element_id" }, nodes.Select(node => node.Attributes["value_kind"]));
        Assert.Equal(new[] { "hello", "-12", "1.25", "-1" }, nodes.Select(node => node.Attributes["raw_value"]));
        Assert.DoesNotContain(typeof(DynamicCoreOperationGraphBuilderV1).GetMethods(), method => method.Name == "SetParameter");
    }

    [Fact]
    public void AdmissionRequiresSignedManifestImplementedHostAndFreshExactState()
    {
        var graph = Graph(); var budget = Budget(); var context = Context(graph, budget); var binding = Binding(graph, context);
        DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview");

        binding.CoreManifestHash = H("substituted"); binding.Signature = DynamicCoreOperationManifestBindingPolicyV1.Sign(binding, Key);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview"));

        binding = Binding(graph, context); context.TargetStateHashes = context.TargetStateHashes.ToDictionary(pair => pair.Key, pair => pair.Key == "b" ? H("stale") : pair.Value);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview"));
        Assert.All(DynamicCoreOperationManifestV1.All, descriptor => Assert.True(DynamicPrimitiveManifestV1.Find(descriptor.Kind)!.ImplementedByV1Host));
    }

    [Fact]
    public void AdmissionRejectsReplayUnknownExtraMalformedAndForwardDependency()
    {
        var graph = Graph(); var budget = Budget(); var context = Context(graph, budget); var binding = Binding(graph, context);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview", seen.Add);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview", seen.Add));

        var node = Clone(graph.Nodes[0]); ((Dictionary<string, string>)node.Attributes)["surprise"] = "true";
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationAdmissionV1.ValidateNodeShape(node, "preview"));
        node = Clone(graph.Nodes[0]); ((Dictionary<string, string>)node.Attributes)["raw_value"] = "NaN"; ((Dictionary<string, string>)node.Attributes)["value_kind"] = "integer"; ((Dictionary<string, string>)node.Attributes)["expected_storage_kind"] = "integer";
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationAdmissionV1.ValidateNodeShape(node, "preview"));

        var nodes = graph.Nodes.Select(Clone).ToArray(); nodes[0].DependsOn = new[] { nodes[1].NodeId }; nodes[0].NodeId = DynamicOperationGraphV1Admission.NodeId(nodes[0]);
        var invalid = WithNodes(graph, nodes); binding = Binding(invalid, context);
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationAdmissionV1.Validate(invalid, budget, context, binding, Key, Now, "preview"));

        nodes = graph.Nodes.Select(Clone).ToArray(); nodes[1].TargetUniqueIds = new[] { "a" }; ((Dictionary<string, string>)nodes[1].Attributes)["expected_target_state_hash"] = H("a-state"); nodes[1].NodeId = DynamicOperationGraphV1Admission.NodeId(nodes[1]);
        nodes[2].DependsOn = new[] { nodes[1].NodeId }; nodes[2].NodeId = DynamicOperationGraphV1Admission.NodeId(nodes[2]);
        nodes[3].DependsOn = new[] { nodes[2].NodeId }; nodes[3].NodeId = DynamicOperationGraphV1Admission.NodeId(nodes[3]);
        invalid = WithNodes(graph, nodes); binding = Binding(invalid, context);
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationAdmissionV1.Validate(invalid, budget, context, binding, Key, Now, "preview"));
    }

    [Fact]
    public void TypedParameterStateHashBindsRawFormattedSpecUnitScopeAndWritability()
    {
        var value = Parameter(); var baseline = DynamicCoreOperationStateV1.ParameterStateHash(value);
        value.FormattedValue = "1 ft 3 in"; Assert.NotEqual(baseline, DynamicCoreOperationStateV1.ParameterStateHash(value));
        value = Parameter(); value.UnitTypeId = "autodesk.unit.unit:inches-1.0.0"; Assert.NotEqual(baseline, DynamicCoreOperationStateV1.ParameterStateHash(value));
        value = Parameter(); value.Scope = "type"; Assert.NotEqual(baseline, DynamicCoreOperationStateV1.ParameterStateHash(value));
        value = Parameter(); value.Writable = false; Assert.NotEqual(baseline, DynamicCoreOperationStateV1.ParameterStateHash(value));
    }

    [Fact]
    public void ExactEffectsEnforceBlastRadiusAndRollbackEvidence()
    {
        var graph = Graph(); var budget = Budget(); var effects = Effects(graph);
        DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(effects, graph, budget);
        var effectSetHash = DynamicCoreOperationEffectPolicyV1.EffectSetHash(effects);
        var preview = new DynamicCoreOperationPreviewV1
        {
            GraphHash = graph.GraphHash, Effects = effects, EffectSetHash = effectSetHash,
            Readbacks = graph.Nodes.Select((node, index) => Readback(node, index)).ToArray(), RollbackTruth = true
        };
        preview.PreviewHash = DynamicCoreOperationReceiptPolicyV1.PreviewHash(preview);
        DynamicCoreOperationReceiptPolicyV1.ValidateRollback(preview);

        preview.RollbackTruth = false; preview.PreviewHash = DynamicCoreOperationReceiptPolicyV1.PreviewHash(preview);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationReceiptPolicyV1.ValidateRollback(preview));
        budget.MaximumAffectedElements = 5;
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(effects, graph, budget));
        budget.MaximumAffectedElements = 8;
        effects[3].DeletedUniqueIds = new[] { "d" }; effects[3].EffectHash = DynamicCoreOperationEffectPolicyV1.CanonicalHash(effects[3]);
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(effects, graph, budget));
    }

    [Fact]
    public void DeleteIsPreviewOnlyAndCanNeverReceiveApplyAuthorization()
    {
        var graph = Graph(); var context = Context(graph, Budget()); var binding = Binding(graph, context);
        Assert.True(DynamicCoreOperationManifestV1.Find("delete_element")!.PreviewSupported);
        Assert.False(DynamicCoreOperationManifestV1.Find("delete_element")!.ApplySupported);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationAdmissionV1.ValidateNodeShape(graph.Nodes[3], "apply"));
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationApplyAuthorizationPolicyV1.Issue(graph, binding, H("effects"), Now + 60, Key, "auth-1"));

        var applyGraph = WithNodes(graph, graph.Nodes.Take(3).Select(Clone).ToArray()); binding = Binding(applyGraph, context);
        var authorization = DynamicCoreOperationApplyAuthorizationPolicyV1.Issue(applyGraph, binding, H("effects"), Now + 60, Key, "auth-2");
        DynamicCoreOperationApplyAuthorizationPolicyV1.Validate(authorization, applyGraph, binding, H("effects"), Key, Now);
        authorization.EffectSetHash = H("substituted"); authorization.Signature = DynamicCoreOperationApplyAuthorizationPolicyV1.Sign(authorization, Key);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationApplyAuthorizationPolicyV1.Validate(authorization, applyGraph, binding, H("effects"), Key, Now));
    }

    [Fact]
    public void DescriptorsAreDeeplyImmutableAndDeleteApplyTruthCannotDrift()
    {
        var manifest = DynamicCoreOperationManifestV1.ManifestHash;
        var descriptor = DynamicCoreOperationManifestV1.Find("delete_element")!;
        Assert.All(typeof(DynamicCoreOperationDescriptorV1).GetProperties(), property => Assert.Null(property.SetMethod));
        Assert.Throws<NotSupportedException>(() => ((IList<string>)descriptor.AllowedAttributes).Add("apply"));
        Assert.Throws<NotSupportedException>(() => ((IList<DynamicCoreOperationDescriptorV1>)DynamicCoreOperationManifestV1.All).Add(descriptor));
        Assert.False(descriptor.ApplySupported);
        Assert.Equal(manifest, DynamicCoreOperationManifestV1.ManifestHash);
    }

    [Fact]
    public void RotationNumbersHaveOneCanonicalWireRepresentation()
    {
        Assert.Equal("0", DynamicCoreOperationCanonicalNumberV1.Format(-0d));
        Assert.Equal("1e20", DynamicCoreOperationCanonicalNumberV1.Format(1e20));
        Assert.Equal(1e20, DynamicCoreOperationCanonicalNumberV1.ParseExact("1e20", "test"));
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationCanonicalNumberV1.ParseExact("-0", "test"));
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationCanonicalNumberV1.ParseExact("1E+20", "test"));

        var node = Clone(Graph().Nodes[1]);
        ((Dictionary<string, string>)node.Attributes)["axis_origin_feet"] = "1.0,2,3";
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationAdmissionV1.ValidateNodeShape(node, "preview"));
    }

    [Fact]
    public void ConnectorSignatureBindsTopologyGeometrySizeAndSystem()
    {
        var baseline = Connector();
        var hash = DynamicCoreOperationStateV1.ConnectorSignature(new[] { baseline });
        Assert.NotEqual(hash, DynamicCoreOperationStateV1.ConnectorSignature(new[] { Connector(originX: 1) }));
        Assert.NotEqual(hash, DynamicCoreOperationStateV1.ConnectorSignature(new[] { Connector(radius: 2) }));
        Assert.NotEqual(hash, DynamicCoreOperationStateV1.ConnectorSignature(new[] { Connector(system: "system-2") }));
        Assert.NotEqual(hash, DynamicCoreOperationStateV1.ConnectorSignature(new[] { Connector(connected: new[] { "owner-2:7" }) }));
    }

    [Fact]
    public void TypeScopedParameterBindsActualMutationOwnerAcrossAdmissionAndEffect()
    {
        var builder = Builder(1);
        builder.SetString("instance", "parameter:builtin:1", "type", "value", H("type-state"), H("parameter-state"), "type-owner");
        var graph = builder.Build(); var budget = Budget();
        budget.ExplicitTargetUniqueIds = new[] { "instance" }; budget.MaximumOperationCount = 1; budget.MaximumModifications = 1; budget.MaximumDeletes = 0;
        var context = Context(graph, budget);
        context.MutationOwnerUniqueIds = new Dictionary<string, string> { ["instance"] = "type-owner" };
        var binding = Binding(graph, context);
        DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview");

        var effect = Effect(graph.Nodes[0], 42, modified: new long[] { 42 });
        effect.PrimaryTargetUniqueId = "type-owner"; effect.EffectHash = DynamicCoreOperationEffectPolicyV1.CanonicalHash(effect);
        DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(new[] { effect }, graph, budget);
        effect.PrimaryTargetUniqueId = "instance"; effect.EffectHash = DynamicCoreOperationEffectPolicyV1.CanonicalHash(effect);
        Assert.Throws<ArgumentException>(() => DynamicCoreOperationEffectPolicyV1.ValidateAgainstGraph(new[] { effect }, graph, budget));

        context.MutationOwnerUniqueIds = new Dictionary<string, string> { ["instance"] = "substituted-type" };
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationAdmissionV1.Validate(graph, budget, context, binding, Key, Now, "preview"));
    }

    [Fact]
    public void ApplyAuthorizationRequiresInjectedAtomicOneUseConsumption()
    {
        var graph = WithNodes(Graph(), Graph().Nodes.Take(3).Select(Clone).ToArray());
        var context = Context(graph, Budget()); var binding = Binding(graph, context);
        var authorization = DynamicCoreOperationApplyAuthorizationPolicyV1.Issue(graph, binding, H("effects"), Now + 60, Key, "auth-once");
        var ledger = new MemoryAuthorizationLedger();
        var first = DynamicCoreOperationApplyAuthorizationPolicyV1.ValidateAndConsume(authorization, graph, binding, H("effects"), Key, Now, ledger);
        Assert.Equal(DynamicCoreOperationApplyAuthorizationPolicyV1.AuthorizationHash(authorization), first);
        Assert.Throws<InvalidOperationException>(() => DynamicCoreOperationApplyAuthorizationPolicyV1.ValidateAndConsume(authorization, graph, binding, H("effects"), Key, Now, ledger));
        Assert.Throws<ArgumentNullException>(() => DynamicCoreOperationApplyAuthorizationPolicyV1.ValidateAndConsume(authorization, graph, binding, H("effects"), Key, Now, null!));
    }

    private static DynamicOperationGraphV1 Graph()
    {
        var builder = Builder(4);
        builder.SetDoubleInternal("a", "parameter:builtin:-100", "instance", 1.25, "autodesk.spec.aec:length-2.0.0", "autodesk.unit.unit:feet-1.0.0", H("a-state"), H("a-param"));
        builder.RotateElement("b", new DynamicPointV1 { X = 1, Y = 2, Z = 3 }, new DynamicPointV1 { Z = 4 }, Math.PI / 2, H("b-state"));
        builder.ChangeType("c", "replacement-type", "category:builtin:OST_MechanicalEquipment", "revit-family:family-1", "revit-family:family-1", H("connectors"), H("c-state"), H("replacement-state"));
        builder.DeleteElementDryRun("d", H("d-state"));
        return builder.Build();
    }

    private static DynamicCoreOperationGraphBuilderV1 Builder(int budget) => new(H("input"), H("document"), 12, budget);
    private static DynamicEffectBudgetV1 Budget() => new()
    {
        BudgetId = "budget-1", TargetDocumentFingerprints = new[] { H("document") }, AllowedCategories = new[] { "category:builtin:OST_MechanicalEquipment" },
        ExplicitTargetUniqueIds = new[] { "a", "b", "c", "d" }, AllowedSdkDomains = new[] { "elements", "parameters" }, AllowedExternalEffectClasses = Array.Empty<string>(),
        ViewScopeHash = H("view"), LevelScopeHash = H("level"), WorksetScopeHash = H("workset"), PhaseScopeHash = H("phase"),
        MaximumOperationCount = 4, MaximumAffectedElements = 8, MaximumCreates = 0, MaximumModifications = 3, MaximumDeletes = 1,
        MaximumExecutionMilliseconds = 5000, MaximumRegenerations = 4, MaximumOutputCount = 0, MaximumOutputBytes = 0, FileCapabilitySetHash = H("files")
    };

    private static DynamicCoreOperationAdmissionContextV1 Context(DynamicOperationGraphV1 graph, DynamicEffectBudgetV1 budget) => new()
    {
        HostAdapterManifestHash = H("host"), TargetCategoryStableIds = graph.Nodes.ToDictionary(node => node.TargetUniqueIds[0], _ => "category:builtin:OST_MechanicalEquipment"),
        TargetStateHashes = graph.Nodes.ToDictionary(node => node.TargetUniqueIds[0], node => node.Attributes["expected_target_state_hash"]),
        MutationOwnerUniqueIds = graph.Nodes.ToDictionary(node => node.TargetUniqueIds[0], node => node.Kind == "set_parameter" ? node.Attributes["expected_parameter_owner_unique_id"] : node.TargetUniqueIds[0]),
        ViewScopeHash = budget.ViewScopeHash, LevelScopeHash = budget.LevelScopeHash, WorksetScopeHash = budget.WorksetScopeHash,
        PhaseScopeHash = budget.PhaseScopeHash, FileCapabilitySetHash = budget.FileCapabilitySetHash, PlannedExecutionMilliseconds = 100, PlannedRegenerations = 4
    };

    private static DynamicCoreOperationManifestBindingV1 Binding(DynamicOperationGraphV1 graph, DynamicCoreOperationAdmissionContextV1 context) =>
        DynamicCoreOperationManifestBindingPolicyV1.Issue(graph, context.HostAdapterManifestHash, Now, Now + 60, Key, "binding-1", H("nonce"));

    private static DynamicCoreOperationEffectV1[] Effects(DynamicOperationGraphV1 graph)
    {
        var values = new[]
        {
            Effect(graph.Nodes[0], 1, modified: new long[] { 1 }), Effect(graph.Nodes[1], 2, modified: new long[] { 2 }),
            Effect(graph.Nodes[2], 3, modified: new long[] { 3 }), Effect(graph.Nodes[3], 4, modified: new long[] { 6 }, deleted: new long[] { 4, 5 }, deletedUniqueIds: new[] { "d", "dependent" })
        };
        foreach (var value in values) value.EffectHash = DynamicCoreOperationEffectPolicyV1.CanonicalHash(value);
        return values;
    }

    private static DynamicCoreOperationEffectV1 Effect(DynamicOperationNodeV1 node, long primary, long[]? modified = null, long[]? deleted = null, string[]? deletedUniqueIds = null) => new()
    {
        NodeId = node.NodeId, Kind = node.Kind, PrimaryTargetElementId = primary,
        PrimaryTargetUniqueId = node.Kind == "set_parameter" ? node.Attributes["expected_parameter_owner_unique_id"] : node.TargetUniqueIds[0], ModifiedElementIds = modified ?? Array.Empty<long>(),
        DeletedElementIds = deleted ?? Array.Empty<long>(), DeletedUniqueIds = deletedUniqueIds ?? Array.Empty<string>()
    };

    private static DynamicCoreOperationReadbackV1 Readback(DynamicOperationNodeV1 node, int index) => new()
    {
        NodeId = node.NodeId, Kind = node.Kind, TargetUniqueId = node.TargetUniqueIds[0], BeforeStateHash = H("before-" + index), AfterStateHash = H("after-" + index),
        Values = new Dictionary<string, string> { ["value"] = index.ToString() }
    };

    private static DynamicParameterValueV1 Parameter() => new()
    {
        Identity = "parameter:builtin:-100", Name = "Length", StorageKind = "double", HasValue = true, RawDouble = 1.25,
        FormattedValue = "1' 3\"", SpecTypeId = "autodesk.spec.aec:length-2.0.0", UnitTypeId = "autodesk.unit.unit:feet-1.0.0", Scope = "instance", Writable = true
    };

    private static DynamicOperationNodeV1 Clone(DynamicOperationNodeV1 node) => new()
    {
        NodeId = node.NodeId, Kind = node.Kind, TargetUniqueIds = node.TargetUniqueIds.ToArray(), DependsOn = node.DependsOn.ToArray(),
        Attributes = node.Attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)
    };

    private static DynamicOperationGraphV1 WithNodes(DynamicOperationGraphV1 source, DynamicOperationNodeV1[] nodes)
    {
        var graph = new DynamicOperationGraphV1 { InputHash = source.InputHash, DocumentFingerprint = source.DocumentFingerprint, DocumentRevision = source.DocumentRevision, Nodes = nodes };
        graph.GraphHash = DynamicOperationGraphV1Admission.GraphHash(graph); return graph;
    }

    private static string H(string value) => DynamicWire.Sha256(value);

    private static DynamicCoreConnectorSignatureEntryV1 Connector(double originX = 0, double? radius = 1, string system = "system-1", string[]? connected = null) =>
        new("owner-1", "connector-1", "DomainHvac", "End", "Round", originX, 0, 0, 0, 0, 1, radius, null, null, system, "type-1", connected ?? new[] { "owner-2:2" });

    private sealed class MemoryAuthorizationLedger : IDynamicCoreOperationApplyAuthorizationLedgerV1
    {
        private readonly HashSet<string> _values = new(StringComparer.Ordinal);
        public bool TryConsume(string authorizationHash) => _values.Add(authorizationHash);
    }
}
