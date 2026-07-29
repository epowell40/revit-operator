using System;
using System.Linq;
using System.Text;
using RevitOperator.SafeReadHost.HostKernel;
using Xunit;

namespace RevitOperator.SafeReadHost.Tests
{
    public sealed class StrictJsonTests
    {
        [Fact]
        public void Exact_objects_strings_booleans_and_unicode_are_supported()
        {
            StrictJsonValue root=StrictJson.Parse("{\"first\":\"quote\\\" slash\\/ backslash\\\\ controls\\b\\f\\n\\r\\t\",\"nested\":{\"raw\":\"é😀\",\"escaped\":\"\\u00e9\\uD83D\\uDE00\"},\"flag\":true}",4096,4);
            Assert.True(root.HasExactProperties("first","nested","flag"));
            Assert.True(root.TryGetString("first",out string first));Assert.Equal("quote\" slash/ backslash\\ controls\b\f\n\r\t",first);
            Assert.True(root.TryGetObject("nested",out StrictJsonValue nested));Assert.True(nested.HasExactProperties("raw","escaped"));
            Assert.True(nested.TryGetString("raw",out string raw));Assert.True(nested.TryGetString("escaped",out string escaped));Assert.Equal(raw,escaped);
            Assert.True(root.TryGetBoolean("flag",out bool flag));Assert.True(flag);
            Assert.Equal(Protocol.Quote(raw),Protocol.Quote(escaped));
        }

        [Theory]
        [InlineData("")]
        [InlineData(" ")]
        [InlineData(" {}")]
        [InlineData("{} ")]
        [InlineData("{ }")]
        [InlineData("[]")]
        [InlineData("null")]
        [InlineData("true")]
        [InlineData("0")]
        [InlineData("{\"a\":null}")]
        [InlineData("{\"a\":[]}")]
        [InlineData("{\"a\":0}")]
        [InlineData("{\"a\":\"b\",}")]
        [InlineData("{\"a\":\"b\"}x")]
        [InlineData("{\"a\"\"b\"}")]
        [InlineData("{\"a\":\"b\" \"c\":\"d\"}")]
        [InlineData("{\"a\":\"unterminated}")]
        [InlineData("{\"a\":\"\\x00\"}")]
        [InlineData("{\"a\":\"\\u0xx0\"}")]
        [InlineData("{\"a\":\"\\uD800\"}")]
        [InlineData("{\"a\":\"\\uDC00\"}")]
        [InlineData("{\"a\":\"\\uD800\\u0041\"}")]
        [InlineData("{\"a\":\"line\nfeed\"}")]
        [InlineData("{\"\\u0061\":\"b\"}")]
        public void Noncanonical_or_unsupported_json_is_rejected(string json)
        {
            Assert.Throws<FormatException>(()=>StrictJson.Parse(json,4096,8));
        }

        [Fact]
        public void Duplicate_keys_order_and_types_fail_exact_contracts()
        {
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\"a\":\"1\",\"a\":\"2\"}",4096,4));
            StrictJsonValue reordered=StrictJson.Parse("{\"b\":\"2\",\"a\":\"1\"}",4096,4);Assert.False(reordered.HasExactProperties("a","b"));
            StrictJsonValue wrongType=StrictJson.Parse("{\"ok\":\"true\"}",4096,4);Assert.False(wrongType.TryGetBoolean("ok",out _));
        }

        [Fact]
        public void Byte_depth_property_key_and_string_bounds_are_enforced()
        {
            Assert.Throws<FormatException>(()=>StrictJson.Parse(new byte[]{0xff},16,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse(new byte[]{0xef,0xbb,0xbf,(byte)'{',(byte)'}'},16,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse(Encoding.UTF8.GetBytes("{}"),1,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\"a\":{\"b\":{}}}",64,2));
            string many="{"+String.Join(",",Enumerable.Range(0,65).Select(i=>"\"k"+i+"\":true"))+"}";Assert.Throws<FormatException>(()=>StrictJson.Parse(many,8192,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\""+new string('k',129)+"\":true}",1024,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\"a\":\""+new string('x',4097)+"\"}",8192,2));
        }

        [Fact]
        public void Raw_surrogates_are_rejected_but_valid_raw_pair_is_preserved()
        {
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\"a\":\""+'\ud800'+"\"}",64,2));
            Assert.Throws<FormatException>(()=>StrictJson.Parse("{\"a\":\""+'\udc00'+"\"}",64,2));
            StrictJsonValue root=StrictJson.Parse("{\"a\":\"😀\"}",64,2);Assert.True(root.TryGetString("a",out string value));Assert.Equal("😀",value);
        }
    }
}
