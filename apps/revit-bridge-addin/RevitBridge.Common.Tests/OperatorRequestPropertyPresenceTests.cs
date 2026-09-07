using System;
using System.Text.Json;
using System.Text.Json.Serialization;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OperatorRequestPropertyPresenceTests
    {
        public sealed class Request
        {
            public string? viewName { get; set; }
            public string? query { get; set; }
            public string? viewType { get; set; }
            public bool zoomToFit { get; set; }
            public bool enabled { get; set; } = true;
            public string filePath { get; set; } = null!;
            public int elementId { get; set; }
            public int? optionalId { get; set; }
            [JsonRequired] public bool confirmation { get; set; }
            [JsonRequired] public string? explicitNullableRequired { get; set; }
        }

        [Theory]
        [InlineData("viewName", false)]
        [InlineData("query", false)]
        [InlineData("viewType", false)]
        [InlineData("zoomToFit", false)]
        [InlineData("enabled", false)]
        [InlineData("filePath", true)]
        [InlineData("elementId", true)]
        [InlineData("optionalId", false)]
        [InlineData("confirmation", true)]
        [InlineData("explicitNullableRequired", true)]
        public void CompiledNullableMetadataAndExplicitRequirementsAgreeAcrossFrameworks(string name, bool expected)
        {
            var property = typeof(Request).GetProperty(name)!;
            var value = property.GetValue(new Request());
            Assert.Equal(expected, OperatorRequestPropertyPresence.IsRequired(property, value, value == null || Equals(value, 0) || Equals(value, false)));
        }

        [Fact]
        public void SerializerStillRequiresExplicitPresenceAndRejectsWrongTypes()
        {
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Request>("{}"));
            Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<Request>("{\"confirmation\":true,\"explicitNullableRequired\":null,\"zoomToFit\":\"yes\"}"));
            var value = JsonSerializer.Deserialize<Request>("{\"confirmation\":false,\"explicitNullableRequired\":null}")!;
            Assert.False(value.zoomToFit);
            Assert.True(value.enabled);
            Assert.Null(value.viewName);
        }
    }
}
