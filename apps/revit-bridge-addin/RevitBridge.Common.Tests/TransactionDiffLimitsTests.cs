using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class TransactionDiffLimitsTests
    {
        [Fact]
        public void Create_UsesDefaults_WhenNull()
        {
            var limits = TransactionDiffLimits.Create();

            Assert.Equal(TransactionDiffLimits.DefaultMaxTrackedElementIds, limits.MaxTrackedElementIds);
            Assert.Equal(TransactionDiffLimits.DefaultMaxCreated, limits.MaxCreated);
            Assert.Equal(TransactionDiffLimits.DefaultMaxDeleted, limits.MaxDeleted);
            Assert.Equal(TransactionDiffLimits.DefaultMaxModified, limits.MaxModified);
            Assert.Equal(TransactionDiffLimits.DefaultMaxParameterDeltas, limits.MaxParameterDeltas);
            Assert.Equal(TransactionDiffLimits.DefaultMaxGeometryDeltas, limits.MaxGeometryDeltas);
            Assert.Equal(TransactionDiffLimits.DefaultMaxViewSheetChanges, limits.MaxViewSheetChanges);
            Assert.Equal(TransactionDiffLimits.DefaultMaxWatchElementsPerScope, limits.MaxWatchElementsPerScope);
        }

        [Fact]
        public void Create_ClampsValues_ToSafeRanges()
        {
            var limits = TransactionDiffLimits.Create(
                maxTrackedElementIds: 999999,
                maxCreated: 1,
                maxDeleted: -5,
                maxModified: 0,
                maxParameterDeltas: 60000,
                maxGeometryDeltas: 4,
                maxViewSheetChanges: -1,
                maxWatchElementsPerScope: 999999);

            Assert.Equal(50000, limits.MaxTrackedElementIds);
            Assert.Equal(10, limits.MaxCreated);
            Assert.Equal(10, limits.MaxDeleted);
            Assert.Equal(10, limits.MaxModified);
            Assert.Equal(20000, limits.MaxParameterDeltas);
            Assert.Equal(10, limits.MaxGeometryDeltas);
            Assert.Equal(10, limits.MaxViewSheetChanges);
            Assert.Equal(5000, limits.MaxWatchElementsPerScope);
        }

        [Fact]
        public void PayloadCap_Truncates_AndReportsOmitted()
        {
            var source = new[] { 1, 2, 3, 4, 5 };
            var capped = TransactionDiffPayloadCap.Cap(source, 3, out var omitted);

            Assert.Equal(new[] { 1, 2, 3 }, capped);
            Assert.Equal(2, omitted);
        }
    }
}
