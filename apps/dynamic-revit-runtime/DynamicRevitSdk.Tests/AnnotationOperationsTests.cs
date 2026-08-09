using RevitOperator.DynamicRevitSdk;
using System.Text.Json;
using Xunit;

namespace DynamicRevitSdk.Tests;

public sealed class AnnotationOperationsTests
{
    private static readonly string Document = H("document");

    [Fact]
    public void Typed_builders_emit_exact_general_result_graph_shapes()
    {
        var builder = new DynamicResultReferenceGraphBuilderV1(H("input"), Document, "session", 7);
        var note = External("note", "category:builtin:OST_TextNotes", "text-type", H("note-state"));
        builder.EditTextNote(note, "Existing\r\nText", "Replacement e\u0301", "text-type", "view");
        var tag = builder.CreateTag(External("target", "category:builtin:OST_Doors", "door-type", H("door-state")), "view", H("view-state"), "tag-type", H("tag-type-state"),
            "category:builtin:OST_DoorTags", Point(1, 2, 0), "horizontal", false, null, null, "primary_tag");
        var graph = builder.Build();

        Assert.Equal(new[] { "edit_text_note", "create_tag" }, graph.Nodes.Select(value => value.Kind));
        Assert.Empty(graph.Nodes[0].Outputs);
        Assert.Single(graph.Nodes[1].Outputs);
        Assert.Single(tag.Outputs);
        Assert.Equal("Existing\nText", graph.Nodes[0].Attributes["expected_text"]);
        Assert.Equal("Replacement é", graph.Nodes[0].Attributes["replacement_text"]);
        DynamicAnnotationOperationPolicyV1.ValidateGraph(graph);
    }

    [Fact]
    public void Malformed_text_tag_topology_and_state_bindings_fail_closed()
    {
        var builder = new DynamicResultReferenceGraphBuilderV1(H("input"), Document, "session", 7);
        Assert.Throws<ArgumentException>(() => builder.EditTextNote(External("note", "category:builtin:OST_TextNotes", "type", H("state")), "old", new string('x', 4097), "type", "view"));
        Assert.Throws<ArgumentException>(() => builder.CreateTag(External("target", "category:builtin:OST_Doors", "type", H("state")), "view", "not-a-hash", "tag-type", H("type"), "category:builtin:OST_DoorTags", Point(0, 0, 0), "horizontal", false, null, null, "tag"));

        builder = new DynamicResultReferenceGraphBuilderV1(H("input"), Document, "session", 7);
        builder.CreateTag(External("target", "category:builtin:OST_Doors", "type", H("state")), "view", H("view"), "tag-type", H("type"), "category:builtin:OST_DoorTags", Point(0, 0, 0), "horizontal", false, null, null, "tag");
        var graph = builder.Build(); var node = graph.Nodes[0];
        node.Attributes = node.Attributes.ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        ((Dictionary<string, string>)node.Attributes)["target_unique_id"] = "substituted";
        Assert.Throws<ArgumentException>(() => DynamicAnnotationOperationPolicyV1.ValidateNode(node));

        builder = new DynamicResultReferenceGraphBuilderV1(H("input"), Document, "session", 7);
        builder.EditTextNote(External("note", "category:builtin:OST_TextNotes", "type", H("state")), "same", "same", "type", "view");
        Assert.Throws<ArgumentException>(() => DynamicAnnotationOperationPolicyV1.ValidateGraph(builder.Build()));
    }

