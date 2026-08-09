using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;

namespace RevitOperator.DynamicRevitSdk;

public static class DynamicAnnotationOperationsV1
{
    public const string ManifestSchema = "dynamic-revit-annotation-operation-manifest/v1";
    public const string ReadbackSchema = "dynamic-revit-annotation-operation-readback/v1";
    public const string PreviewSchema = "dynamic-revit-annotation-operation-preview/v1";
    public const string CanonicalVersion = "dynamic-revit-annotation-operation-canonical/v1";
    public const int MaximumTextLength = 4096;
}

public sealed class DynamicAnnotationOperationDescriptorV1
{
    internal DynamicAnnotationOperationDescriptorV1(string kind, string version, string effect, int externalTargets, int outputs, IEnumerable<string> attributes)
    {
        Kind = kind; PrimitiveVersion = version; EffectClass = effect; ExternalTargetCount = externalTargets; OutputCount = outputs;
        RequiredAttributes = Array.AsReadOnly(attributes.OrderBy(value => value, StringComparer.Ordinal).ToArray());
    }
    public string Kind { get; }
    public string PrimitiveVersion { get; }
    public string EffectClass { get; }
    public int ExternalTargetCount { get; }
    public int OutputCount { get; }
    public IReadOnlyList<string> RequiredAttributes { get; }
}

public static class DynamicAnnotationOperationManifestV1
{
    private static readonly DynamicAnnotationOperationDescriptorV1[] Values =
    {
        new("edit_text_note", "edit_text_note/v1", "modify", 1, 0,
            new[] { "expected_owner_view_unique_id", "expected_text", "expected_text_type_unique_id", "replacement_text" }),
        new("create_tag", "create_tag/v1", "create", 1, 1,
            new[] { "expected_tag_type_state_hash", "expected_view_state_hash", "head_position_feet", "leader_elbow_feet", "leader_enabled", "leader_end_feet", "output_slot", "tag_orientation", "tag_type_unique_id", "target_unique_id", "view_unique_id" })
    };
    private static readonly IReadOnlyList<DynamicAnnotationOperationDescriptorV1> ReadOnly = Array.AsReadOnly(Values);
    private static readonly Type[] Types = { typeof(DynamicAnnotationOperationDescriptorV1), typeof(DynamicAnnotationOperationReadbackV1), typeof(DynamicAnnotationOperationPreviewV1) };
    private static readonly string Surface = DynamicWire.Sha256(string.Join("\n", Types.OrderBy(type => type.FullName, StringComparer.Ordinal).Select(SurfaceOf)));
    private static readonly string Manifest = DynamicWire.Sha256(DynamicCanonical.Join(DynamicAnnotationOperationsV1.ManifestSchema, DynamicAnnotationOperationsV1.ReadbackSchema,
        DynamicAnnotationOperationsV1.PreviewSchema, DynamicAnnotationOperationsV1.CanonicalVersion, DynamicAnnotationOperationsV1.MaximumTextLength.ToString(CultureInfo.InvariantCulture),
        DynamicResultReferenceManifestV1.ManifestHash, Surface, string.Join("\n", Values.OrderBy(value => value.Kind, StringComparer.Ordinal).Select(DescriptorCanonical))));

    public static IReadOnlyList<DynamicAnnotationOperationDescriptorV1> All => ReadOnly;
    public static DynamicAnnotationOperationDescriptorV1? Find(string kind) => Values.FirstOrDefault(value => value.Kind == kind);
    public static string ContractSurfaceHash => Surface;
    public static string ManifestHash => Manifest;
    private static string SurfaceOf(Type type) => type.FullName + "\n" + string.Join("\n", type.GetProperties()
        .Where(property => property.GetMethod?.IsPublic == true && !property.GetMethod.IsStatic)
        .Select(property => property.Name + ":" + property.PropertyType.FullName + (property.SetMethod == null ? ":read-only" : ":read-write"))
        .OrderBy(value => value, StringComparer.Ordinal));
    private static string DescriptorCanonical(DynamicAnnotationOperationDescriptorV1 value) => DynamicCanonical.Join(value.Kind, value.PrimitiveVersion,
        value.EffectClass, value.ExternalTargetCount.ToString(CultureInfo.InvariantCulture), value.OutputCount.ToString(CultureInfo.InvariantCulture), DynamicCanonical.Set(value.RequiredAttributes));
}

