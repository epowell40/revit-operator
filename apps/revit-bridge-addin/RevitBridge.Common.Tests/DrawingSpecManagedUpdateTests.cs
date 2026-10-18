using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DrawingSpecManagedUpdateTests
    {
        private static readonly string Source = new string('a', 64), Native = new string('b', 64);
        [Fact]
        public void OversizedReplacementRollsBackBeforeSettlementCanLoseItsInventory()
        {
            var ids = Enumerable.Range(1,4096).Select(i => (long)i).ToArray();
            DrawingSpecManagedUpdateGuard.RequireBoundedInventory(ids.Concat(ids));
            Assert.Throws<InvalidOperationException>(() => DrawingSpecManagedUpdateGuard.RequireBoundedInventory(ids.Append(4097L)));
        }

        [Fact]
        public void OwnershipDiscoveryDoesNotPretendToInspectOrChangeSource()
        {
            Assert.Equal("list", DrawingSpecInspectionRequest.Parse("{\"action\":\"list\",\"pageSize\":3}").action);
            Assert.Throws<ArgumentException>(() => DrawingSpecInspectionRequest.Parse("{\"action\":\"list\",\"manifestElementId\":30}"));
            Assert.Throws<ArgumentException>(() => DrawingSpecInspectionRequest.Parse("{\"action\":\"update\"}"));
            Assert.Throws<ArgumentException>(() => DrawingSpecInspectionRequest.Parse("{\"action\":\"list\",\"force\":true}"));
        }
        [Fact]
        public void NativePublishedUpdateContractRequiresExplicitOwnershipAndFreshRevision()
        {
            Assert.True(OperatorConditionalRequestContracts.TryGet("/revit/import-drawing-spec", out var schema));
            var modes = schema.GetProperty("oneOf").EnumerateArray().ToArray();
            var update = Assert.Single(modes, mode => mode.GetProperty("properties").GetProperty("action").GetProperty("enum")[0].GetString() == "update");
            Assert.Equal(new[] { "action", "manifestElementId", "expectedSourceSha256", "expectedNativeSnapshotSha256" },
                update.GetProperty("required").EnumerateArray().Select(v => v.GetString()).ToArray());
            Assert.False(schema.GetProperty("additionalProperties").GetBoolean());
        }
        [Fact]
        public void CurrentRevisionIsExplicitAndStaleOrManualChangesAreRejected()
        {
            DrawingSpecManagedUpdateGuard.RequireCurrent(Source, Native, Source, Native, Native);
            foreach (var mismatch in new[] {
                new[] { new string('c',64),Native,Source,Native,Native },
                new[] { Source,new string('c',64),Source,Native,Native },
                new[] { Source,Native,Source,Native,new string('c',64) } })
                Assert.Throws<InvalidOperationException>(() => DrawingSpecManagedUpdateGuard.RequireCurrent(mismatch[0],mismatch[1],mismatch[2],mismatch[3],mismatch[4]));
            Assert.Throws<ArgumentException>(() => DrawingSpecManagedUpdateGuard.RequireCurrent(null,Native,Source,Native,Native));
        }
        [Fact]
        public void CascadingOrIncompleteDeletionCannotCommit()
        {
            DrawingSpecManagedUpdateGuard.RequireExactDeletion(new long[] { 10,11 },new long[] { 11,10 });
            foreach (var actual in new[] { new long[] {10},new long[] {10,11,12},new long[] {10,10,11},Array.Empty<long>() })
                Assert.Throws<InvalidOperationException>(() => DrawingSpecManagedUpdateGuard.RequireExactDeletion(new long[] {10,11},actual));
            Assert.Throws<InvalidOperationException>(() => DrawingSpecManagedUpdateGuard.RequireExactDeletion(new long[] {10,10},new long[] {10}));
        }
    }
}