    [Fact]
    public void Readback_hashes_bind_semantic_values_and_preview_identity()
    {
        var value = new DynamicAnnotationOperationReadbackV1
        {
            NodeId = H("node"), Kind = "edit_text_note", SubjectUniqueId = "note", BeforeStateHash = H("before"), AfterStateHash = H("after"),
            Values = new Dictionary<string, string>
            {
                ["element_id"] = "17", ["owner_view_unique_id"] = "view", ["text_before"] = "old", ["text_after"] = "new", ["text_type_unique_id"] = "type"
            }
        };
        value.ReadbackHash = DynamicAnnotationOperationPolicyV1.ReadbackHash(value);
        var baseline = DynamicAnnotationOperationPolicyV1.ReadbackSetHash(new[] { value });
        value.Values = new Dictionary<string, string>
        {
            ["element_id"] = "17", ["owner_view_unique_id"] = "view", ["text_before"] = "old", ["text_after"] = "tampered", ["text_type_unique_id"] = "type"
        };
        Assert.Throws<ArgumentException>(() => DynamicAnnotationOperationPolicyV1.ReadbackSetHash(new[] { value }));
        value.Values = new Dictionary<string, string> { ["text_before"] = "old", ["text_after"] = "new" };
        Assert.Throws<ArgumentException>(() => DynamicAnnotationOperationPolicyV1.ReadbackHash(value));
        Assert.Matches("^sha256:[0-9a-f]{64}$", baseline);
    }

    [Fact]
    public void Annotation_preview_rejects_generic_failed_receipt_as_success_evidence()
    {
        var receipt = new DynamicResultReferenceReceiptV1
        {
            GraphHash = H("graph"), DocumentFingerprint = Document, DocumentSessionId = "session", DocumentRevision = 7,
            Outcome = "preview_rolled_back_verified", RollbackVerified = true
        };
        receipt.ReceiptHash = DynamicResultReferencePolicyV1.ReceiptHash(receipt);
        var preview = new DynamicAnnotationOperationPreviewV1 { ResultReceipt = receipt };
        preview.ReadbackSetHash = DynamicAnnotationOperationPolicyV1.ReadbackSetHash(preview.Readbacks);
        preview.PreviewHash = DynamicAnnotationOperationPolicyV1.PreviewHash(preview);
        DynamicAnnotationOperationPolicyV1.ValidatePreview(preview);

        receipt.Outcome = "failed_rolled_back"; receipt.PartialFailureRolledBack = true; receipt.FailureNodeId = H("node");
        receipt.ReceiptHash = DynamicResultReferencePolicyV1.ReceiptHash(receipt);
        Assert.Throws<ArgumentException>(() => DynamicAnnotationOperationPolicyV1.PreviewHash(preview));
    }

    [Fact]
    public void Manifest_is_immutable_unexposed_and_bound_to_result_reference_contract()
    {
        Assert.Equal(2, DynamicAnnotationOperationManifestV1.All.Count);
        Assert.Equal(new[] { "create_tag", "edit_text_note" }, DynamicAnnotationOperationManifestV1.All.Select(value => value.Kind).Order());
        Assert.All(typeof(DynamicAnnotationOperationDescriptorV1).GetProperties(), property => Assert.Null(property.SetMethod));
        Assert.Matches("^sha256:[0-9a-f]{64}$", DynamicAnnotationOperationManifestV1.ManifestHash);
        Assert.Matches("^sha256:[0-9a-f]{64}$", DynamicAnnotationOperationManifestV1.ContractSurfaceHash);
        var path = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "manifests", "dynamic-revit-annotation-operations.v1.json"));
        using var document = JsonDocument.Parse(File.ReadAllBytes(path));
        Assert.Equal(DynamicAnnotationOperationManifestV1.ManifestHash, document.RootElement.GetProperty("contractManifestHash").GetString());
        Assert.Equal(DynamicAnnotationOperationManifestV1.ContractSurfaceHash, document.RootElement.GetProperty("contractSurfaceHash").GetString());
        Assert.False(document.RootElement.GetProperty("productionExposed").GetBoolean());
        var source = File.ReadAllText(Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "DynamicRevitSdk", "AnnotationOperations.cs")));
        Assert.Contains("TypeName(property.PropertyType)", source);
        Assert.DoesNotContain("property.PropertyType.FullName", source);
    }

    private static DynamicExternalTargetReferenceV1 External(string id, string category, string type, string state) => new()
    { TargetUniqueId = id, TargetElementId = 1, DocumentFingerprint = Document, ExpectedCategoryStableId = category, ExpectedTypeUniqueId = type, ExpectedStateHash = state };
    private static DynamicPointV1 Point(double x, double y, double z) => new() { X = x, Y = y, Z = z };
    private static string H(string value) => DynamicWire.Sha256(value);
}
