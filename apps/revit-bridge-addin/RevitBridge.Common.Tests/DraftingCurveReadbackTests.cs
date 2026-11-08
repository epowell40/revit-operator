using System;
using System.Globalization;
using System.IO;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DraftingCurveReadbackTests
    {
        private static double[][] Controls(double bend = 2) => new[] { new[] {0d,0,0}, new[] {1d,bend,0}, new[] {2d,0,0} };
        private static double[][] Tangents(double speed = 1) => new[] {new[] {speed,2d,0},new[] {speed,0d,0},new[] {speed,-2d,0}};
        private static string Key(double bend = 2, double speed = 1, double middle = .5, bool periodic = false, double end = 1)
            => DraftingCurveReadback.HermiteKey(periodic, false, Controls(bend), Tangents(speed), new[] {0,middle,1}, 0, end);

        [Fact]
        public void EqualEndpointsCannotHideInteriorControlOrTangentChanges()
        {
            Assert.Equal(Controls(2)[0],Controls(3)[0]); Assert.Equal(Controls(2)[2],Controls(3)[2]);
            Assert.NotEqual(Key(),Key(bend:3)); Assert.NotEqual(Key(),Key(speed:2));
        }

        [Fact]
        public void NativeParametersDomainAndPeriodicStateRemainMaterial()
        {
            Assert.NotEqual(Key(),Key(middle:.4)); Assert.NotEqual(Key(),Key(end:.9));
            Assert.NotEqual(Key(),Key(periodic:true));
        }

        [Fact]
        public void KeyIsCultureIndependentAndBoundedWithoutDiscardingRawControls()
        {
            var original=CultureInfo.CurrentCulture;
            try { var expected=Key(); CultureInfo.CurrentCulture=new CultureInfo("fr-FR"); Assert.Equal(expected,Key()); Assert.True(expected.Length<100); }
            finally { CultureInfo.CurrentCulture=original; }
        }

        [Fact]
        public void IncompleteMalformedOrOversizedHermiteDataDoesNotBecomeAKey()
        {
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.HermiteKey(false,false,Controls(),Tangents().Take(2),new[]{0d,.5,1},0,1));
            Assert.Throws<ArgumentException>(()=>Key(middle:0));
            Assert.Throws<ArgumentException>(()=>Key(middle:double.NaN));
            Assert.Throws<ArgumentException>(()=>Key(speed:double.PositiveInfinity));
            Assert.Throws<ArgumentException>(()=>Key(bend:double.NaN));
            Assert.Throws<ArgumentException>(()=>Key(end:0));
            var n=DraftingCurveReadback.MaximumHermiteControls+1;
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.HermiteKey(false,false,
                Enumerable.Repeat(new[]{0d,0,0},n),Enumerable.Repeat(new[]{1d,0,0},n),Enumerable.Range(0,n).Select(v=>(double)v),0,n));
        }

        [Fact]
        public void WholeCircleKeyIncludesLocusRatherThanInventedEndpoints()
        {
            var c=new[]{2d,3,0};var plane=new[]{0d,0,1};var key=DraftingCurveReadback.CircleKey(c,2,plane);
            Assert.Equal(key,DraftingCurveReadback.CircleKey(c,2,new[]{0d,0,-1}));
            Assert.Equal(key,DraftingCurveReadback.CircleKey(c,2,new[]{0d,0,2}));
            Assert.NotEqual(key,DraftingCurveReadback.CircleKey(new[]{2d,4,0},2,plane));
            Assert.NotEqual(key,DraftingCurveReadback.CircleKey(c,3,plane));
            Assert.NotEqual(key,DraftingCurveReadback.CircleKey(c,2,new[]{0d,1,0}));
        }

        [Fact]
        public void InvalidCircleGeometryStaysUnavailable()
        {
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.CircleKey(new[]{double.NaN,0,0},1,new[]{0d,0,1}));
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.CircleKey(new[]{0d,0,0},0,new[]{0d,0,1}));
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.CircleKey(new[]{0d,0,0},1,new[]{0d,0,0}));
            Assert.Throws<ArgumentException>(()=>DraftingCurveReadback.CircleKey(new[]{0d,0,0},1,new[]{0d,0,double.PositiveInfinity}));
        }

        [Fact]
        public void ExistingNativeConsumerRequiresActualCurveObservationAndCompleteShapeKey()
        {
            var cursor=new DirectoryInfo(AppContext.BaseDirectory);
            while(cursor!=null&&!File.Exists(Path.Combine(cursor.FullName,"RevitBridge.Logic","Handlers","ViewOwnedDetailingHandler.cs")))cursor=cursor.Parent;
            Assert.NotNull(cursor);
            var source=File.ReadAllText(Path.Combine(cursor!.FullName,"RevitBridge.Logic","Handlers","ViewOwnedDetailingHandler.cs"));
            Assert.Contains("NativeDraftingCurveGeometry.HermiteRelativeKey",source);
            Assert.Contains("NativeDraftingCurveGeometry.CircleRelativeKey",source);
            Assert.Contains("(!(element is CurveElement) || curve != null)",source);
        }
    }
}