public static class DynamicAnnotationResultGraphBuilderV1
{
    public static DynamicResultOperationHandleV1 EditTextNote(this DynamicResultReferenceGraphBuilderV1 builder, DynamicExternalTargetReferenceV1 textNote,
        string expectedText, string replacementText, string expectedTextTypeUniqueId, string expectedOwnerViewUniqueId)
    {
        if (builder == null) throw new ArgumentNullException(nameof(builder));
        return builder.AddOperation("edit_text_note", new[] { textNote }, null, null, new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["expected_text"] = DynamicAnnotationOperationPolicyV1.NormalizeText(expectedText),
            ["replacement_text"] = DynamicAnnotationOperationPolicyV1.NormalizeText(replacementText),
            ["expected_text_type_unique_id"] = Id(expectedTextTypeUniqueId),
            ["expected_owner_view_unique_id"] = Id(expectedOwnerViewUniqueId)
        });
    }

    public static DynamicResultOperationHandleV1 CreateTag(this DynamicResultReferenceGraphBuilderV1 builder, DynamicExternalTargetReferenceV1 target,
        string viewUniqueId, string expectedViewStateHash, string tagTypeUniqueId, string expectedTagTypeStateHash,
        string expectedOutputCategoryStableId, DynamicPointV1 headPositionFeet, string orientation, bool leaderEnabled,
        DynamicPointV1? leaderElbowFeet, DynamicPointV1? leaderEndFeet, string outputSlot)
    {
        if (builder == null) throw new ArgumentNullException(nameof(builder));
        var slot = Id(outputSlot); var type = Id(tagTypeUniqueId);
        return builder.AddOperation("create_tag", new[] { target }, null,
            new[] { new DynamicResultOutputSpecV1 { OutputSlot = slot, ExpectedCategoryStableId = Id(expectedOutputCategoryStableId), ExpectedTypeUniqueId = type } },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                ["target_unique_id"] = Id(target?.TargetUniqueId ?? ""), ["view_unique_id"] = Id(viewUniqueId), ["expected_view_state_hash"] = Hash(expectedViewStateHash),
                ["tag_type_unique_id"] = type, ["expected_tag_type_state_hash"] = Hash(expectedTagTypeStateHash), ["head_position_feet"] = Point(headPositionFeet),
                ["tag_orientation"] = orientation, ["leader_enabled"] = leaderEnabled ? "1" : "0", ["leader_elbow_feet"] = leaderEnabled ? Point(leaderElbowFeet) : "none",
                ["leader_end_feet"] = leaderEnabled ? Point(leaderEndFeet) : "none", ["output_slot"] = slot
            });
    }

    private static string Id(string value) => DynamicCanonical.Id(value, 256) ? value : throw new ArgumentException("Annotation operation identity is invalid or unbounded.");
    private static string Hash(string value) => DynamicCanonical.Hash(value) ? value : throw new ArgumentException("Annotation operation state hash is invalid.");
    private static string Point(DynamicPointV1? value)
    {
        if (value == null || new[] { value.X, value.Y, value.Z }.Any(number => double.IsNaN(number) || double.IsInfinity(number) || Math.Abs(number) > 1e9)) throw new ArgumentException("Annotation operation point is invalid.");
        return DynamicCoreOperationCanonicalNumberV1.Format(value.X) + "," + DynamicCoreOperationCanonicalNumberV1.Format(value.Y) + "," + DynamicCoreOperationCanonicalNumberV1.Format(value.Z);
    }
}

public sealed class DynamicAnnotationOperationReadbackV1
{
    public string Schema { get; set; } = DynamicAnnotationOperationsV1.ReadbackSchema;
    public string NodeId { get; set; } = "";
    public string Kind { get; set; } = "";
    public string SubjectUniqueId { get; set; } = "";
    public string BeforeStateHash { get; set; } = "";
    public string AfterStateHash { get; set; } = "";
    public IReadOnlyDictionary<string, string> Values { get; set; } = new Dictionary<string, string>(StringComparer.Ordinal);
    public string ReadbackHash { get; set; } = "";
}

public sealed class DynamicAnnotationOperationPreviewV1
{
    public string Schema { get; set; } = DynamicAnnotationOperationsV1.PreviewSchema;
    public string ContractManifestHash { get; set; } = DynamicAnnotationOperationManifestV1.ManifestHash;
    public DynamicResultReferenceReceiptV1 ResultReceipt { get; set; } = new();
    public IReadOnlyList<DynamicAnnotationOperationReadbackV1> Readbacks { get; set; } = Array.Empty<DynamicAnnotationOperationReadbackV1>();
    public string ReadbackSetHash { get; set; } = "";
    public string PreviewHash { get; set; } = "";
}

