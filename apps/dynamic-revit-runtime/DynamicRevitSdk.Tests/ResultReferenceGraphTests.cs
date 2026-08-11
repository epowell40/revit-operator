using RevitOperator.DynamicRevitSdk;
using System.Text.Json;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class ResultReferenceGraphTests
{
    private static readonly string Document = H("document");
    private const string Category = "category:generic-model";
    private const string Type = "type:generic-model-a";

    [Fact]
    public void BuilderProducesDeterministicEarlierResultReferencesAndGoldenIdentities()
    {
        var first = Graph();
        var second = Graph();

        Assert.Equal(first.GraphHash, second.GraphHash);
        Assert.Equal(first.Nodes[0].Outputs[0].ResultId, first.Nodes[1].ResultReferences[0].ResultId);
        Assert.Equal(first.Nodes[0].Outputs[0].OutputSlot, first.Nodes[1].ResultReferences[0].OutputSlot);
        Assert.Equal(new[] { first.Nodes[0].NodeId }, first.Nodes[1].DependsOn);
        Assert.Equal("sha256:0f3c2ab74f7296c3022de84fc50d048f65ffccb8bd7aebbdd31dfa747c2924e9", first.GraphHash);
        Assert.Equal("sha256:03a7a296eb10044416078851fa5f30a3048fda1e50316a9d9ae0785536f97701", DynamicResultReferenceManifestV1.ManifestHash);
        Assert.Equal("sha256:72f6f0015f2796f12befb2f94b3421ca61a8022e94e75ed3790dbef8af73f55d", DynamicResultReferenceManifestV1.ContractSurfaceHash);
    }

    [Fact]
    public void Resolver_refresh_rotates_only_live_state_and_clones_caller_values()
    {
        var graph = Graph();
        var resolver = new DynamicResultReferenceHostResolverV1(graph);
        var producer = graph.Nodes[0];
        var output = Created(producer, producer.Outputs[0], 101);
        output.StateHash = "sha256:" + new string('1', 64);
        output.OutputHash = DynamicResultReferencePolicyV1.OutputHash(output);
        resolver.RegisterSuccessfulOutputs(producer, new[] { output });
        output.StateHash = "sha256:" + new string('2', 64);
        Assert.NotEqual(output.StateHash, resolver.SnapshotSuccessfulOutputs().Single().StateHash);

        var refreshed = resolver.SnapshotSuccessfulOutputs().Single();
        refreshed.StateHash = "sha256:" + new string('3', 64);
        refreshed.OutputHash = DynamicResultReferencePolicyV1.OutputHash(refreshed);
        resolver.RefreshSuccessfulOutputs(new[] { refreshed });
        var resolved = resolver.Resolve(graph.Nodes[1], _ => null).Single();
        Assert.Equal(refreshed.StateHash, resolved.StateHash);

        var substituted = resolver.SnapshotSuccessfulOutputs().Single();
        substituted.CreatedElementId++;
        substituted.OutputHash = DynamicResultReferencePolicyV1.OutputHash(substituted);
        Assert.Throws<InvalidOperationException>(() => resolver.RefreshSuccessfulOutputs(new[] { substituted }));
    }

    [Fact]
    public void CheckedInManifestBindsExactContractAndRemainsUnexposed()
    {
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-result-reference-graph.v1.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        var root = document.RootElement;
        Assert.Equal(DynamicResultReferenceManifestV1.ManifestHash, root.GetProperty("contractManifestHash").GetString());
        Assert.Equal(DynamicResultReferenceManifestV1.ContractSurfaceHash, root.GetProperty("contractSurfaceHash").GetString());
        Assert.False(root.GetProperty("productionExposed").GetBoolean());
    }

    [Fact]
    public void BuilderAndAdmissionRejectUnresolvedForwardCyclicAndDuplicateResults()
    {
        var builder = Builder();
        Assert.Throws<InvalidOperationException>(() => builder.AddOperation("copy_element", null,
            new[] { new DynamicSymbolicResultReferenceV1 { ResultId = H("missing"), OutputSlot = "primary", ExpectedDocumentFingerprint = Document, ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type } },
            Output("copy"), Attributes("transform")));

        var graph = Graph();
        var nodes = graph.Nodes.Select(Clone).ToArray();
        nodes[0].DependsOn = new[] { nodes[1].NodeId };
        nodes[0].NodeId = DynamicResultReferencePolicyV1.NodeId(nodes[0]);
        var invalid = WithNodes(graph, nodes);
        Assert.Throws<ArgumentException>(() => Validate(invalid));

        nodes = graph.Nodes.Select(Clone).ToArray();
        nodes[1].Outputs = new[] { Clone(nodes[0].Outputs[0]) };
        nodes[1].NodeId = DynamicResultReferencePolicyV1.NodeId(nodes[1]);
        invalid = WithNodes(graph, nodes);
        Assert.Throws<ArgumentException>(() => Validate(invalid));
    }

    [Fact]
    public void AdmissionRejectsStaleHiddenUnverifiedAndTypeCategoryDocumentSubstitution()
    {
        var external = External();
        var builder = Builder();
        builder.AddOperation("copy_element", new[] { external }, null, Output("copy"), Attributes("transform"));
        var graph = builder.Build();
        var fact = Trusted(external);

        Validate(graph, new Dictionary<string, DynamicTrustedElementFactV1> { [fact.UniqueId] = fact });
        foreach (var mutation in new Action<DynamicTrustedElementFactV1>[]
        {
            value => value.StateHash = H("stale"), value => value.Verified = false, value => value.Visible = false,
            value => value.CategoryStableId = "category:substituted", value => value.TypeUniqueId = "type:substituted",
            value => value.DocumentFingerprint = H("other-document"), value => value.ElementId++
        })
        {
            var changed = Trusted(external); mutation(changed);
            Assert.Throws<InvalidOperationException>(() => Validate(graph, new Dictionary<string, DynamicTrustedElementFactV1> { [changed.UniqueId] = changed }));
        }
    }

    [Fact]
    public void ResolverRejectsFailedSkippedHiddenUnverifiedAndMismatchedHostOutputs()
    {
        var graph = SingleNodeGraph();
        foreach (var mutation in new Action<DynamicCreatedResultFactV1>[]
        {
            value => value.Status = "failed", value => value.Status = "skipped", value => value.Visible = false,
            value => value.Verified = false, value => value.CategoryStableId = "category:substituted",
            value => value.TypeUniqueId = "type:substituted", value => value.DocumentFingerprint = H("other-document")
        })
        {
            var resolver = new DynamicResultReferenceHostResolverV1(graph);
            var fact = Created(graph.Nodes[0], graph.Nodes[0].Outputs[0], 101); mutation(fact);
            fact.OutputHash = DynamicWire.Sha256("intentionally-not-trusted-after-mutation");
            Assert.ThrowsAny<Exception>(() => resolver.RegisterSuccessfulOutputs(graph.Nodes[0], new[] { fact }));
        }
    }

    [Fact]
    public void ExecutableHostResolvesExactCreatedIdsAndReturnsRollbackReceipt()
    {
        var graph = Graph(); var host = new FakeHost();
        var receipt = DynamicResultReferencePreviewEngineV1.Execute(graph, Budget(), new[] { "create_family_instance", "copy_element" },
            new Dictionary<string, DynamicTrustedElementFactV1>(), _ => null, host);

        Assert.True(host.Began); Assert.True(host.RolledBack);
        Assert.Equal(2, host.Calls.Count);
        Assert.Empty(host.Calls[0].Targets);
        var exact = Assert.Single(host.Calls[1].Targets);
        Assert.Equal("created-primary", exact.UniqueId);
        Assert.Equal(1001, exact.ElementId);
        Assert.Equal("result", exact.SourceKind);
        Assert.Equal("preview_rolled_back_verified", receipt.Outcome);
        Assert.True(receipt.RollbackVerified);
        Assert.Equal(2, receipt.Outputs.Count);
        Assert.All(receipt.Outputs, value => { Assert.Equal("rolled_back_verified", value.Status); Assert.False(value.Visible); });
        Assert.Equal(receipt.ReceiptHash, DynamicResultReferencePolicyV1.ReceiptHash(receipt));
    }

    [Fact]
    public void PartialFailureRollsBackExactPriorIdsAndDoesNotExposeFailedOutput()
    {
        var graph = Graph(); var host = new FakeHost { FailCall = 2 };
        var receipt = DynamicResultReferencePreviewEngineV1.Execute(graph, Budget(), new[] { "create_family_instance", "copy_element" },
            new Dictionary<string, DynamicTrustedElementFactV1>(), _ => null, host);

        Assert.True(host.RolledBack);
        Assert.Equal("failed_rolled_back", receipt.Outcome);
        Assert.True(receipt.PartialFailureRolledBack);
        Assert.Equal(graph.Nodes[1].NodeId, receipt.FailureNodeId);
        var exact = Assert.Single(receipt.Outputs);
        Assert.Equal("created-primary", exact.CreatedUniqueId);
        Assert.Equal(1001, exact.CreatedElementId);
        Assert.Equal("rolled_back_verified", exact.Status);
        Assert.False(exact.Visible);
    }

    [Fact]
    public void RollbackVerificationFailureFailsClosedAndCanonicalMutationsRotateHashes()
    {
        var graph = Graph(); var host = new FakeHost { RollbackResult = false };
        Assert.Throws<InvalidOperationException>(() => DynamicResultReferencePreviewEngineV1.Execute(graph, Budget(),
            new[] { "create_family_instance", "copy_element" }, new Dictionary<string, DynamicTrustedElementFactV1>(), _ => null, host));

        var mutated = Clone(graph.Nodes[0]);
        ((Dictionary<string, string>)mutated.Attributes)["placement"] = "different";
        Assert.NotEqual(graph.Nodes[0].NodeId, DynamicResultReferencePolicyV1.NodeId(mutated));
    }

    [Fact]
    public void CreateBudgetCountsEveryDeclaredOutputAndRejectsDuplicateIdsOrSlots()
    {
        var builder = Builder();
        builder.AddOperation("create_family_instance", null, null,
            new[]
            {
                new DynamicResultOutputSpecV1 { OutputSlot = "primary", ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type },
                new DynamicResultOutputSpecV1 { OutputSlot = "secondary", ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type }
            }, new Dictionary<string, string> { ["family_type_identity"] = Type, ["placement"] = "0,0,0" });
        var graph = builder.Build(); var exact = Budget(); exact.MaximumCreates = 2;
        DynamicResultReferencePolicyV1.Validate(graph, exact, new[] { "create_family_instance" }, new Dictionary<string, DynamicTrustedElementFactV1>());
        exact.MaximumCreates = 1;
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.Validate(graph, exact, new[] { "create_family_instance" }, new Dictionary<string, DynamicTrustedElementFactV1>()));

        var node = Clone(graph.Nodes[0]); var outputs = node.Outputs.Select(Clone).ToArray(); outputs[1].ResultId = outputs[0].ResultId;
        node.Outputs = outputs; Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ValidateNodeShape(node));
        node = Clone(graph.Nodes[0]); outputs = node.Outputs.Select(Clone).ToArray(); outputs[1].OutputSlot = outputs[0].OutputSlot;
        node.Outputs = outputs; Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ValidateNodeShape(node));
    }

    [Fact]
    public void AdmissionCountsModifyDeleteAffectedTargetsAndAuthorizesExternalEffectsExactly()
    {
        var external = External(); var facts = new Dictionary<string, DynamicTrustedElementFactV1> { [external.TargetUniqueId] = Trusted(external) };
        var modifyBuilder = Builder();
        modifyBuilder.AddOperation("move_element", new[] { external }, null, null, new Dictionary<string, string> { ["vector_feet"] = "1,0,0" });
        var modifyBudget = EffectBudget("elements"); modifyBudget.MaximumModifications = 1;
        DynamicResultReferencePolicyV1.Validate(modifyBuilder.Build(), modifyBudget, new[] { "move_element" }, facts);
        modifyBudget.MaximumModifications = 0;
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.Validate(modifyBuilder.Build(), modifyBudget, new[] { "move_element" }, facts));

        var deleteBuilder = Builder(); deleteBuilder.AddOperation("delete_element", new[] { external }, null, null, new Dictionary<string, string>());
        var deleteBudget = EffectBudget("elements"); deleteBudget.MaximumDeletes = 1;
        DynamicResultReferencePolicyV1.Validate(deleteBuilder.Build(), deleteBudget, new[] { "delete_element" }, facts);
        deleteBudget.MaximumDeletes = 0;
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.Validate(deleteBuilder.Build(), deleteBudget, new[] { "delete_element" }, facts));

        var externalBuilder = Builder(); externalBuilder.AddOperation("reload_link", null, null, null,
            new Dictionary<string, string> { ["file_capability_id"] = "capability" });
        var externalBudget = EffectBudget("links"); externalBudget.AllowedExternalEffectClasses = new[] { "reload_link" };
        DynamicResultReferencePolicyV1.Validate(externalBuilder.Build(), externalBudget, new[] { "reload_link" }, new Dictionary<string, DynamicTrustedElementFactV1>());
        externalBudget.AllowedExternalEffectClasses = Array.Empty<string>();
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.Validate(externalBuilder.Build(), externalBudget, new[] { "reload_link" }, new Dictionary<string, DynamicTrustedElementFactV1>()));

        var second = new DynamicExternalTargetReferenceV1 { TargetUniqueId = "existing-b", TargetElementId = 45, DocumentFingerprint = Document,
            ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type, ExpectedStateHash = H("existing-state-b") };
        var twoTargetBuilder = Builder(); twoTargetBuilder.AddOperation("move_element", new[] { external, second }, null, null, new Dictionary<string, string> { ["vector_feet"] = "1,0,0" });
        facts[second.TargetUniqueId] = Trusted(second); modifyBudget = EffectBudget("elements"); modifyBudget.MaximumModifications = 1;
        modifyBudget.ExplicitTargetUniqueIds = new[] { external.TargetUniqueId, second.TargetUniqueId };
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.Validate(twoTargetBuilder.Build(), modifyBudget, new[] { "move_element" }, facts));
    }

    [Fact]
    public void ReceiptHashRejectsContradictoryRollbackOutcomesFlagsAndOutputs()
    {
        var graph = SingleNodeGraph(); var fact = Created(graph.Nodes[0], graph.Nodes[0].Outputs[0], 101);
        fact.Status = "rolled_back_verified"; fact.Visible = false; fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact);
        var receipt = new DynamicResultReferenceReceiptV1
        {
            GraphHash = graph.GraphHash, DocumentFingerprint = Document, DocumentSessionId = "session-1", DocumentRevision = 7,
            Outcome = "preview_rolled_back_verified", RollbackVerified = true, Outputs = new[] { fact }
        };
        Assert.Matches("^sha256:[0-9a-f]{64}$", DynamicResultReferencePolicyV1.ReceiptHash(receipt));

        receipt.PartialFailureRolledBack = true;
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
        receipt.PartialFailureRolledBack = false; receipt.FailureNodeId = H("unexpected-failure");
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
        receipt.FailureNodeId = ""; fact.Status = "created_verified"; fact.Visible = true; fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact);
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
        fact.Status = "rolled_back_verified"; fact.Visible = true; fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact);
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
        fact.Visible = false; fact.OutputHash = DynamicResultReferencePolicyV1.OutputHash(fact);
        receipt.Outcome = "failed_rolled_back"; receipt.PartialFailureRolledBack = false; receipt.FailureNodeId = H("failed-node");
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
        receipt.PartialFailureRolledBack = true; receipt.Outputs = new[] { fact, fact };
        Assert.Throws<ArgumentException>(() => DynamicResultReferencePolicyV1.ReceiptHash(receipt));
    }

    private static DynamicResultReferenceGraphV1 Graph()
    {
        var builder = Builder();
        var created = builder.AddOperation("create_family_instance", null, null, Output("primary"),
            new Dictionary<string, string> { ["family_type_identity"] = Type, ["placement"] = "0,0,0" });
        builder.AddOperation("copy_element", null, new[] { created.Reference("primary") }, Output("copy"), Attributes("transform"));
        return builder.Build();
    }

    private static DynamicResultReferenceGraphV1 SingleNodeGraph()
    {
        var builder = Builder();
        builder.AddOperation("create_family_instance", null, null, Output("primary"),
            new Dictionary<string, string> { ["family_type_identity"] = Type, ["placement"] = "0,0,0" });
        return builder.Build();
    }

    private static DynamicResultReferenceGraphBuilderV1 Builder() => new(H("input"), Document, "session-1", 7);
    private static IReadOnlyList<DynamicResultOutputSpecV1> Output(string slot) => new[] { new DynamicResultOutputSpecV1 { OutputSlot = slot, ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type } };
    private static IReadOnlyDictionary<string, string> Attributes(string required) => new Dictionary<string, string> { [required] = "exact" };
    private static DynamicExternalTargetReferenceV1 External() => new() { TargetUniqueId = "existing-a", TargetElementId = 44, DocumentFingerprint = Document, ExpectedCategoryStableId = Category, ExpectedTypeUniqueId = Type, ExpectedStateHash = H("existing-state") };
    private static DynamicTrustedElementFactV1 Trusted(DynamicExternalTargetReferenceV1 value) => new() { UniqueId = value.TargetUniqueId, ElementId = value.TargetElementId, DocumentFingerprint = value.DocumentFingerprint, CategoryStableId = value.ExpectedCategoryStableId, TypeUniqueId = value.ExpectedTypeUniqueId, StateHash = value.ExpectedStateHash, Exists = true, Verified = true, Visible = true };
    private static DynamicEffectBudgetV1 Budget() => new() { BudgetId = "result-reference-test", TargetDocumentFingerprints = new[] { Document }, AllowedCategories = new[] { Category }, AllowedSdkDomains = new[] { "families", "elements" }, MaximumOperationCount = 4, MaximumAffectedElements = 4, MaximumCreates = 4, MaximumModifications = 0, MaximumDeletes = 0, MaximumOutputCount = 4, FileCapabilitySetHash = H("none") };
    private static DynamicEffectBudgetV1 EffectBudget(string domain) => new() { BudgetId = "result-reference-effect-test", TargetDocumentFingerprints = new[] { Document }, ExplicitTargetUniqueIds = new[] { "existing-a" }, AllowedCategories = new[] { Category }, AllowedSdkDomains = new[] { domain }, MaximumOperationCount = 1, MaximumAffectedElements = 1, MaximumCreates = 0, MaximumModifications = 0, MaximumDeletes = 0, MaximumOutputCount = 1, FileCapabilitySetHash = H("none") };
    private static void Validate(DynamicResultReferenceGraphV1 graph, IReadOnlyDictionary<string, DynamicTrustedElementFactV1>? facts = null) => DynamicResultReferencePolicyV1.Validate(graph, Budget(), new[] { "create_family_instance", "copy_element" }, facts ?? new Dictionary<string, DynamicTrustedElementFactV1>());
    private static string H(string value) => DynamicWire.Sha256(value);

    private static DynamicResultReferenceNodeV1 Clone(DynamicResultReferenceNodeV1 value) => new() { NodeId = value.NodeId, Kind = value.Kind, DependsOn = value.DependsOn.ToArray(), ExternalTargets = value.ExternalTargets.Select(item => new DynamicExternalTargetReferenceV1 { TargetUniqueId = item.TargetUniqueId, TargetElementId = item.TargetElementId, DocumentFingerprint = item.DocumentFingerprint, ExpectedCategoryStableId = item.ExpectedCategoryStableId, ExpectedTypeUniqueId = item.ExpectedTypeUniqueId, ExpectedStateHash = item.ExpectedStateHash }).ToArray(), ResultReferences = value.ResultReferences.Select(item => new DynamicSymbolicResultReferenceV1 { ResultId = item.ResultId, OutputSlot = item.OutputSlot, ExpectedDocumentFingerprint = item.ExpectedDocumentFingerprint, ExpectedCategoryStableId = item.ExpectedCategoryStableId, ExpectedTypeUniqueId = item.ExpectedTypeUniqueId }).ToArray(), Outputs = value.Outputs.Select(Clone).ToArray(), Attributes = value.Attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal) };
    private static DynamicResultOutputDeclarationV1 Clone(DynamicResultOutputDeclarationV1 value) => new() { ResultId = value.ResultId, OutputSlot = value.OutputSlot, ExpectedDocumentFingerprint = value.ExpectedDocumentFingerprint, ExpectedCategoryStableId = value.ExpectedCategoryStableId, ExpectedTypeUniqueId = value.ExpectedTypeUniqueId };
    private static DynamicResultReferenceGraphV1 WithNodes(DynamicResultReferenceGraphV1 source, IReadOnlyList<DynamicResultReferenceNodeV1> nodes) { var value = new DynamicResultReferenceGraphV1 { InputHash = source.InputHash, DocumentFingerprint = source.DocumentFingerprint, DocumentSessionId = source.DocumentSessionId, DocumentRevision = source.DocumentRevision, Nodes = nodes }; value.GraphHash = DynamicResultReferencePolicyV1.GraphHash(value); return value; }

    private static DynamicCreatedResultFactV1 Created(DynamicResultReferenceNodeV1 node, DynamicResultOutputDeclarationV1 output, long elementId)
    {
        var value = new DynamicCreatedResultFactV1 { ProducerNodeId = node.NodeId, ResultId = output.ResultId, OutputSlot = output.OutputSlot, CreatedUniqueId = "created-" + output.OutputSlot, CreatedElementId = elementId, DocumentFingerprint = output.ExpectedDocumentFingerprint, CategoryStableId = output.ExpectedCategoryStableId, TypeUniqueId = output.ExpectedTypeUniqueId, StateHash = H("state-" + output.OutputSlot), Status = "created_verified", Verified = true, Visible = true };
        value.OutputHash = DynamicResultReferencePolicyV1.OutputHash(value); return value;
    }

    private sealed class FakeHost : IDynamicResultReferenceTransactionalHostV1
    {
        public bool Began { get; private set; }
        public bool RolledBack { get; private set; }
        public bool RollbackResult { get; set; } = true;
        public int FailCall { get; set; }
        public List<(DynamicResultReferenceNodeV1 Node, IReadOnlyList<DynamicResolvedElementTargetV1> Targets)> Calls { get; } = new();
        public void Begin(DynamicResultReferenceGraphV1 graph) => Began = true;
        public IReadOnlyList<DynamicCreatedResultFactV1> ExecuteNode(DynamicResultReferenceNodeV1 node, IReadOnlyList<DynamicResolvedElementTargetV1> resolvedTargets)
        {
            Calls.Add((node, resolvedTargets));
            if (Calls.Count == FailCall) throw new InvalidOperationException("injected partial failure");
            return node.Outputs.Select((output, index) => Created(node, output, 1000 + Calls.Count * 1 + index)).ToArray();
        }
        public bool Rollback() { RolledBack = true; return RollbackResult; }
    }
}
