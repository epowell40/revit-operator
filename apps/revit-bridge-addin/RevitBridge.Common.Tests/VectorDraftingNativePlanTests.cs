using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class VectorDraftingNativePlanTests
    {
        private static readonly string H = new string('a', 64);
        private static VectorDraftingNativePlan Plan() => new VectorDraftingNativePlan
        {
            schema = "operator.drafting_vector_native_plan.v1", sourceSha256 = H, sourcePlanSha256 = new string('b', 64),
            selectionSha256 = new string('c', 64), nativePlanSha256 = new string('d', 64), sourceLabel = "original.pdf", page = 1,
            region = new[] { 0d, 0d, 720d, 360d }, coordinateSpace = "paper inches, right/up, lower-left of selected source region",
            layout = new VectorDraftingNativeLayout { paperWidthInches = 10, viewScale = 100, partSize = 50 }, paperHeightInches = 5,
            partCount = 1, omissions = JsonDocument.Parse("[]").RootElement.Clone(),
            entities = { new VectorDraftingNativeEntity { id = "contour:0", sourceId = "contour", kind = "line", points = new[] { new[] { 1d, 1d }, new[] { 2d, 2d } },
                style = new VectorDraftingNativeStyle { color = new[] { 0, 0, 0 }, weight = 2, sourceWidthPoints = .24 } } }
        };
        private static byte[] Pack(VectorDraftingNativePlan plan)
        {
            using var output = new MemoryStream();
            using (var gzip = new GZipStream(output, CompressionMode.Compress, true))
            { var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(plan)); gzip.Write(bytes, 0, bytes.Length); }
            return output.ToArray();
        }
        private static VectorDraftingImportRequest Request() => new VectorDraftingImportRequest { expectedSourceSha256 = H,
            expectedNativePlanSha256 = new string('d', 64), expectedNativePlanFileSha256 = new string('e', 64), viewName = "Copied diagram", partIndex = 0,
            sourcePath = "artifacts/uploads/source.pdf", nativePlanPath = "artifacts/drafting-vector/source-" + H + ".json.gz" };

        [Fact]
        public void CompleteArtifactRoundtripBindsBothFileBytesAndOriginalSource()
        {
            var plan = Plan(); var packed = Pack(plan); var fileHash = VectorDraftingPlanCodec.Hash(packed);
            var decoded = VectorDraftingPlanCodec.Decode(packed, fileHash, plan.nativePlanSha256, plan.sourceSha256);
            Assert.Equal(plan.entities[0].points, decoded.entities[0].points); Assert.Equal("original.pdf", decoded.sourceLabel);
            Assert.False(decoded.nativeWriteAllowed);
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Decode(packed, H, plan.nativePlanSha256, plan.sourceSha256));
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Decode(packed, fileHash, H, plan.sourceSha256));
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Decode(packed, fileHash, plan.nativePlanSha256, new string('f', 64)));
            packed[packed.Length / 2] ^= 1;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Decode(packed, fileHash, plan.nativePlanSha256, plan.sourceSha256));
        }

        [Fact]
        public void ArtifactBoundNeverReturnsTruncatedCoordinatesOrText()
        {
            using var small = new MemoryStream(new byte[] { 1, 2, 3 });
            Assert.Equal(new byte[] { 1, 2, 3 }, VectorDraftingPlanCodec.ReadBounded(small, 3));
            using var tooLarge = new MemoryStream(new byte[] { 1, 2, 3, 4 });
            Assert.Throws<InvalidOperationException>(() => VectorDraftingPlanCodec.ReadBounded(tooLarge, 3));
        }

        [Fact]
        public void ContinuationRequiresExactManifestAndFreshSnapshotTogether()
        {
            var request = Request(); VectorDraftingPlanCodec.ValidateRequest(request);
            request.manifestElementId = 123;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.ValidateRequest(request));
            request.expectedImportSnapshotSha256 = H; VectorDraftingPlanCodec.ValidateRequest(request);
            request.manifestElementId = null;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.ValidateRequest(request));
            request.manifestElementId = 0;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.ValidateRequest(request));
            request.manifestElementId = 123; request.partIndex = -1;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.ValidateRequest(request));
        }

        [Fact]
        public void PartitionAndUniqueSourceEntitiesCannotHideMissingOrRepeatedContent()
        {
            var plan = Plan(); VectorDraftingPlanCodec.Validate(plan);
            plan.entities.Add(plan.entities[0]); Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            plan = Plan(); plan.partCount = 2; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            plan = Plan(); plan.layout.partSize = 1; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            plan = Plan(); plan.nativeWriteAllowed = true; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
        }

        [Fact]
        public void CubicControlsRemainCompleteAndCannotBecomeAnEndpointOnlyReceipt()
        {
            var plan = Plan(); var entity = plan.entities[0]; entity.kind = "cubic_bezier";
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            entity.points = new[] { new[] { 1d, 1d }, new[] { 1d, 3d }, new[] { 2d, 3d }, new[] { 2d, 1d } };
            VectorDraftingPlanCodec.Validate(plan);
            entity.points[1][0] = double.NaN; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
        }

        [Fact]
        public void FillBoundariesMustCloseWithoutDiscardingSourceSegments()
        {
            var plan = Plan(); var e = plan.entities[0]; e.kind = "fill"; e.style = null; e.points = null; e.fillColor = new[] { 255, 255, 255 };
            var vertices = new[] { new[] { 0d, 0d }, new[] { 2d, 0d }, new[] { 2d, 2d }, new[] { 0d, 2d } };
            e.loops = new[] { vertices.Select((p, i) => new VectorDraftingNativeSegment { kind = "line", start = p, end = vertices[(i + 1) % vertices.Length] }).ToArray() };
            VectorDraftingPlanCodec.Validate(plan);
            e.loops[0][3].end = new[] { .01d, 0d };
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
        }

        [Fact]
        public void RoundDotRetainsCompleteCircleAndRejectsMalformedOrCompetingGeometry()
        {
            VectorDraftingNativeEntity Dot(string radius = "0.005", string anchor = "[1,2]", string extra = "")
                => JsonSerializer.Deserialize<VectorDraftingNativeEntity>("{\"id\":\"source-dot\",\"sourceId\":\"contour-dot\",\"kind\":\"dot\",\"anchor\":" + anchor
                    + ",\"radiusInches\":" + radius + ",\"fillColor\":[20,40,60]" + extra + "}")!;
            var plan = Plan(); plan.entities.Clear(); plan.entities.Add(Dot());
            VectorDraftingPlanCodec.Validate(plan);
            var bytes = Pack(plan); var result = VectorDraftingPlanCodec.Decode(bytes, VectorDraftingPlanCodec.Hash(bytes), plan.nativePlanSha256, plan.sourceSha256);
            using var value = JsonDocument.Parse(JsonSerializer.Serialize(result.entities[0]));
            Assert.Equal(.005, value.RootElement.GetProperty("radiusInches").GetDouble());
            Assert.Equal(new[] {1d,2d}, result.entities[0].anchor);
            foreach (var bad in new[] { Dot("0"), Dot("-1"), Dot("null"), Dot("1001"), Dot("0.005", "[1]"),
                Dot("0.005", "[999.999,0]"), Dot(extra:",\"points\":[[1,2],[1,3]]"), Dot(extra:",\"loops\":[]") })
            { plan.entities[0] = bad; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan)); }
        }

        [Fact]
        public void TextRequiresSourcePlacementAndTypographyWithoutTruncation()
        {
            var plan = Plan(); var e = plan.entities[0]; e.kind = "text"; e.style = null; e.points = null;
            e.text = "A complete source note"; e.anchor = new[] { 1d, 1d }; e.rotation = .3; e.font = "Arial"; e.emPoints = 8;
            e.bold = false; e.italic = false; e.widthScale = 1; e.expectedWidthInches = 2;
            VectorDraftingPlanCodec.Validate(plan);
            var decoded = VectorDraftingPlanCodec.Decode(Pack(plan), VectorDraftingPlanCodec.Hash(Pack(plan)), plan.nativePlanSha256, plan.sourceSha256);
            Assert.Equal(e.text, decoded.entities[0].text);
            e.text = new string('x', 1000001); Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            e.text = "Source"; e.widthScale = double.PositiveInfinity; Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
        }

        [Fact]
        public void UnsupportedDashPhaseAndMalformedColorFailBeforeNativeAdmission()
        {
            var plan = Plan(); plan.entities[0].style!.dashPhaseInches = .01;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            plan = Plan(); plan.entities[0].style!.color[0] = 256;
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
            plan = Plan(); plan.entities[0].style!.dashInches = new[] { 0d, 0d };
            Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.Validate(plan));
        }

        [Theory]
        [InlineData("../../outside.pdf", false)]
        [InlineData("C:/outside.pdf", false)]
        [InlineData("artifacts/uploads/nested/other.pdf", false)]
        [InlineData("artifacts/uploads/source.pdf", true)]
        [InlineData("artifacts/drafting-vector/not-immutable.json.gz", true)]
        public void UnregisteredNamespacesCannotSupplyAPlan(string input, bool plan)
            => Assert.Throws<ArgumentException>(() => VectorDraftingPlanCodec.SourceFile(input, plan));

        [Fact]
        public void NativeRequestParsersRejectHiddenFieldsAndIncompleteContinuation()
        {
            var json = JsonSerializer.Serialize(Request()); VectorDraftingImportRequest.Parse(json);
            Assert.Throws<ArgumentException>(() => VectorDraftingImportRequest.Parse(json.TrimEnd('}') + ",\"viewId\":123}"));
            Assert.Throws<ArgumentException>(() => VectorDraftingImportRequest.Parse(json.TrimEnd('}') + ",\"partIndex\":2}"));
            var request = Request(); request.manifestElementId = 123;
            Assert.Throws<ArgumentException>(() => VectorDraftingImportRequest.Parse(JsonSerializer.Serialize(request)));
            request.expectedImportSnapshotSha256 = H; VectorDraftingImportRequest.Parse(JsonSerializer.Serialize(request));
            Assert.Equal(Operator.OperatorActionEffect.Apply, Operator.OperatorApprovalPolicy.GetEffect("POST", "/revit/import-vector-detail", json));
            Assert.Equal(Operator.OperatorActionEffect.Preview, Operator.OperatorApprovalPolicy.GetEffect("POST", "/revit/import-vector-detail", "{\"dryRun\":true}"));
        }

        [Fact]
        public void DiscoverySummaryAndWholeNativeRecordPagesHaveSeparateContracts()
        {
            VectorDraftingInspectionRequest.Parse("{\"action\":\"list\"}");
            VectorDraftingInspectionRequest.Parse("{\"manifestElementId\":123,\"partIndex\":0}");
            VectorDraftingInspectionRequest.Parse("{\"manifestElementId\":123,\"partIndex\":0,\"includeItems\":true,\"offset\":20,\"limit\":5}");
            foreach (var json in new[] { "{\"action\":\"list\",\"manifestElementId\":123}", "{\"manifestElementId\":123,\"includeItems\":true}",
                "{\"manifestElementId\":123,\"offset\":20}", "{\"manifestElementId\":123,\"partIndex\":2000}",
                "{\"manifestElementId\":123,\"limit\":101}", "{\"manifestElementId\":123,\"apply\":true}" })
                Assert.Throws<ArgumentException>(() => VectorDraftingInspectionRequest.Parse(json));
            Assert.Equal(Operator.OperatorActionEffect.Read, Operator.OperatorApprovalPolicy.GetEffect("POST", "/revit/inspect-vector-detail", "{\"manifestElementId\":123}"));
            Assert.Equal(Operator.OperatorActionEffect.Apply, Operator.OperatorApprovalPolicy.GetEffect("POST", "/revit/inspect-vector-detail-other", "{}"));
        }

        [Fact]
        public void ExplicitNativeFontAndPenMappingsSurviveRetainedPlanRoundtrip()
        {
            var plan = Plan(); plan.layout.fontMap = new System.Collections.Generic.Dictionary<string, string> { ["Helvetica"] = "Arial" };
            plan.layout.lineWeightMap = new System.Collections.Generic.Dictionary<string, int> { ["0.24"] = 2 };
            var packed = Pack(plan); var decoded = VectorDraftingPlanCodec.Decode(packed, VectorDraftingPlanCodec.Hash(packed), plan.nativePlanSha256, plan.sourceSha256);
            Assert.Equal("Arial", decoded.layout.fontMap!["Helvetica"]); Assert.Equal(2, decoded.layout.lineWeightMap!["0.24"]);
        }
    }
}
