using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ParameterValueUtilTests
    {
        [Fact]
        public void SnapshotMatchesRequestedValue_MatchesIntegerSnapshot()
        {
            var snapshot = new
            {
                storageType = "Integer",
                value = 10000,
                valueString = "10000"
            };

            Assert.True(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "10000"));
            Assert.False(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "12000"));
        }

        [Fact]
        public void SnapshotMatchesRequestedValue_MatchesStringSnapshot()
        {
            var snapshot = new
            {
                storageType = "String",
                value = "P102",
                valueString = "P102"
            };

            Assert.True(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "P102"));
            Assert.False(ParameterValueUtil.SnapshotMatchesRequestedValue(snapshot, "P105"));
        }
    }
}
