using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class CadGeometryTargetReadContractTests
    {
        [Fact]
        public void ExplicitCadProjectionRequiresExactBoundedTargetAndCannotClaimAWholeViewInventory()
        {
            CadGeometryTargetReadContract.Validate(true, 1, true, 32, 0, null);
            CadGeometryTargetReadContract.Validate(true, 1, true, 32, 20000, null);
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 2, true, 32, 0, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, false, 32, 0, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, null, 0, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, 0, 0, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, 32, null, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, 32, -1, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, 32, 20001, null));
            Assert.Throws<ArgumentException>(() => CadGeometryTargetReadContract.Validate(true, 1, true, 32, 0, 500));
        }
        [Fact]
        public void ExistingFullViewInventoryAndItsCompletenessRulesRemainSeparate()
        {
            CadGeometryTargetReadContract.Validate(null, 2, false, null, null, 500);
            CadGeometryTargetReadContract.Validate(false, 1, true, 32, 0, 500);
            var inventory = ViewOwnedDetailingInventoryContract.Bound(new int[560], 500);
            Assert.False(inventory.ItemsComplete); Assert.True(inventory.Truncated);
            Assert.Equal(560, inventory.TotalOwnedCount);
        }
    }
}
