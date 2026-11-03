using System;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Derive complete annotation batches from the unchanged original
    /// source plan. Native stroke creation is never part of this representation.</summary>
    public static class VectorDraftingAnnotationPolicy
    {
        public const string Renderer = "operator.vector-drafting-annotations-native.v1";
        public const int PartSize = 40;
        public static VectorDraftingNativeEntity[] Entities(VectorDraftingNativePlan plan)
        {
            VectorDraftingPlanCodec.Validate(plan);
            var selected = plan.entities.Where(e => e.kind == "text" || e.kind == "fill" || e.kind == "dot").ToArray();
            if (selected.Length < 1 || selected.Length > PartSize * 2000)
                throw new ArgumentException("Original source annotation inventory must contain1..80000 complete text/fill/dot entities.");
            return selected;
        }
        public static int PartCount(VectorDraftingNativePlan plan) => (Entities(plan).Length + PartSize - 1) / PartSize;
        public static VectorDraftingNativeEntity[] Part(VectorDraftingNativePlan plan, int index)
        {
            var selected = Entities(plan);
            if (index < 0 || index >= (selected.Length + PartSize - 1) / PartSize)
                throw new ArgumentOutOfRangeException(nameof(index), "Annotation part is outside the complete original source inventory.");
            return selected.Skip(index * PartSize).Take(PartSize).ToArray();
        }
    }
    public sealed class VectorDraftingAnnotationRequest
    {
        public string sourcePath { get; set; } = "";
        public string expectedSourceSha256 { get; set; } = "";
        public string nativePlanPath { get; set; } = "";
        public string expectedNativePlanFileSha256 { get; set; } = "";
        public string expectedNativePlanSha256 { get; set; } = "";
        public long viewId { get; set; }
        public string expectedViewUniqueId { get; set; } = "";
        public int partIndex { get; set; }
        public long? manifestElementId { get; set; }
        public string? expectedImportSnapshotSha256 { get; set; }
        public bool dryRun { get; set; }
        public static VectorDraftingAnnotationRequest Parse(string json)
        {
            VectorDraftingPlanCodec.RequestFields(json, new[] { "sourcePath", "expectedSourceSha256", "nativePlanPath", "expectedNativePlanFileSha256",
                "expectedNativePlanSha256", "viewId", "expectedViewUniqueId", "partIndex", "manifestElementId", "expectedImportSnapshotSha256", "dryRun" });
            var r = JsonSerializer.Deserialize<VectorDraftingAnnotationRequest>(json) ?? throw new ArgumentException("Source annotation request required.");
            if (!VectorDraftingPlanCodec.IsHash(r.expectedSourceSha256) || !VectorDraftingPlanCodec.IsHash(r.expectedNativePlanFileSha256)
                || !VectorDraftingPlanCodec.IsHash(r.expectedNativePlanSha256) || r.viewId <= 0 || string.IsNullOrWhiteSpace(r.expectedViewUniqueId)
                || r.expectedViewUniqueId.Length > 160 || r.partIndex < 0 || r.partIndex > 1999
                || string.IsNullOrWhiteSpace(r.sourcePath) || r.sourcePath.Length > 520 || string.IsNullOrWhiteSpace(r.nativePlanPath) || r.nativePlanPath.Length > 520
                || r.manifestElementId.HasValue && r.manifestElementId <= 0
                || r.expectedImportSnapshotSha256 != null && !VectorDraftingPlanCodec.IsHash(r.expectedImportSnapshotSha256)
                || r.manifestElementId.HasValue != (r.expectedImportSnapshotSha256 != null) || r.partIndex > 0 && !r.manifestElementId.HasValue)
                throw new ArgumentException("Exact original source hashes, native owner view identity and paired continuation manifest/snapshot required.");
            return r;
        }
    }
}
