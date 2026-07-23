using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ParameterReadPagingPolicyTests
    {
        [Fact]
        public void ClampsOversizedPageWithoutRejectingRecoverableRequest()
        {
            var page = ParameterReadPagingPolicy.Normalize(offset: 0, limit: 2500);

            Assert.Equal(2500, page.RequestedLimit);
            Assert.Equal(500, page.Limit);
            Assert.True(page.LimitWasClamped);
        }

        [Fact]
        public void ReturnsDeterministicNextOffsetUntilScopeIsCovered()
        {
            Assert.Equal(500, ParameterReadPagingPolicy.NextOffset(2428, 0, 500));
            Assert.Equal(2000, ParameterReadPagingPolicy.NextOffset(2428, 1500, 500));
            Assert.Null(ParameterReadPagingPolicy.NextOffset(2428, 2000, 428));
            Assert.Null(ParameterReadPagingPolicy.NextOffset(2428, 2428, 0));
        }

        [Fact]
        public void NormalizesNegativeOffsetAndInvalidLimit()
        {
            var page = ParameterReadPagingPolicy.Normalize(offset: -10, limit: 0);

            Assert.Equal(0, page.Offset);
            Assert.Equal(ParameterReadPagingPolicy.DefaultLimit, page.Limit);
        }
    }
}
