using System;
using System.IO;
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
        public void OnlyKnownNonDraftingInfrastructureIsExcluded()
        {
            Assert.True(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("ExtentElem", null, false));
            Assert.True(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("SketchPlane", null, false));
            Assert.True(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("SunAndShadowSettings", "OST_SunStudy", false));
            Assert.False(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("TextNote", "OST_TextNotes", true));
            Assert.False(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("DetailCurve", "OST_Lines", false));
            Assert.False(ViewOwnedDetailingInventoryContract.IsNonDraftingInfrastructure("ExtentElem", null, true));
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

        [Fact]
        public void NativeTextNoteGeometryIncludesCopyStableOrientation()
        {
            var directory = new DirectoryInfo(AppDomain.CurrentDomain.BaseDirectory);
            while (directory != null && !Directory.Exists(Path.Combine(directory.FullName, "RevitBridge.Logic")))
                directory = directory.Parent;
            Assert.NotNull(directory);
            var source = File.ReadAllText(Path.Combine(directory!.FullName, "RevitBridge.Logic", "Handlers",
                "ViewOwnedDetailingHandler.cs"));
            Assert.Contains("Direction(note.BaseDirection)", source);
            Assert.Contains("Direction(note.UpDirection)", source);
            var upright = ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "SUPPLY AIR", "text:1,2,0:base:1,0,0:up:0,1,0");
            var rotated = ViewOwnedDetailingSemanticSignature.Create("TextNote", "OST_TextNotes", "type-uid",
                "SUPPLY AIR", "text:1,2,0:base:0,1,0:up:-1,0,0");
            Assert.NotEqual(upright, rotated);
        }
    }
}
