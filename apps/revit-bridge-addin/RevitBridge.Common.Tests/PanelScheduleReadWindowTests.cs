using RevitBridge.Common;
using Xunit;
namespace RevitBridge.Common.Tests
{
    public class PanelScheduleReadWindowTests
    {
        [Theory]
        [InlineData(-1,0,20,10)] [InlineData(0,-1,20,10)]
        [InlineData(0,0,201,10)] [InlineData(0,0,20,41)]
        [InlineData(0,0,100,40)] [InlineData(0,0,0,10)]
        [InlineData(10001,0,20,10)] [InlineData(0,1001,20,10)]
        public void OversizedOrInvalidWindowRefuses(int r,int c,int nr,int nc)
        { Assert.False(PanelScheduleReadWindow.TryCreate(r,c,nr,nc,out var window,out var error)); Assert.Null(window); Assert.NotEmpty(error); }
        [Fact]
        public void DefaultAndBoundaryPagesRemainBounded()
        {
            Assert.True(PanelScheduleReadWindow.TryCreate(null,null,null,null,out var defaults,out _));
            Assert.Equal(50,defaults!.MaxRows); Assert.Equal(20,defaults.MaxColumns);
            Assert.True(PanelScheduleReadWindow.TryCreate(10000,1000,200,10,out var end,out _));
            Assert.Equal(200,end!.MaxRows); Assert.Equal(10000,end.RowOffset);
        }
        [Theory]
        [InlineData(1,6,6)] [InlineData(1,14,14)] [InlineData(1,26,26)]
        [InlineData(0,5,6)] [InlineData(0,-1,0)]
        public void RetainedOneIndexedPanelAndZeroIndexedNeighborUseNativeBounds(int first,int last,int expected)
        { Assert.Equal(expected,PanelScheduleReadWindow.Extent(first,last)); }
        [Fact]
        public void MalformedHugeExtentRefusesRatherThanOverflowing()
        { Assert.Throws<System.ArgumentException>(()=>PanelScheduleReadWindow.Extent(0,int.MaxValue)); }
    }
}
