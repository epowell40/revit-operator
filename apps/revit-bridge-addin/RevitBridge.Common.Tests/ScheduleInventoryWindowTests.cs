using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class ScheduleInventoryWindowTests
    {
        [Fact]
        public void DefaultKeepsRegularScheduleDiscovery()
        {
            Assert.True(ScheduleInventoryWindow.TryCreate(null,null,null,out var page,out _));
            Assert.Equal("regular",page!.Kind); Assert.Equal(200,page.Max);
            Assert.True(page.Complete(15)); Assert.False(page.HasMore(15)); Assert.Null(page.NextOffset(15));
        }
        [Fact]
        public void PanelCensusAndPartialPagesHaveDifferentCoverage()
        {
            Assert.True(ScheduleInventoryWindow.TryCreate("panel",0,100,out var all,out _));
            Assert.Equal(54,all!.Returned(54)); Assert.True(all.Complete(54));
            Assert.True(ScheduleInventoryWindow.TryCreate("panel",0,25,out var first,out _));
            Assert.Equal(25,first!.Returned(54)); Assert.False(first.Complete(54)); Assert.Equal(25,first.NextOffset(54));
            Assert.True(ScheduleInventoryWindow.TryCreate("panel",50,25,out var last,out _));
            Assert.Equal(4,last!.Returned(54)); Assert.False(last.HasMore(54)); Assert.False(last.Complete(54));
        }
        [Theory]
        [InlineData("",0,10)] [InlineData("panels",0,10)] [InlineData("all",-1,10)]
        [InlineData("regular",0,0)] [InlineData("panel",0,2001)] [InlineData("all",100001,10)]
        public void InvalidOrUnboundedScopeRefuses(string kind,int offset,int max)
        { Assert.False(ScheduleInventoryWindow.TryCreate(kind,offset,max,out var page,out var error)); Assert.Null(page); Assert.NotEmpty(error); }
        [Fact]
        public void EmptyAndOutOfRangePagesAreNotConfused()
        {
            Assert.True(ScheduleInventoryWindow.TryCreate("all",0,1,out var empty,out _)); Assert.True(empty!.Complete(0));
            Assert.True(ScheduleInventoryWindow.TryCreate("all",100000,2000,out var beyond,out _));
            Assert.Equal(0,beyond!.Returned(54)); Assert.False(beyond.Complete(54)); Assert.Null(beyond.NextOffset(54));
        }
    }
}
