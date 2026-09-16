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
            [System.ComponentModel.DefaultValue(0d)] public double optionalCoordinate { get; set; }
            [System.ComponentModel.DefaultValue(0L)] public long optionalAlternateId { get; set; }
            [System.ComponentModel.DefaultValue(7)] public int mismatchedDefault { get; set; }
            [JsonRequired, System.ComponentModel.DefaultValue(false)] public bool confirmation { get; set; }
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
        [InlineData("optionalCoordinate", false)]
        [InlineData("optionalAlternateId", false)]
        [InlineData("mismatchedDefault", true)]
        [InlineData("confirmation", true)]
        [InlineData("explicitNullableRequired", true)]
        public void CompiledNullableMetadataAndExplicitRequirementsAgreeAcrossFrameworks(string name, bool expected)
        {
            var property = typeof(Request).GetProperty(name)!;
            var value = property.GetValue(new Request());
            var isDefault = value == null || (property.PropertyType.IsValueType && Equals(value, Activator.CreateInstance(property.PropertyType)));
            Assert.Equal(expected, OperatorRequestPropertyPresence.IsRequired(property, value, isDefault));
        }

        [Fact]
        public void NullableReferenceValuesAndPresenceAreSeparateContracts()
        {
            Assert.True(OperatorRequestPropertyPresence.AllowsReferenceNull(typeof(Request).GetProperty("viewName")!));
            Assert.True(OperatorRequestPropertyPresence.AllowsReferenceNull(typeof(Request).GetProperty("explicitNullableRequired")!));
            Assert.False(OperatorRequestPropertyPresence.AllowsReferenceNull(typeof(Request).GetProperty("filePath")!));
            Assert.False(OperatorRequestPropertyPresence.AllowsReferenceNull(typeof(Request).GetProperty("optionalId")!));
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
