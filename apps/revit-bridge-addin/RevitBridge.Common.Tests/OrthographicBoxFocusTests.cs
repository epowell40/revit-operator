using System;
using System.Linq;
using System.Reflection;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class OrthographicBoxFocusTests
    {
        private static double[][] Project(double[] a, double[] b, double[] right, double[] up)
        {
            var type = typeof(NativeAccessoryPlanFocus).Assembly.GetType("RevitBridge.Common.OrthographicBoxFocus");
            Assert.NotNull(type);
            return (double[][])type!.GetMethod("Project")!.Invoke(null, new object[]{a,b,right,up})!;
        }
        private static double Dot(double[] a,double[] b) => a.Zip(b,(x,y)=>x*y).Sum();

        [Fact]
        public void AngledBuildingBoxContainsAllEightProjectedCorners()
        {
            // Retained A review bounds. An angled view's world-box diagonal
            // loses vertical extent; a screen rectangle needs all eight corners.
            var a=new[]{-4d,-4d,-.36}; var b=new[]{40d,24d,26.41};
            var right=new[]{.8,.6,0d}; var up=new[]{-.36,.48,.8};
            var frame=Project(a,b,right,up);
            for(var i=0;i<8;i++)
            {
                var p=new[]{(i&1)==0?a[0]:b[0],(i&2)==0?a[1]:b[1],(i&4)==0?a[2]:b[2]};
                foreach(var axis in new[]{right,up})
                    Assert.InRange(Dot(p,axis),Dot(frame[0],axis)-1e-8,Dot(frame[1],axis)+1e-8);
            }
            Assert.True(Dot(frame[1],up)-Dot(frame[0],up)>Math.Abs(Dot(b,up)-Dot(a,up))+20);
        }
        [Fact]
        public void ReversedBoundsAndNegativeAxesProduceSameFrame()
        {
            var a=new[]{-4d,-9d,0d};var b=new[]{12d,4d,3d};
            var r=new[]{-1d,0d,0d};var u=new[]{0d,-1d,0d};
            var x=Project(a,b,r,u);var y=Project(b,a,r,u);
            Assert.Equal(x[0],y[0]);Assert.Equal(x[1],y[1]);
        }
        [Fact]
        public void AxisAlignedFramePreservesCenterDepthAndAddsSmallContextMargin()
        {
            var x=Project(new[]{0d,0d,3d},new[]{10d,20d,7d},new[]{1d,0d,0d},new[]{0d,1d,0d});
            Assert.Equal(-.5,x[0][0],8);Assert.Equal(10.5,x[1][0],8);
            Assert.Equal(-1,x[0][1],8);Assert.Equal(21,x[1][1],8);
            Assert.Equal(5,x[0][2],8);Assert.Equal(5,x[1][2],8);
        }
        [Fact]
        public void FlatOrPointBoundsStillGetFiniteContext()
        {
            var x=Project(new[]{2d,3d,4d},new[]{2d,3d,4d},new[]{1d,0d,0d},new[]{0d,1d,0d});
            Assert.True(x[1][0]>x[0][0]);Assert.True(x[1][1]>x[0][1]);
        }
        [Theory]
        [InlineData(double.NaN)] [InlineData(double.PositiveInfinity)]
        public void InvalidCoordinatesCannotProduceZoom(double bad)
        {
            Assert.IsType<ArgumentException>(Assert.Throws<TargetInvocationException>(()=>Project(new[]{bad,0d,0d},new[]{1d,1d,1d},new[]{1d,0d,0d},new[]{0d,1d,0d})).InnerException);
        }
        [Fact]
        public void ParallelAxesAreRejected()
        {
            Assert.IsType<ArgumentException>(Assert.Throws<TargetInvocationException>(()=>Project(new[]{0d,0d,0d},new[]{1d,1d,1d},new[]{1d,0d,0d},new[]{1d,0d,0d})).InnerException);
        }
    }
}
