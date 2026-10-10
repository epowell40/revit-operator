using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class CategoryVisibilitySnapshotTests
    {
        private static CategoryVisibilityState State(long id) => new CategoryVisibilityState
        {
            id = id, name = "Category " + id, canHide = true, hidden = false, overridable = true,
            graphics = new SortedDictionary<string, object?>(StringComparer.Ordinal) { ["lineWeight"] = -1, ["halftone"] = false }
        };
        private static JsonElement Snapshot(IEnumerable<CategoryVisibilityState> rows, long? target = 1)
            => JsonDocument.Parse(JsonSerializer.Serialize(CategoryVisibilitySnapshot.Build(rows, target))).RootElement;
        private static string? Hash(JsonElement row, string key) => row.GetProperty(key).GetString();

        [Fact]
        public void EnumerationOrderDoesNotChangeDigest()
        {
            var a = State(1); var b = State(2);
            Assert.Equal(Hash(Snapshot(new[] { a, b }), "allCategoriesSha256"), Hash(Snapshot(new[] { b, a }), "allCategoriesSha256"));
        }
        [Fact]
        public void TargetVisibilityChangesOnlyTargetAndWholeSnapshot()
        {
            var a = State(1); var b = State(2); var before = Snapshot(new[] { a, b });
            a.hidden = true; var after = Snapshot(new[] { a, b });
            Assert.NotEqual(Hash(before, "allCategoriesSha256"), Hash(after, "allCategoriesSha256"));
            Assert.Equal(Hash(before, "otherCategoriesSha256"), Hash(after, "otherCategoriesSha256"));
            Assert.True(after.GetProperty("target").GetProperty("hidden").GetBoolean());
        }
        [Theory]
        [InlineData("hidden")]
        [InlineData("graphics")]
        [InlineData("parent")]
        public void DetectsCollateralChanges(string change)
        {
            var a = State(1); var b = State(2); var before = Snapshot(new[] { a, b });
            if (change == "hidden") b.hidden = true;
            if (change == "graphics") b.graphics!["halftone"] = true;
            if (change == "parent") b.parentId = 99;
            Assert.NotEqual(Hash(before, "otherCategoriesSha256"), Hash(Snapshot(new[] { a, b }), "otherCategoriesSha256"));
        }
        [Fact]
        public void MissingDuplicateOrOverLimitInventoryCannotClaimCompleteness()
        {
            Assert.Throws<InvalidOperationException>(() => Snapshot(new[] { State(2) }));
            Assert.Throws<InvalidOperationException>(() => Snapshot(new[] { State(1), State(1) }));
            Assert.Throws<InvalidOperationException>(() => Snapshot(Enumerable.Range(1, CategoryVisibilitySnapshot.Limit + 1).Select(x => State(x))));
        }
        [Fact]
        public void NonEditableCategoriesStillRequireActualReadableState()
        {
            var a = State(1); a.hidden = null;
            Assert.Throws<InvalidOperationException>(() => Snapshot(new[] { a }));
            a.canHide = false; a.overridable = false;
            Assert.Throws<InvalidOperationException>(() => Snapshot(new[] { a }));
            a.hidden = false;
            Assert.True(Snapshot(new[] { a }).GetProperty("complete").GetBoolean());
            a.graphics = null;
            Assert.Throws<InvalidOperationException>(() => Snapshot(new[] { a }));
        }
        [Fact]
        public void NonEditableValueChangesAreNotHiddenByCapabilityFlags()
        {
            var a = State(1); var b = State(2); b.canHide = false; b.overridable = false;
            var before = Snapshot(new[] { a, b }); b.hidden = true;
            Assert.NotEqual(Hash(before, "otherCategoriesSha256"), Hash(Snapshot(new[] { a, b }), "otherCategoriesSha256"));
            b.hidden = false; b.graphics!["halftone"] = true;
            Assert.NotEqual(Hash(before, "otherCategoriesSha256"), Hash(Snapshot(new[] { a, b }), "otherCategoriesSha256"));
        }
        [Fact]
        public void CategoryIdentityChangesAffectCoverageDigest()
        {
            Assert.NotEqual(Hash(Snapshot(new[] { State(1), State(2) }), "categoryIdsSha256"), Hash(Snapshot(new[] { State(1), State(3) }), "categoryIdsSha256"));
        }
        [Fact]
        public void CopiedCategoryValuesCanMatchAcrossDifferentEditability()
        {
            var a = State(1); var before = Snapshot(new[] { a });
            a.canHide = false; a.overridable = false;
            var controlled = Snapshot(new[] { a });
            Assert.Equal(Hash(before, "categoryValuesSha256"), Hash(controlled, "categoryValuesSha256"));
            Assert.NotEqual(Hash(before, "allCategoriesSha256"), Hash(controlled, "allCategoriesSha256"));
            a.hidden = true;
            Assert.NotEqual(Hash(before, "categoryValuesSha256"), Hash(Snapshot(new[] { a }), "categoryValuesSha256"));
        }
    }
}
