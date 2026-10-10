using System;
using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class ScheduleFilterValueTests
    {
        [Fact] public void TextLabelsAreNotGuessedAsElementIdsOrTrimmed()
        {
            Assert.Equal(" 004 ", ScheduleFilterValue.Parse(" 004 ", null));
            Assert.Equal("", ScheduleFilterValue.Parse("", "string"));
        }
        [Fact] public void ExplicitNativeTypesRemainDistinct()
        {
            Assert.Equal(123L, Assert.IsType<long>(ScheduleFilterValue.Parse("123", "element_id")));
            Assert.Equal(123, Assert.IsType<int>(ScheduleFilterValue.Parse("123", "integer")));
            Assert.Equal(1.25, Assert.IsType<double>(ScheduleFilterValue.Parse("1.25", "double")));
        }
        [Theory]
        [InlineData("-1", "element_id")]
        [InlineData("0", "element_id")]
        [InlineData("1.2", "integer")]
        [InlineData("NaN", "double")]
        [InlineData("Infinity", "double")]
        [InlineData("1 ft", "double")]
        [InlineData("1,5", "double")]
        [InlineData("123", "guessed")]
        [InlineData(null, "string")]
        public void InvalidTypedValuesFailBeforeNativeMutation(string? value, string type)
            => Assert.Throws<ArgumentException>(() => ScheduleFilterValue.Parse(value, type));
    }
}
