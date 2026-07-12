using System;
using System.Collections.Generic;
using RevitBridge.Common.Semantic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class StrictCategoryResolverTests
    {
        private static readonly IReadOnlyList<StrictCategoryDescriptor> Catalog = new[]
        {
            new StrictCategoryDescriptor { Id = -2008013, Name = "Air Terminals", BuiltInToken = "OST_DuctTerminal" },
            new StrictCategoryDescriptor { Id = -2005020, Name = "Mechanical Equipment", BuiltInToken = "OST_MechanicalEquipment" }
        };

        [Theory]
        [InlineData("Air Terminals")]
        [InlineData("OST_DuctTerminal")]
        [InlineData("DuctTerminal")]
        public void ResolvesDocumentNameOrBuiltInToken(string token)
        {
            var result = StrictCategoryResolver.Resolve(new[] { token }, Catalog);
            Assert.Single(result);
            Assert.Equal(-2008013, result[0].Id);
            Assert.Equal("Air Terminals", result[0].Name);
        }

        [Fact]
        public void RejectsUnknownInsteadOfBroadeningSearch()
        {
            var error = Assert.Throws<ArgumentException>(() => StrictCategoryResolver.Resolve(new[] { "Definitely Not A Category" }, Catalog));
            Assert.Contains("No unfiltered search was run", error.Message);
        }

        [Fact]
        public void RejectsWholeMixedRequestWhenAnyCategoryIsUnknown()
        {
            Assert.Throws<ArgumentException>(() => StrictCategoryResolver.Resolve(new[] { "Air Terminals", "Unknown" }, Catalog));
        }

        [Fact]
        public void RejectsAmbiguousDisplayName()
        {
            var ambiguous = new[]
            {
                new StrictCategoryDescriptor { Id = 1, Name = "Devices" },
                new StrictCategoryDescriptor { Id = 2, Name = "Devices" }
            };
            Assert.Throws<ArgumentException>(() => StrictCategoryResolver.Resolve(new[] { "Devices" }, ambiguous));
        }
    }
}
