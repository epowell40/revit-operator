using System;
using System.IO;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class CategoryDetailOverrideTests
    {
        [Theory]
        [InlineData(null, null)]
        [InlineData(" fine ", "Fine")]
        [InlineData("COARSE", "Coarse")]
        [InlineData("Medium", "Medium")]
        [InlineData("Undefined", "Undefined")]
        public void OnlyExplicitNativeLevelsAreAccepted(string? value, string? expected)
            => Assert.Equal(expected, CategoryVisibilityMutationPolicy.NormalizeDetailLevelOverride(value));

        [Theory]
        [InlineData("")]
        [InlineData("3")]
        [InlineData("Coarse,Fine")]
        [InlineData("Finest")]
        public void InvalidLevelsFailClosed(string value)
            => Assert.Throws<InvalidOperationException>(() => CategoryVisibilityMutationPolicy.NormalizeDetailLevelOverride(value));

        [Fact]
        public void NativeCategoryWriterAndReaderHaveMatchingDetailContract()
        {
            var root = new DirectoryInfo(AppContext.BaseDirectory);
            while (root != null && !Directory.Exists(Path.Combine(root.FullName, "RevitBridge"))) root = root.Parent;
            Assert.NotNull(root);
            foreach (var project in new[] { "RevitBridge", "RevitBridge.Logic" })
            {
                var source = File.ReadAllText(Path.Combine(root!.FullName, project, "Handlers", "ViewVisibilityHandler.cs"));
                var start = source.IndexOf("case \"set_category_override\":", StringComparison.Ordinal);
                var end = source.IndexOf("case \"clear_category_override\":", start, StringComparison.Ordinal);
                var block = source.Substring(start, end - start);
                Assert.Contains("view.GetCategoryOverrides(category.Id)", block);
                Assert.Contains("NormalizeDetailLevelOverride(p.detailLevel)", block);
                Assert.Contains("ogs.SetDetailLevel(", block);
                Assert.DoesNotContain("view.DetailLevel =", block);
                var reader = source.Substring(source.IndexOf("private static object? BuildCategoryOverrideState", StringComparison.Ordinal));
                Assert.Contains("detailLevel = ogs == null ? null : TryReadProperty(ogs, \"DetailLevel\")", reader);
            }
        }
    }
}
