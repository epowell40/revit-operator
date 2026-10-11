using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ConnectorReadStateTests
    {
        [Theory]
        [InlineData(true, false, true, false, 0, "open")]
        [InlineData(true, false, false, false, 0, "unknown")]
        [InlineData(true, false, true, null, 0, "unknown")]
        [InlineData(true, false, true, true, 0, "unknown")]
        [InlineData(true, false, false, true, 1, "connected")]
        [InlineData(true, false, false, null, 1, "connected")]
        [InlineData(false, true, true, false, 0, "not_physical")]
        [InlineData(false, false, true, false, 0, "unknown")]
        public void FailedOrAbsentEvidenceIsNotAnOpenPhysicalPort(bool physical, bool logical, bool complete, bool? connected, int peers, string expected)
        {
            Assert.Equal(expected, ConnectorReadState.Classify(physical, logical, complete, connected, peers));
        }
    }
}
