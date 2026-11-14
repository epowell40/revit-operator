using System;
using System.IO;
using System.Reflection;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DraftingEllipseReadbackTests
    {
        private static string Key(double rx=2, double ry=1, double[]? center=null,
            double[]? x=null, double[]? y=null, double? start=null, double? end=null)
        {
            var method=typeof(DraftingCurveReadback).GetMethod("EllipseKey");
            Assert.NotNull(method);
            try { return (string)method!.Invoke(null,new object?[]{center??new[]{0d,0,0},rx,ry,
                x??new[]{1d,0,0},y??new[]{0d,1,0},start,end})!; }
            catch(TargetInvocationException e) { throw e.InnerException!; }
        }

        [Fact]
        public void EllipseObservationDistinguishesRadiiFrameLocationAndPartialDomain()
        {
            var full=Key();
            Assert.Equal(full,Key());
            Assert.NotEqual(full,Key(rx:3)); Assert.NotEqual(full,Key(ry:1.5));
            Assert.NotEqual(full,Key(center:new[]{1d,0,0}));
            Assert.NotEqual(full,Key(x:new[]{0d,1,0},y:new[]{-1d,0,0}));
            Assert.NotEqual(full,Key(start:0,end:Math.PI));
            Assert.NotEqual(Key(start:0,end:Math.PI),Key(start:0,end:Math.PI/2));
            Assert.NotEqual(Key(start:0,end:Math.PI),Key(start:Math.PI,end:2*Math.PI));
        }

        [Fact]
        public void MissingNonfiniteOrDegenerateEllipseFactsCannotBecomeComplete()
        {
            Assert.Throws<ArgumentException>(()=>Key(rx:0));
            Assert.Throws<ArgumentException>(()=>Key(ry:double.NaN));
            Assert.Throws<ArgumentException>(()=>Key(x:new[]{0d,0,0}));
            Assert.Throws<ArgumentException>(()=>Key(y:new[]{1d,0,0}));
            Assert.Throws<ArgumentException>(()=>Key(x:new[]{2d,0,0}));
            Assert.Throws<ArgumentException>(()=>Key(center:new[]{0d,double.PositiveInfinity,0}));
            Assert.Throws<ArgumentException>(()=>Key(start:0));
            Assert.Throws<ArgumentException>(()=>Key(start:1,end:0));
            Assert.Throws<ArgumentException>(()=>Key(start:0,end:double.NaN));
        }

        [Fact]
        public void EffectAndInventoryReadersUseTheSameCompleteNativeEllipseDescription()
        {
            var root=new DirectoryInfo(AppContext.BaseDirectory);
            while(root!=null&&!Directory.Exists(Path.Combine(root.FullName,"RevitBridge.Logic")))root=root.Parent;
            Assert.NotNull(root);
            var reader=File.ReadAllText(Path.Combine(root!.FullName,"RevitBridge.Logic","NativeDraftingCurveGeometry.cs"));
            var inventory=File.ReadAllText(Path.Combine(root.FullName,"RevitBridge.Logic","Handlers","ViewOwnedDetailingHandler.cs"));
            Assert.Contains("curve is Ellipse ellipse",reader);
            Assert.Contains("complete_native_ellipse_radii_frame_and_domain",reader);
            Assert.Contains("ellipse.IsBound ?",reader);
            Assert.Contains("NativeDraftingCurveGeometry.EllipseRelativeKey",inventory);
            Assert.Contains("curve is Ellipse",inventory);
        }
    }
}
