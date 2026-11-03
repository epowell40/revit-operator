using System;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeDocumentIdBaselineTests
    {
        [Fact]
        public void Retains_real_family_zero_without_resolving_every_positive_collector_id()
        {
            var probes = new System.Collections.Generic.List<long>();
            var ids = OperatorNativeDocumentIdBaseline.Capture(new[] { 0L, 17L, 23L, 910L }, id =>
            { probes.Add(id); return id == 0; });
            Assert.Equal(new[] { 0L, 17L, 23L, 910L }, ids.OrderBy(id => id));
            Assert.Equal(new[] { 0L }, probes);
            var decision = OperatorNativeMutationScopePolicy.Evaluate(new[] { 1000L }, new long[0], new long[0],
                new[] { 17L, 23L, 910L }, true, 4, preexistingElementIds: ids);
            Assert.True(decision.Allowed);
            Assert.Equal(new[] { 1000L }, decision.AddedElementIds);
        }

        [Theory]
        [InlineData(0L)]
        [InlineData(-1L)]
        [InlineData(-2L)]
        public void Unresolved_nonpositive_identity_is_not_dropped_or_treated_as_complete(long id)
        {
            var error = Assert.Throws<InvalidOperationException>(() =>
                OperatorNativeDocumentIdBaseline.Capture(new[] { 17L, id }, _ => false));
            Assert.Contains("unresolved native element id " + id, error.Message);
            Assert.Contains("no transaction was started", error.Message);
        }

        [Fact]
        public void A_native_resolution_failure_cannot_become_a_partial_success()
        {
            Assert.Throws<InvalidOperationException>(() => OperatorNativeDocumentIdBaseline.Capture(new[] { 0L },
                _ => throw new InvalidOperationException("native resolution unavailable")));
        }

        [Fact]
        public void Duplicate_ids_and_overflow_are_incomplete_not_silently_deduplicated_or_truncated()
        {
            Assert.Throws<InvalidOperationException>(() => OperatorNativeDocumentIdBaseline.Capture(new[] { 17L, 17L }, _ => false));
            Assert.Throws<InvalidOperationException>(() => OperatorNativeDocumentIdBaseline.Capture(new[] { 0L, 0L }, _ => true));
            var maximum = Enumerable.Range(1, OperatorNativeDocumentIdBaseline.MaximumElements).Select(id => (long)id);
            Assert.Equal(OperatorNativeDocumentIdBaseline.MaximumElements, OperatorNativeDocumentIdBaseline.Capture(maximum, _ => false).Count);
            Assert.Throws<InvalidOperationException>(() => OperatorNativeDocumentIdBaseline.Capture(maximum.Concat(new[] { 300000L }), _ => false));
        }

        [Fact]
        public void Missing_native_inventory_or_validator_is_not_a_complete_empty_baseline()
        {
            Assert.Throws<ArgumentNullException>(() => OperatorNativeDocumentIdBaseline.Capture(null!, _ => true));
            Assert.Throws<ArgumentNullException>(() => OperatorNativeDocumentIdBaseline.Capture(new long[0], null!));
        }
    }
}
