using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class LinkedHostPlacementPolicyTests
    {
        [Fact]
        public void DirectRoomWholeLinkFailureNamesTheMissingExactHost()
        {
            Assert.Contains("linkedHostElementId", Assert.Throws<ArgumentException>(() => LinkedHostPlacementPolicy.Validate(true,true,null)).Message);
            LinkedHostPlacementPolicy.Validate(true,true,2095221);
            Assert.True(LinkedHostPlacementPolicy.Matches(1362429,2095221,1362429,2095221));
            Assert.False(LinkedHostPlacementPolicy.Matches(1362429,2095221,1362429,2095209));
            Assert.False(LinkedHostPlacementPolicy.Matches(1362429,2095221,42,2095221));
        }
        [Fact]
        public void HostKindAndPositiveIdentityAreRequired()
        {
            LinkedHostPlacementPolicy.Validate(false,true,null);
            Assert.Throws<ArgumentException>(() => LinkedHostPlacementPolicy.Validate(false,true,2095221));
            Assert.Throws<ArgumentException>(() => LinkedHostPlacementPolicy.Validate(true,false,2095221));
            Assert.Throws<ArgumentException>(() => LinkedHostPlacementPolicy.Validate(true,true,0));
            Assert.False(LinkedHostPlacementPolicy.Matches(-1,-1,-1,-1));
        }
    }
}