public static class DynamicAnnotationOperationPolicyV1
{
    public static string NormalizeText(string value)
    {
        if (value == null) throw new ArgumentNullException(nameof(value));
        var normalized = value.Replace("\r\n", "\n").Replace('\r', '\n').Normalize(NormalizationForm.FormC);
        if (normalized.Length < 1 || Encoding.UTF8.GetByteCount(normalized) > DynamicAnnotationOperationsV1.MaximumTextLength || normalized.Any(character => character == '\0'))
            throw new ArgumentException("Annotation text is empty, malformed, or unbounded.");
        return normalized;
    }

    public static void ValidateGraph(DynamicResultReferenceGraphV1 graph)
    {
        if (graph == null || graph.ContractManifestHash != DynamicResultReferenceManifestV1.ManifestHash) throw new ArgumentException("Annotation result graph contract is invalid.");
        foreach (var node in graph.Nodes) ValidateNode(node);
    }

    public static void ValidateNode(DynamicResultReferenceNodeV1 node)
    {
        DynamicResultReferencePolicyV1.ValidateNodeShape(node);
        var descriptor = DynamicAnnotationOperationManifestV1.Find(node.Kind) ?? throw new ArgumentException("Unknown annotation result-graph primitive.");
        if (node.ExternalTargets.Count != descriptor.ExternalTargetCount || node.ResultReferences.Count != 0 || node.Outputs.Count != descriptor.OutputCount ||
            node.Attributes.Count != descriptor.RequiredAttributes.Count || node.Attributes.Keys.Any(key => !descriptor.RequiredAttributes.Contains(key, StringComparer.Ordinal)))
            throw new ArgumentException("Annotation primitive targets, outputs, or attributes are not exact.");
        if (node.Kind == "edit_text_note")
        {
            if (NormalizeText(node.Attributes["expected_text"]) != node.Attributes["expected_text"] || NormalizeText(node.Attributes["replacement_text"]) != node.Attributes["replacement_text"] ||
                node.Attributes["expected_text"] == node.Attributes["replacement_text"] ||
                !DynamicCanonical.Id(node.Attributes["expected_text_type_unique_id"], 256) || !DynamicCanonical.Id(node.Attributes["expected_owner_view_unique_id"], 256))
                throw new ArgumentException("edit_text_note text, type, or view precondition is invalid.");
        }
        else
        {
            var external = node.ExternalTargets[0]; var output = node.Outputs[0];
            if (node.Attributes["target_unique_id"] != external.TargetUniqueId || output.OutputSlot != node.Attributes["output_slot"] || output.ExpectedTypeUniqueId != node.Attributes["tag_type_unique_id"] ||
                !DynamicCanonical.Id(node.Attributes["view_unique_id"], 256) || !DynamicCanonical.Hash(node.Attributes["expected_view_state_hash"]) ||
                !DynamicCanonical.Id(node.Attributes["tag_type_unique_id"], 256) || !DynamicCanonical.Hash(node.Attributes["expected_tag_type_state_hash"]) ||
                !new[] { "horizontal", "vertical" }.Contains(node.Attributes["tag_orientation"], StringComparer.Ordinal) ||
                !new[] { "0", "1" }.Contains(node.Attributes["leader_enabled"], StringComparer.Ordinal))
                throw new ArgumentException("create_tag identity, orientation, or binding is invalid.");
            ParsePoint(node.Attributes["head_position_feet"]);
            if (node.Attributes["leader_enabled"] == "1") { ParsePoint(node.Attributes["leader_elbow_feet"]); ParsePoint(node.Attributes["leader_end_feet"]); }
            else if (node.Attributes["leader_elbow_feet"] != "none" || node.Attributes["leader_end_feet"] != "none") throw new ArgumentException("Leader-disabled tag carries leader geometry.");
        }
    }

