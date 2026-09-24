using System;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class ViewOwnedDetailingInventoryContractTests
    {
        [Fact]
        public void CompleteInventoryRetainsEveryOwnerAndReportsExactCount()
        {
            var result = ViewOwnedDetailingInventoryContract.Bound(new[] { 10, 20, 30 }, 3);
            Assert.Equal(new[] { 10, 20, 30 }, result.Items);
            Assert.Equal(3, result.TotalOwnedCount);
            Assert.True(result.ItemsComplete);
            Assert.False(result.Truncated);
            Assert.Equal(0, result.UnreadableCount);
        }

        [Fact]
        public void PrefixAndUnreadableOwnerNeverClaimCompleteInventory()
        {
            var prefix = ViewOwnedDetailingInventoryContract.Bound(new[] { 10, 20, 30 }, 2);
            Assert.Equal(new[] { 10, 20 }, prefix.Items);
            Assert.Equal(3, prefix.TotalOwnedCount);
            Assert.True(prefix.Truncated);
            Assert.False(prefix.ItemsComplete);

            var unreadable = ViewOwnedDetailingInventoryContract.Bound(new[] { 10, 20 }, 3, 1);
            Assert.Equal(3, unreadable.TotalOwnedCount);
            Assert.False(unreadable.Truncated);
            Assert.False(unreadable.ItemsComplete);
            Assert.Equal(1, unreadable.UnreadableCount);
        }

        [Fact]
        public void LimitMustBeExplicitlyBounded()
        {
            Assert.Equal(1000, ViewOwnedDetailingInventoryContract.ValidateLimit(null));
            Assert.Equal(5000, ViewOwnedDetailingInventoryContract.ValidateLimit(5000));
            Assert.Throws<ArgumentOutOfRangeException>(() => ViewOwnedDetailingInventoryContract.ValidateLimit(0));
            Assert.Throws<ArgumentOutOfRangeException>(() => ViewOwnedDetailingInventoryContract.ValidateLimit(5001));
        }

        [Fact]
        public void SemanticSignatureIgnoresNativeIdentityButChangesForTextTypeAndPosition()
        {
            var source = ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "SUPPLY AIR", "text:1.0000,2.0000,0.0000");
            var copied = ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "SUPPLY AIR", "text:1.0000,2.0000,0.0000");
            Assert.Equal(source, copied);
            Assert.NotEqual(source, ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "RETURN AIR", "text:1.0000,2.0000,0.0000"));
            Assert.NotEqual(source, ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "other-type",
                "SUPPLY AIR", "text:1.0000,2.0000,0.0000"));
            Assert.NotEqual(source, ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "SUPPLY AIR", "text:3.0000,2.0000,0.0000"));
        }
    }
}
