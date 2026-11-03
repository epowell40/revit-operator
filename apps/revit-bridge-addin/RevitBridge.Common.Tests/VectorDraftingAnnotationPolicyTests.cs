using System;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class VectorDraftingAnnotationPolicyTests
    {
        private static string H => new string('a', 64);
        private static VectorDraftingNativePlan Plan(int count)
        {
            var entities = Enumerable.Range(0, count).SelectMany(i => new[] {
                new VectorDraftingNativeEntity { id = "line-" + i, sourceId = "line-source-" + i, kind = "line", points = new[] { new[] { 0d, 0d }, new[] { 1d, 1d } },
                    style = new VectorDraftingNativeStyle { color = new[] { 0, 0, 0 }, weight = 1, sourceWidthPoints = .24 } },
                new VectorDraftingNativeEntity { id = "text-" + i, sourceId = "text-source-" + i, kind = "text", text = "Exact text " + i, anchor = new[] { 0d, 0d },
                    font = "Arial", rotation = 0, emPoints = 8, widthScale = 1, expectedWidthInches = 1, bold = false, italic = false } }).ToList();
            return new VectorDraftingNativePlan { schema = "operator.drafting_vector_native_plan.v1", sourceSha256 = H, sourcePlanSha256 = H, selectionSha256 = H,
                nativePlanSha256 = H, sourceLabel = "diagram.pdf", page = 1, region = new[] { 0d, 0d, 100d, 100d },
                coordinateSpace = "paper inches, right/up, lower-left of selected source region", layout = new VectorDraftingNativeLayout { paperWidthInches = 10, viewScale = 100, partSize = 50 },
                paperHeightInches = 10, entities = entities, partCount = (entities.Count + 49) / 50, omissions = JsonDocument.Parse("[]").RootElement.Clone() };
        }
        [Fact]
        public void SourceOrderAndCompleteAnnotationCoverageAreDerivedWithoutChangingOriginalPlan()
        {
            var plan = Plan(81); var before = JsonSerializer.Serialize(plan);
            Assert.Equal(3, VectorDraftingAnnotationPolicy.PartCount(plan)); Assert.Equal(4, plan.partCount);
            var parts = Enumerable.Range(0, 3).Select(i => VectorDraftingAnnotationPolicy.Part(plan, i)).ToArray();
            Assert.Equal(new[] { 40, 40, 1 }, parts.Select(p => p.Length));
            Assert.Equal(Enumerable.Range(0, 81).Select(i => "text-" + i), parts.SelectMany(p => p).Select(e => e.id));
            Assert.DoesNotContain(parts.SelectMany(p => p), e => e.kind == "line" || e.kind == "cubic_bezier");
            Assert.Equal(before, JsonSerializer.Serialize(plan));
        }
        [Theory]
        [InlineData(-1)] [InlineData(3)] [InlineData(2000)]
        public void InvalidPartCannotSkipOrFabricateSourceEntities(int index)
            => Assert.Throws<ArgumentOutOfRangeException>(() => VectorDraftingAnnotationPolicy.Part(Plan(81), index));
        [Fact]
        public void FilledBoundariesAndDotsRemainWholeAndInOriginalSourceOrder()
        {
            var plan = Plan(1);
            var corners = new[] { new[] { 0d, 0d }, new[] { 1d, 0d }, new[] { 1d, 1d }, new[] { 0d, 1d } };
            var fill = new VectorDraftingNativeEntity { id = "fill-0", sourceId = "filled-source", kind = "fill", fillColor = new[] { 0, 0, 0 },
                loops = new[] { Enumerable.Range(0, 4).Select(i => new VectorDraftingNativeSegment { kind = "line", start = corners[i], end = corners[(i + 1) % 4] }).ToArray() } };
            var dot = new VectorDraftingNativeEntity { id = "dot-0", sourceId = "dot-source", kind = "dot", anchor = new[] { 1d, 1d }, radiusInches = .01, fillColor = new[] { 0, 0, 0 } };
            plan.entities.Insert(1, fill); plan.entities.Add(dot);
            var part = VectorDraftingAnnotationPolicy.Part(plan, 0);
            Assert.Equal(new[] { "fill-0", "text-0", "dot-0" }, part.Select(e => e.id));
            Assert.Same(fill, part[0]); Assert.Same(dot, part[2]); Assert.Equal(4, part[0].loops![0].Length);
        }
        [Fact]
        public void StrokeOnlySourceCannotMasqueradeAsAnAnnotationTask()
        {
            var p = Plan(1); p.entities.RemoveAll(e => e.kind == "text"); p.partCount = 1;
            Assert.Throws<ArgumentException>(() => VectorDraftingAnnotationPolicy.Entities(p));
        }
        private static string Request(string extra = "") => "{\"sourcePath\":\"artifacts/uploads/diagram.pdf\",\"nativePlanPath\":\"artifacts/drafting-vector/source-" + H
            + ".json.gz\",\"expectedSourceSha256\":\"" + H + "\",\"expectedNativePlanFileSha256\":\"" + H + "\",\"expectedNativePlanSha256\":\"" + H
            + "\",\"viewId\":20,\"expectedViewUniqueId\":\"native-view-20\"" + extra + "}";
        [Fact]
        public void ExactOwnerAndPairedContinuationAreRequiredWithoutCallerSourceSelections()
        {
            var first = VectorDraftingAnnotationRequest.Parse(Request()); Assert.Equal(20, first.viewId);
            var next = VectorDraftingAnnotationRequest.Parse(Request(",\"partIndex\":1,\"manifestElementId\":30,\"expectedImportSnapshotSha256\":\"" + H + "\""));
            Assert.Equal(1, next.partIndex); Assert.Equal(30, next.manifestElementId);
            foreach (var extra in new[] { ",\"partIndex\":1", ",\"manifestElementId\":30", ",\"expectedImportSnapshotSha256\":\"" + H + "\"",
                ",\"selectedEntityIds\":[\"line-0\"]", ",\"viewName\":\"another\"", ",\"viewId\":21", ",\"partIndex\":2000" })
                Assert.Throws<ArgumentException>(() => VectorDraftingAnnotationRequest.Parse(Request(extra)));
            Assert.Throws<ArgumentException>(() => VectorDraftingAnnotationRequest.Parse(Request().Replace("native-view-20", "")));
            Assert.Throws<ArgumentException>(() => VectorDraftingAnnotationRequest.Parse(Request().Replace("\"viewId\":20", "\"viewId\":0")));
        }
    }
}
