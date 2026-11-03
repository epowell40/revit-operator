using System;
using System.Text.Json;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class NativeTextAnchorLocationTests
    {
        [Fact]
        public void CommitAndSummaryKeepNativeCoordUnitsIdentityAndOwnership()
        {
            var point=new[]{-32d,30.9d,0d};
            var anchor=NativeTextAnchorLocation.Create("note-uid",1363483,"view-uid",point);
            point[0]=100;anchor.pointXyz[1]=999;
            Assert.Equal(new[]{-32d,30.9d,0d},anchor.pointXyz);
            using var commit=JsonDocument.Parse(JsonSerializer.Serialize(anchor));
            using var read=JsonDocument.Parse(JsonSerializer.Serialize(anchor.SummaryLocation()));
            Assert.Equal("TextAnchor",commit.RootElement.GetProperty("kind").GetString());
            Assert.Equal("note-uid",commit.RootElement.GetProperty("elementUniqueId").GetString());
            Assert.Equal("textAnchor",read.RootElement.GetProperty("type").GetString());
            foreach(var p in new[]{commit.RootElement,read.RootElement})
            {
                Assert.Equal("model_feet",p.GetProperty("coordinateSpace").GetString());
                Assert.Equal(1363483,p.GetProperty("ownerViewId").GetInt64());
                Assert.Equal("view-uid",p.GetProperty("ownerViewUniqueId").GetString());
            }
            Assert.Equal(-32d,read.RootElement.GetProperty("x").GetDouble());
            Assert.Equal(30.9d,read.RootElement.GetProperty("y").GetDouble());
        }

        [Fact]
        public void MissingUnownedOrNonfiniteAnchorCannotBecomeTypedNativeProof()
        {
            foreach(var p in new double[][]{null!,Array.Empty<double>(),new[]{1d,2d},new[]{double.NaN,2d,3d},new[]{1d,double.PositiveInfinity,3d},new[]{1d,2d,double.NegativeInfinity}})
                Assert.Throws<ArgumentException>(()=>NativeTextAnchorLocation.Create("note",41,"view",p));
            Assert.Throws<ArgumentException>(()=>NativeTextAnchorLocation.Create("",41,"view",new[]{1d,2d,3d}));
            Assert.Throws<ArgumentException>(()=>NativeTextAnchorLocation.Create("note",0,"view",new[]{1d,2d,3d}));
            Assert.Throws<ArgumentException>(()=>NativeTextAnchorLocation.Create("note",41," ",new[]{1d,2d,3d}));
        }
    }
}