    public static string ReadbackHash(DynamicAnnotationOperationReadbackV1 value)
    {
        ValidateReadback(value, false);
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.NodeId, value.Kind, value.SubjectUniqueId, value.BeforeStateHash, value.AfterStateHash, DynamicCanonical.Map(value.Values)));
    }
    public static string ReadbackSetHash(IEnumerable<DynamicAnnotationOperationReadbackV1> values)
    {
        var array = (values ?? throw new ArgumentNullException(nameof(values))).ToArray();
        if (array.Length > DynamicResultReferenceContractV1.MaximumNodes || array.Select(value => value.NodeId).Distinct(StringComparer.Ordinal).Count() != array.Length) throw new ArgumentException("Annotation readback set is invalid or duplicated.");
        foreach (var value in array) ValidateReadback(value, true);
        return DynamicWire.Sha256(DynamicCanonical.Join(DynamicAnnotationOperationsV1.ReadbackSchema, DynamicCanonical.Set(array.Select(value => value.ReadbackHash))));
    }
    public static string PreviewHash(DynamicAnnotationOperationPreviewV1 value)
    {
        if (value == null || value.Schema != DynamicAnnotationOperationsV1.PreviewSchema || value.ContractManifestHash != DynamicAnnotationOperationManifestV1.ManifestHash ||
            value.ResultReceipt == null || value.ResultReceipt.ReceiptHash != DynamicResultReferencePolicyV1.ReceiptHash(value.ResultReceipt) || !value.ResultReceipt.RollbackVerified ||
            value.ResultReceipt.Outcome != "preview_rolled_back_verified" || value.ResultReceipt.PartialFailureRolledBack || value.ResultReceipt.FailureNodeId != "" ||
            value.ResultReceipt.Outputs.Any(output => output.Status != "rolled_back_verified" || output.Visible) ||
            value.Readbacks == null || value.ReadbackSetHash != ReadbackSetHash(value.Readbacks)) throw new ArgumentException("Annotation preview is invalid or lacks rollback truth.");
        return DynamicWire.Sha256(DynamicCanonical.Join(value.Schema, value.ContractManifestHash, value.ResultReceipt.ReceiptHash, value.ReadbackSetHash));
    }
    public static void ValidatePreview(DynamicAnnotationOperationPreviewV1 value)
    {
        if (value == null || value.PreviewHash != PreviewHash(value)) throw new InvalidOperationException("Annotation preview hash is invalid.");
    }
    public static void ValidatePreviewAgainstGraph(DynamicAnnotationOperationPreviewV1 value, DynamicResultReferenceGraphV1 graph)
    {
        ValidatePreview(value); ValidateGraph(graph);
        if (graph.GraphHash != DynamicResultReferencePolicyV1.GraphHash(graph) || value.ResultReceipt.GraphHash != graph.GraphHash ||
            value.ResultReceipt.DocumentFingerprint != graph.DocumentFingerprint || value.ResultReceipt.DocumentSessionId != graph.DocumentSessionId ||
            value.ResultReceipt.DocumentRevision != graph.DocumentRevision || value.Readbacks.Count != graph.Nodes.Count)
            throw new InvalidOperationException("Annotation preview is not bound to the exact result graph and document revision.");
        foreach (var node in graph.Nodes)
        {
            var readback = value.Readbacks.SingleOrDefault(item => item.NodeId == node.NodeId)
                ?? throw new InvalidOperationException("Annotation preview lacks an exact node readback.");
            if (readback.Kind != node.Kind || readback.BeforeStateHash != node.ExternalTargets[0].ExpectedStateHash)
                throw new InvalidOperationException("Annotation preview readback kind or pre-state diverged from the graph.");
            if (node.Kind == "edit_text_note")
            {
                if (readback.SubjectUniqueId != node.ExternalTargets[0].TargetUniqueId || readback.Values["text_before"] != node.Attributes["expected_text"] ||
                    readback.Values["text_after"] != node.Attributes["replacement_text"] || readback.Values["text_type_unique_id"] != node.Attributes["expected_text_type_unique_id"] ||
                    readback.Values["owner_view_unique_id"] != node.Attributes["expected_owner_view_unique_id"] || readback.BeforeStateHash == readback.AfterStateHash)
                    throw new InvalidOperationException("edit_text_note readback does not prove the declared exact mutation.");
            }
            else
            {
                var output = node.Outputs.Single();
                var fact = value.ResultReceipt.Outputs.SingleOrDefault(item => item.ProducerNodeId == node.NodeId && item.ResultId == output.ResultId && item.OutputSlot == output.OutputSlot)
                    ?? throw new InvalidOperationException("create_tag preview lacks its one declared output fact.");
                if (readback.SubjectUniqueId != fact.CreatedUniqueId || readback.AfterStateHash != fact.StateHash ||
                    readback.Values["tagged_target_unique_id"] != node.Attributes["target_unique_id"] || readback.Values["owner_view_unique_id"] != node.Attributes["view_unique_id"] ||
                    readback.Values["tag_type_unique_id"] != node.Attributes["tag_type_unique_id"] || readback.Values["head_position_feet"] != node.Attributes["head_position_feet"] ||
                    readback.Values["tag_orientation"] != node.Attributes["tag_orientation"] || readback.Values["leader_enabled"] != node.Attributes["leader_enabled"] ||
                    readback.Values["leader_elbow_feet"] != node.Attributes["leader_elbow_feet"] || readback.Values["leader_end_feet"] != node.Attributes["leader_end_feet"] ||
                    readback.Values["visible"] != "1")
                    throw new InvalidOperationException("create_tag readback does not prove the declared output, target, type, placement, leader, and visibility.");
            }
        }
    }
    public static double[] ParsePoint(string value)
    {
        var parts = value?.Split(',') ?? Array.Empty<string>();
        if (parts.Length != 3) throw new ArgumentException("Annotation point is invalid.");
        var parsed = parts.Select((item, index) => DynamicCoreOperationCanonicalNumberV1.ParseExact(item, "annotation_point[" + index.ToString(CultureInfo.InvariantCulture) + "]")).ToArray();
        if (parsed.Any(number => Math.Abs(number) > 1e9)) throw new ArgumentException("Annotation point exceeds coordinate bounds.");
        return parsed;
    }
    private static void ValidateReadback(DynamicAnnotationOperationReadbackV1 value, bool requireHash)
    {
        if (value == null || value.Schema != DynamicAnnotationOperationsV1.ReadbackSchema || DynamicAnnotationOperationManifestV1.Find(value.Kind) == null ||
            !DynamicCanonical.Hash(value.NodeId) || !DynamicCanonical.Id(value.SubjectUniqueId, 256) || !DynamicCanonical.Hash(value.BeforeStateHash) || !DynamicCanonical.Hash(value.AfterStateHash) ||
            value.Values == null || value.Values.Count > 16 || value.Values.Any(pair => !DynamicCanonical.Id(pair.Key, 128) || pair.Value == null || pair.Value.Length > DynamicAnnotationOperationsV1.MaximumTextLength) ||
            requireHash && value.ReadbackHash != ReadbackHash(value)) throw new ArgumentException("Annotation operation readback is invalid or unbounded.");
        if (value.Kind == "edit_text_note")
        {
            RequireExactKeys(value.Values, "element_id", "owner_view_unique_id", "text_after", "text_before", "text_type_unique_id");
            if (!long.TryParse(value.Values["element_id"], NumberStyles.None, CultureInfo.InvariantCulture, out var elementId) || elementId <= 0 ||
                !DynamicCanonical.Id(value.Values["owner_view_unique_id"], 256) || !DynamicCanonical.Id(value.Values["text_type_unique_id"], 256) ||
                NormalizeText(value.Values["text_before"]) != value.Values["text_before"] || NormalizeText(value.Values["text_after"]) != value.Values["text_after"] ||
                value.Values["text_before"] == value.Values["text_after"] || value.BeforeStateHash == value.AfterStateHash)
                throw new ArgumentException("edit_text_note readback is not an exact mutation.");
        }
        else
        {
            RequireExactKeys(value.Values, "head_position_feet", "leader_elbow_feet", "leader_enabled", "leader_end_feet", "owner_view_unique_id",
                "tag_orientation", "tag_type_unique_id", "tagged_target_unique_id", "visible");
            if (!DynamicCanonical.Id(value.Values["owner_view_unique_id"], 256) || !DynamicCanonical.Id(value.Values["tag_type_unique_id"], 256) ||
                !DynamicCanonical.Id(value.Values["tagged_target_unique_id"], 256) || !new[] { "horizontal", "vertical" }.Contains(value.Values["tag_orientation"], StringComparer.Ordinal) ||
                !new[] { "0", "1" }.Contains(value.Values["leader_enabled"], StringComparer.Ordinal) || value.Values["visible"] != "1")
                throw new ArgumentException("create_tag readback identity, orientation, leader, or visibility is invalid.");
            ParsePoint(value.Values["head_position_feet"]);
            if (value.Values["leader_enabled"] == "1") { ParsePoint(value.Values["leader_elbow_feet"]); ParsePoint(value.Values["leader_end_feet"]); }
            else if (value.Values["leader_elbow_feet"] != "none" || value.Values["leader_end_feet"] != "none") throw new ArgumentException("Leader-disabled tag readback carries leader geometry.");
        }
    }
    private static void RequireExactKeys(IReadOnlyDictionary<string, string> values, params string[] keys)
    {
        if (values.Count != keys.Length || keys.Any(key => !values.ContainsKey(key))) throw new ArgumentException("Annotation readback value fields are not exact.");
    }
}
