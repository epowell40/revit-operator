using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public sealed class VectorDraftingNativeLayout
    {
        public double paperWidthInches { get; set; }
        public int viewScale { get; set; }
        public int partSize { get; set; }
        public Dictionary<string, string>? fontMap { get; set; }
        public Dictionary<string, int>? lineWeightMap { get; set; }
    }
    public sealed class VectorDraftingNativeStyle
    {
        public int[] color { get; set; } = Array.Empty<int>();
        public int weight { get; set; }
        public double sourceWidthPoints { get; set; }
        public double[] dashInches { get; set; } = Array.Empty<double>();
        public double dashPhaseInches { get; set; }
    }
    public sealed class VectorDraftingNativeSegment
    {
        public string kind { get; set; } = "";
        public double[] start { get; set; } = Array.Empty<double>();
        public double[] end { get; set; } = Array.Empty<double>();
        public double[][]? controlPoints { get; set; }
    }
    public sealed class VectorDraftingNativeEntity
    {
        public string id { get; set; } = "";
        public string sourceId { get; set; } = "";
        public string kind { get; set; } = "";
        public double[][]? points { get; set; }
        public VectorDraftingNativeSegment[][]? loops { get; set; }
        public VectorDraftingNativeStyle? style { get; set; }
        public int[]? fillColor { get; set; }
        public double? radiusInches { get; set; }
        public string? text { get; set; }
        public double[]? anchor { get; set; }
        public double? rotation { get; set; }
        public string? font { get; set; }
        public double? emPoints { get; set; }
        public bool? bold { get; set; }
        public bool? italic { get; set; }
        public double? widthScale { get; set; }
        public double? expectedWidthInches { get; set; }
    }
    public sealed class VectorDraftingNativePlan
    {
        public string schema { get; set; } = "";
        public string sourceSha256 { get; set; } = "";
        public string sourcePlanSha256 { get; set; } = "";
        public string selectionSha256 { get; set; } = "";
        public string nativePlanSha256 { get; set; } = "";
        public string sourceLabel { get; set; } = "";
        public string? sourceSheet { get; set; }
        public int page { get; set; }
        public double[] region { get; set; } = Array.Empty<double>();
        public string coordinateSpace { get; set; } = "";
        public VectorDraftingNativeLayout layout { get; set; } = new VectorDraftingNativeLayout();
        public double paperHeightInches { get; set; }
        public List<VectorDraftingNativeEntity> entities { get; set; } = new List<VectorDraftingNativeEntity>();
        public int partCount { get; set; }
        public int zeroLengthSourceCommands { get; set; }
        public JsonElement omissions { get; set; }
        public string[] limits { get; set; } = Array.Empty<string>();
        public bool nativeWriteAllowed { get; set; }
    }
    public class VectorDraftingImportRequest
    {
        public string sourcePath { get; set; } = "";
        public string expectedSourceSha256 { get; set; } = "";
        public string nativePlanPath { get; set; } = "";
        public string expectedNativePlanFileSha256 { get; set; } = "";
        public string expectedNativePlanSha256 { get; set; } = "";
        public string viewName { get; set; } = "";
        public int partIndex { get; set; }
        public long? manifestElementId { get; set; }
        public string? expectedImportSnapshotSha256 { get; set; }
        public bool dryRun { get; set; }
        public static VectorDraftingImportRequest Parse(string json)
        {
            VectorDraftingPlanCodec.RequestFields(json, new[] { "sourcePath", "expectedSourceSha256", "nativePlanPath", "expectedNativePlanFileSha256",
                "expectedNativePlanSha256", "viewName", "partIndex", "manifestElementId", "expectedImportSnapshotSha256", "dryRun" });
            var result = JsonSerializer.Deserialize<VectorDraftingImportRequest>(json) ?? throw new ArgumentException("Vector import request required.");
            VectorDraftingPlanCodec.ValidateRequest(result); return result;
        }
    }
    public sealed class VectorDraftingInspectionRequest
    {
        public string action { get; set; } = "inspect";
        public long? manifestElementId { get; set; }
        public int? partIndex { get; set; }
        public int offset { get; set; }
        public int limit { get; set; } = 20;
        public bool includeItems { get; set; }
        public static VectorDraftingInspectionRequest Parse(string json)
        {
            VectorDraftingPlanCodec.RequestFields(json, new[] { "action", "manifestElementId", "partIndex", "offset", "limit", "includeItems" });
            var r = JsonSerializer.Deserialize<VectorDraftingInspectionRequest>(json) ?? throw new ArgumentException("Vector inspection request required.");
            if (r.offset < 0 || r.offset > 100000 || r.limit < 1 || r.limit > 100 || r.partIndex < 0 || r.partIndex > 1999
                || (r.action != "list" && r.action != "inspect") || r.action == "inspect" && (!r.manifestElementId.HasValue || r.manifestElementId <= 0)
                || r.action == "list" && (r.manifestElementId.HasValue || r.partIndex.HasValue || r.includeItems)
                || r.action == "inspect" && (!r.partIndex.HasValue && r.includeItems || !r.includeItems && r.offset != 0))
                throw new ArgumentException("Exact vector manifest, optional partIndex and bounded whole-record page required; list cannot inspect native content.");
            return r;
        }
    }

    /// <summary>Bounded immutable artifact consumption. Source data is not permission to mutate.
    /// The native action owner still authorizes the exact document/view and transaction.</summary>
    public static class VectorDraftingPlanCodec
    {
        public const int MaximumBytes = 64 * 1024 * 1024;
        public static string Hash(byte[] bytes)
        { using var sha = SHA256.Create(); return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
        public static string Hash(string text) => Hash(Encoding.UTF8.GetBytes(text));
        public static bool IsHash(string? value) => value != null && Regex.IsMatch(value, "^[a-f0-9]{64}$");
        public static void RequestFields(string json, string[] allowed)
        {
            using var parsed = JsonDocument.Parse(json);
            if (parsed.RootElement.ValueKind != JsonValueKind.Object || parsed.RootElement.EnumerateObject().Any(p => !allowed.Contains(p.Name))
                || parsed.RootElement.EnumerateObject().Select(p => p.Name).Distinct().Count() != parsed.RootElement.EnumerateObject().Count())
                throw new ArgumentException("Only explicit vector request fields accepted; duplicate/unknown fields were not ignored.");
        }
        public static byte[] ReadBounded(Stream input, int maximum)
        {
            using var output = new MemoryStream(); var buffer = new byte[8192]; int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            { if (output.Length + count > maximum) throw new InvalidOperationException("Complete vector artifact exceeds bounded read; nothing was truncated."); output.Write(buffer, 0, count); }
            return output.ToArray();
        }
        public static VectorDraftingNativePlan Decode(byte[] packed, string expectedFileSha256, string expectedNativePlanSha256, string expectedSourceSha256)
        {
            if (!IsHash(expectedFileSha256) || !IsHash(expectedNativePlanSha256) || !IsHash(expectedSourceSha256)
                || packed.Length > MaximumBytes || Hash(packed) != expectedFileSha256) throw new ArgumentException("Native vector artifact hash mismatch.");
            using var input = new MemoryStream(packed); using var gzip = new GZipStream(input, CompressionMode.Decompress);
            var json = ReadBounded(gzip, MaximumBytes);
            var plan = JsonSerializer.Deserialize<VectorDraftingNativePlan>(json) ?? throw new ArgumentException("Missing native vector plan.");
            if (plan.nativePlanSha256 != expectedNativePlanSha256 || plan.sourceSha256 != expectedSourceSha256)
                throw new ArgumentException("Native plan/source identity differs from inspected artifact.");
            Validate(plan); return plan;
        }
        public static void Validate(VectorDraftingNativePlan p)
        {
            if (p.schema != "operator.drafting_vector_native_plan.v1" || p.nativeWriteAllowed
                || p.coordinateSpace != "paper inches, right/up, lower-left of selected source region"
                || !IsHash(p.sourceSha256) || !IsHash(p.sourcePlanSha256) || !IsHash(p.selectionSha256) || !IsHash(p.nativePlanSha256)
                || string.IsNullOrWhiteSpace(p.sourceLabel) || p.sourceLabel.Length > 512 || p.page < 1
                || p.region.Length != 4 || p.region.Any(n => !Finite(n)) || p.region[0] >= p.region[2] || p.region[1] >= p.region[3]
                || p.layout == null || !Finite(p.layout.paperWidthInches) || p.layout.paperWidthInches < 1 || p.layout.paperWidthInches > 120
                || p.layout.viewScale < 1 || p.layout.viewScale > 1000 || p.layout.partSize < 50 || p.layout.partSize > 1000
                || !Finite(p.paperHeightInches) || p.paperHeightInches <= 0 || p.paperHeightInches > 1000
                || p.entities == null || p.entities.Count < 1 || p.entities.Count > 100000
                || p.partCount != (p.entities.Count + p.layout.partSize - 1) / p.layout.partSize
                || p.zeroLengthSourceCommands < 0 || p.omissions.ValueKind != JsonValueKind.Array)
                throw new ArgumentException("Native vector plan header/layout/partition is invalid.");
            var seen = new HashSet<string>(StringComparer.Ordinal); int vertices = 0;
            void Point(double[]? v)
            { if (v == null || v.Length != 2 || v.Any(n => !Finite(n) || Math.Abs(n) > 1000)) throw new ArgumentException("Finite bounded paper XY required."); vertices++; }
            void Color(int[]? c)
            { if (c == null || c.Length != 3 || c.Any(n => n < 0 || n > 255)) throw new ArgumentException("RGB source color required."); }
            foreach (var e in p.entities)
            {
                if (e == null || string.IsNullOrWhiteSpace(e.id) || e.id.Length > 256 || !seen.Add(e.id)
                    || string.IsNullOrWhiteSpace(e.sourceId) || e.sourceId.Length > 256) throw new ArgumentException("Unique bounded source entity identity required.");
                if (e.kind == "line" || e.kind == "cubic_bezier")
                {
                    if (e.points == null || e.points.Length != (e.kind == "line" ? 2 : 4)) throw new ArgumentException("Ordered source curve controls required.");
                    foreach (var pt in e.points) Point(pt);
                    if (e.style == null) throw new ArgumentException("Source stroke style required.");
                }
                else if (e.kind == "fill")
                {
                    Color(e.fillColor);
                    if (e.loops == null || e.loops.Length < 1 || e.loops.Length > 1000) throw new ArgumentException("Complete fill boundaries required.");
                    foreach (var loop in e.loops)
                    {
                        if (loop == null || loop.Length < 2 || loop.Length > 10000) throw new ArgumentException("Fill loop exceeds complete native bounds.");
                        foreach (var s in loop)
                        {
                            Point(s.start); Point(s.end);
                            if (s.kind == "cubic_bezier")
                            { if (s.controlPoints == null || s.controlPoints.Length != 2) throw new ArgumentException("Fill cubic controls required."); foreach (var pt in s.controlPoints) Point(pt); }
                            else if (s.kind != "line" && s.kind != "close") throw new ArgumentException("Unknown fill boundary kind.");
                        }
                        for (int i = 0; i < loop.Length; i++)
                            if (Math.Abs(loop[i].end[0] - loop[(i + 1) % loop.Length].start[0]) > 1e-8
                                || Math.Abs(loop[i].end[1] - loop[(i + 1) % loop.Length].start[1]) > 1e-8)
                                throw new ArgumentException("Source fill boundaries are not continuously closed.");
                    }
                }
                else if (e.kind == "dot")
                {
                    Point(e.anchor); Color(e.fillColor);
                    var radius = e.radiusInches ?? double.NaN;
                    if (!Finite(radius) || radius <= 0 || radius > 1000
                        || e.anchor!.Any(n => Math.Abs(n) + radius > 1000)
                        || e.points != null || e.loops != null || e.style != null || e.text != null)
                        throw new ArgumentException("Complete finite positive dot circle required without competing geometry or stroke assumptions.");
                }
                else if (e.kind == "text")
                {
                    Point(e.anchor);
                    if (string.IsNullOrWhiteSpace(e.text) || e.text!.Length > 1000000 || string.IsNullOrWhiteSpace(e.font) || e.font!.Length > 128
                        || !Finite(e.rotation ?? double.NaN) || !Finite(e.emPoints ?? double.NaN) || e.emPoints <= 0 || e.emPoints > 500
                        || !Finite(e.widthScale ?? double.NaN) || e.widthScale < .01 || e.widthScale > 100
                        || !Finite(e.expectedWidthInches ?? double.NaN) || e.expectedWidthInches < 0 || e.bold == null || e.italic == null)
                        throw new ArgumentException("Complete source text/font/placement required; no text was truncated.");
                }
                else throw new ArgumentException("Unknown native vector entity kind.");
                if (e.style != null)
                {
                    Color(e.style.color);
                    if (e.style.weight < 1 || e.style.weight > 16 || !Finite(e.style.sourceWidthPoints) || e.style.sourceWidthPoints < 0
                        || e.style.dashInches == null || e.style.dashInches.Length > 100 || e.style.dashInches.Any(n => !Finite(n) || n < 0)
                        || e.style.dashInches.Length > 0 && e.style.dashInches.All(n => n == 0)
                        || e.style.dashPhaseInches != 0) throw new ArgumentException("Unsupported native stroke style/dash phase.");
                }
                if (vertices > 400000) throw new ArgumentException("Complete native vector plan exceeds vertex bound.");
            }
        }
        public static void ValidateRequest(VectorDraftingImportRequest r)
        {
            if (!IsHash(r.expectedSourceSha256) || !IsHash(r.expectedNativePlanFileSha256) || !IsHash(r.expectedNativePlanSha256)
                || r.partIndex < 0 || r.partIndex > 1999 || r.manifestElementId.HasValue && r.manifestElementId.Value <= 0
                || r.expectedImportSnapshotSha256 != null && !IsHash(r.expectedImportSnapshotSha256)
                || string.IsNullOrWhiteSpace(r.viewName) || r.viewName.Trim().Length > 160
                || string.IsNullOrWhiteSpace(r.sourcePath) || r.sourcePath.Length > 520 || string.IsNullOrWhiteSpace(r.nativePlanPath) || r.nativePlanPath.Length > 520)
                throw new ArgumentException("Exact source/native plan hashes, viewName and nonnegative partIndex required.");
            if (r.manifestElementId.HasValue != (r.expectedImportSnapshotSha256 != null))
                throw new ArgumentException("Managed continuation requires exact manifestElementId and current snapshot together.");
        }
        public static string SourceFile(string relative, bool plan)
        {
            string normalized = (relative ?? "").Replace('\\', '/');
            if (!(plan ? Regex.IsMatch(normalized, "^artifacts/drafting-vector/source-[a-f0-9]{64}\\.json\\.gz$")
                : Regex.IsMatch(normalized, "^artifacts/uploads/[^/\\r\\n]+$"))) throw new ArgumentException("Vector source/plan must use the registered workspace artifact namespace.");
            string full = WorkspacePaths.ResolveExistingFileUnderWorkspace(normalized), root = WorkspacePaths.GetWorkspaceRoot();
            for (string? current = full; current != null; current = Path.GetDirectoryName(current))
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0) throw new UnauthorizedAccessException("Vector source/plan cannot traverse a reparse point.");
                if (string.Equals(current.TrimEnd(Path.DirectorySeparatorChar), root.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)) break;
            }
            return full;
        }
        private static bool Finite(double n) => !double.IsNaN(n) && !double.IsInfinity(n);
    }
}
