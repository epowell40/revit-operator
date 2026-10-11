using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ScheduleEligibleFieldPageTests
    {
        [Fact]
        public void AllPagesPreserveSameNameFieldsAndNativeIdentityBeyondFifty()
        {
            var fields = Enumerable.Range(1, 123).Reverse().Select(id => new ScheduleEligibleField
                { parameterId = -id, fieldType = id % 2 == 0 ? "Instance" : "ElementType", name = "Air Flow" }).ToList();
            var ids = new List<long>();
            var offset = 0;
            while (true)
            {
                var page = JsonSerializer.SerializeToElement(ScheduleEligibleFieldPage.Create(90, fields, offset, 50));
                Assert.Equal(123, page.GetProperty("total").GetInt32());
                Assert.False(page.GetProperty("complete").GetBoolean());
                foreach (var field in page.GetProperty("items").EnumerateArray())
                {
                    Assert.Equal("Air Flow", field.GetProperty("name").GetString());
                    ids.Add(field.GetProperty("parameterId").GetInt64());
                }
                if (!page.GetProperty("hasMore").GetBoolean()) break;
                offset = page.GetProperty("nextOffset").GetInt32();
            }
            Assert.Equal(Enumerable.Range(1, 123).Select(x => -(long)x).OrderBy(x => x), ids);
        }

        [Theory]
        [InlineData(0, true)]
        [InlineData(50, true)]
        [InlineData(51, false)]
        public void CompleteMeansEntireInventoryIncluded(int size, bool complete)
        {
            var fields = Enumerable.Range(0, size).Select(x => new ScheduleEligibleField { parameterId = x });
            var page = JsonSerializer.SerializeToElement(ScheduleEligibleFieldPage.Create(90, fields, 0, 50));
            Assert.Equal(complete, page.GetProperty("complete").GetBoolean());
        }

        [Theory]
        [InlineData(-1, 50)]
        [InlineData(1000001, 50)]
        [InlineData(0, 0)]
        [InlineData(0, 201)]
        public void InvalidPagesFail(int offset, int limit)
            => Assert.Throws<ArgumentException>(() => ScheduleEligibleFieldPage.Create(90, Array.Empty<ScheduleEligibleField>(), offset, limit));

        [Fact]
        public void NativeFailureCannotBecomeEmptyInventory()
        {
            IEnumerable<ScheduleEligibleField> Broken() { yield return new ScheduleEligibleField(); throw new InvalidOperationException("native failure"); }
            Assert.Throws<InvalidOperationException>(() => ScheduleEligibleFieldPage.Create(90, Broken(), 0, 1));
        }
    }
}
