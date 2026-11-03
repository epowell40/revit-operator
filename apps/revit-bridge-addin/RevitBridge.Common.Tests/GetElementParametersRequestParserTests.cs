using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.Semantic;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class GetElementParametersRequestParserTests
    {
        // Exact read-only request from the retained mixed workflow. The native
        // handler previously rejected this schema-declared field with HTTP500.
        private const string Retained = "{\"elementIds\":[1410856],\"names\":[\"Comments\"],\"limit\":500,\"preservationScheduleIds\":[1420970,1422218,1488968,1521719,1521731,1543793]}";

        [Fact]
        public void RetainedPreservationReadKeepsTargetAndCollateralAsSeparateScopes()
        {
            var p = GetElementParametersRequestParser.Parse<Request>(Retained);
            Assert.Equal(new long[] { 1410856 }, p.elementIds);
            Assert.Equal(new long[] { 1420970, 1422218, 1488968, 1521719, 1521731, 1543793 }, p.preservationScheduleIds);
            Assert.Equal(new[] { "Comments" }, p.names);
            Assert.Equal(500, p.limit);
            Assert.Null(p.category);
            Assert.Null(p.allModelInstances);
        }

        [Theory]
        [InlineData("2")]
        [InlineData("[\"2\"]")]
        [InlineData("[0]")]
        [InlineData("[-1]")]
        [InlineData("[1.5]")]
        [InlineData("[2,2]")]
        [InlineData("[null]")]
        [InlineData("[true]")]
        public void MalformedPreservationDoesNotBecomeAnEmptyOrBroaderRead(string value)
            => Assert.Throws<Exception>(() => GetElementParametersRequestParser.Parse<Request>("{\"elementIds\":[1],\"preservationScheduleIds\":" + value + "}"));

        [Fact]
        public void PreservationCapIsExactAndDoesNotTruncateOrReorder()
        {
            var values = Enumerable.Range(1, 32).Reverse().ToArray();
            var json = "{\"elementIds\":[100],\"preservationScheduleIds\":[" + string.Join(",", values) + "]}";
            Assert.Equal(values.Select(x => (long)x), GetElementParametersRequestParser.Parse<Request>(json).preservationScheduleIds);
            Assert.Throws<Exception>(() => GetElementParametersRequestParser.Parse<Request>(json.Replace("[32,31", "[33,32,31")));
        }

        [Theory]
        [InlineData("{\"elementId\":\"1\",\"names\":[\" Comments \"],\"includeEmpty\":true}")]
        [InlineData("{\"elementId\":1,\"names\":[\" Comments \"],\"includeEmpty\":true,\"preservationScheduleIds\":null}")]
        public void LegacySelectorsAndOptionalOmissionRetainTheirMeaning(string json)
        {
            var p = GetElementParametersRequestParser.Parse<Request>(json);
            Assert.Equal(1L, p.elementId);
            Assert.Equal(new[] { "Comments" }, p.names);
            Assert.True(p.includeEmpty);
            Assert.Null(p.preservationScheduleIds);
        }

        [Fact]
        public void EmptyPreservationIsExplicitAndUnknownFieldsStillRefuse()
        {
            var p = GetElementParametersRequestParser.Parse<Request>("{\"elementIds\":[1],\"preservationScheduleIds\":[]}");
            Assert.Empty(p.preservationScheduleIds!);
            Assert.Throws<Exception>(() => GetElementParametersRequestParser.Parse<Request>("{\"elementIds\":[1],\"preservationScheduleId\":[2]}"));
            Assert.Throws<Exception>(() => GetElementParametersRequestParser.Parse<Request>("{\"elementIds\":[1],\"includeEmpty\":\"true\"}"));
        }

        private sealed class Request : IGetElementParametersRequest
        {
            public Request() { }
            public long? elementId { get; set; }
            public List<long>? elementIds { get; set; }
            public string? category { get; set; }
            public List<string>? categories { get; set; }
            public bool? allModelInstances { get; set; }
            public List<string>? names { get; set; }
            public bool? includeStringParameters { get; set; }
            public string? valueContains { get; set; }
            public string? valueEquals { get; set; }
            public bool? caseSensitive { get; set; }
            public bool? writableOnly { get; set; }
            public bool? includeEmpty { get; set; }
            public int? offset { get; set; }
            public int? limit { get; set; }
            public List<long>? preservationScheduleIds { get; set; }
        }
    }
}
