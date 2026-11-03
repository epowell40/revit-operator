using System;
using System.Reflection;
using System.Text.Json;
using RevitBridge.Common;
using RevitBridge.Operator;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public class NativeAccessoryPlanFocusTests
    {
        private static object? Plan(int hosts = 1, int placements = 1, bool isPlan = true,
            double[]? start = null, double[]? end = null, double[]? right = null, double[]? up = null, double size = 1d/12)
        {
            var type = typeof(NativeInteractiveAccessoryRequest).Assembly.GetType("RevitBridge.Common.NativeAccessoryPlanFocus");
            Assert.NotNull(type);
            return type!.GetMethod("Create")!.Invoke(null, new object[] { hosts, placements, isPlan,
                start ?? new[]{-50.02604166666661,8.24999999999973,56.54166666666534},
                end ?? new[]{7.228897862800728,8.249999999999746,56.54166666666534},
                right ?? new[]{1d,0d,0d}, up ?? new[]{0d,1d,0d}, size });
        }
        private static JsonElement Data(object? value) => JsonSerializer.SerializeToElement(value);
        [Fact]
        public void LongPlanPipeGetsLocalMidpointNotEntireFiftySevenFootRoute()
        {
            // Retained190 geometry: neighboring centerline is two inches away in plan.
            var p=Data(Plan());
            Assert.Equal(2d,p.GetProperty("HalfSpanFt").GetDouble());
            Assert.Equal(8.24999999999973,p.GetProperty("Center")[1].GetDouble(),10);
            Assert.Equal(4d,p.GetProperty("UpperRight")[1].GetDouble()-p.GetProperty("LowerLeft")[1].GetDouble(),8);
            Assert.True((2d/12)/(2*p.GetProperty("HalfSpanFt").GetDouble())>0.04);
        }
        [Fact]
        public void ModelVisibleContractNamesNavigationAndKeepsClickAndVerificationResponsibilities()
        {
            var d=Assert.Single(OperatorToolManifest.Tools,t=>t.Path=="/revit/place-mep-accessory-interactively").Description;
            Assert.Contains("single-host single-placement plan",d);
            Assert.Contains("midpoint",d);
            Assert.Contains("does not constrain cursor snapping",d);
            Assert.Contains("Verify those independently",d);
        }
        [Theory]
        [InlineData(2,1,true)] [InlineData(1,2,true)] [InlineData(1,1,false)]
        public void BatchAndNonPlanNavigationRemainUnchanged(int hosts,int placements,bool plan)
            => Assert.Null(Plan(hosts,placements,plan));
        [Fact]
        public void ReversingEndpointsKeepsSameFocus()
        {
            var a=new[]{3d,4d,5d};var b=new[]{11d,4d,5d};
            Assert.Equal(JsonSerializer.Serialize(Plan(start:a,end:b)),JsonSerializer.Serialize(Plan(start:b,end:a)));
        }
        [Fact]
        public void RotatedPlanUsesViewAxesAndDoesNotChangeElevation()
        {
            var p=Data(Plan(right:new[]{0d,1d,0d},up:new[]{-1d,0d,0d}));
            Assert.Equal(p.GetProperty("Center")[2].GetDouble(),p.GetProperty("LowerLeft")[2].GetDouble());
            Assert.Equal(p.GetProperty("Center")[0].GetDouble()+2,p.GetProperty("LowerLeft")[0].GetDouble());
        }
        [Fact]
        public void LargeDuctGetsSizeAppropriateContext()
            => Assert.Equal(8d,Data(Plan(size:2)).GetProperty("HalfSpanFt").GetDouble());
        [Fact]
        public void EndOnVerticalPipeDoesNotInventPlanRoute()
            => Assert.Null(Plan(start:new[]{1d,2d,3d},end:new[]{1d,2d,9d}));
        [Fact]
        public void InvalidGeometryFailsClosed()
        {
            foreach(var bad in new[]{new[]{double.NaN,0d,0d},new[]{double.PositiveInfinity,0d,0d},new[]{1d,2d}})
                Assert.IsType<ArgumentException>(Assert.Throws<TargetInvocationException>(()=>Plan(start:bad)).InnerException);
            Assert.IsType<ArgumentException>(Assert.Throws<TargetInvocationException>(()=>Plan(right:new[]{1d,0d,0d},up:new[]{1d,0d,0d})).InnerException);
            Assert.IsType<ArgumentException>(Assert.Throws<TargetInvocationException>(()=>Plan(size:-1)).InnerException);
        }
    }
}
