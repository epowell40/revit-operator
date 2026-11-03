using System;
using System.Linq;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class OperatorModelSheetFocusTests
    {
        private static OperatorModelSheetFocus Row(long element=1546001) => new OperatorModelSheetFocus {
            elementId=element,elementUniqueId="damper-"+element,viewId=1363413,viewUniqueId="plan",viewportId=1411505,viewportUniqueId="viewport",
            sheetId=1363547,sheetUniqueId="sheet",boundsMinXyz=new[]{1d,1d,0d},boundsMaxXyz=new[]{1.1d,1.2d,0d}};
        private static double[][] Box(double minX,double minY,double maxX,double maxY) =>
            (from x in new[]{minX,maxX} from y in new[]{minY,maxY} from z in new[]{-1d,1d} select new[]{x,y,z}).ToArray();

        [Fact] public void Actual164IdentitiesRemainDistinctFromProjectedNavigationCoordinates()
        {
            foreach(var id in new[]{1546001L,1546027L}){
                var row=Row(id);Assert.Same(row,OperatorModelSheetFocus.Unique(1363547,id,new[]{row},false));
                Assert.True(row.navigationOnly);Assert.Equal("sheet_feet",row.coordinateSpace);
            }
            // These coordinates are a synthetic projection, not reconstructed
            // historical164 transforms or proof that its symbols were visible.
        }
        [Theory]
        [InlineData("foreign-sheet")][InlineData("foreign-element")][InlineData("unknown-view")][InlineData("empty-uid")]
        [InlineData("same-id")][InlineData("duplicate")][InlineData("unresolved")][InlineData("empty")]
        [InlineData("nan")][InlineData("plane")][InlineData("inverted")][InlineData("degenerate")]
        public void UnresolvedOrUnboundedProjectionCannotBeNavigationProof(string reason)
        {
            var r=Row();var rows=new[]{r};var unresolved=false;
            switch(reason){case "foreign-sheet":r.sheetId++;break;case "foreign-element":r.elementId++;break;
                case "unknown-view":r.viewId=0;break;case "empty-uid":r.viewUniqueId="";break;case "same-id":r.viewportId=r.viewId;break;
                case "duplicate":rows=new[]{r,Row()};break;case "unresolved":unresolved=true;break;case "empty":rows=Array.Empty<OperatorModelSheetFocus>();break;
                case "nan":r.boundsMinXyz[0]=double.NaN;break;case "plane":r.boundsMaxXyz[2]=1;break;
                case "inverted":r.boundsMinXyz[0]=3;break;case "degenerate":r.boundsMaxXyz[1]=r.boundsMinXyz[1];break;}
            Assert.Null(OperatorModelSheetFocus.Unique(1363547,1546001,rows,unresolved));
        }
        [Fact] public void BoundsUseEveryCornerAndIgnoreOnlyProjectionDepth()
        {
            var corners=Box(-10.588511591,14.46875,-9.796844924,15.322916667);
            // Known synthetic 90-degree viewport rotation plus 1:96 scale.
            var transformed=corners.Select(p=>new[]{1.565016427-p[1]/96,0.880418424+p[0]/96,p[2]}).ToArray();
            var b=OperatorModelSheetFocus.Bounds(transformed);
            Assert.Equal(transformed.Min(p=>p[0]),b[0][0]);Assert.Equal(transformed.Max(p=>p[0]),b[1][0]);
            Assert.Equal(transformed.Min(p=>p[1]),b[0][1]);Assert.Equal(transformed.Max(p=>p[1]),b[1][1]);
            Assert.Equal(0,b[0][2]);Assert.Equal(0,b[1][2]);
            Assert.Throws<ArgumentException>(()=>OperatorModelSheetFocus.Bounds(transformed.Take(7)));
            transformed[0][0]=double.PositiveInfinity;Assert.Throws<ArgumentException>(()=>OperatorModelSheetFocus.Bounds(transformed));
        }
        [Fact] public void CropRequiresWholeProjectedBoundsAndRejectsConcaveOrDegenerateBoundary()
        {
            var p=new[]{new[]{0d,0d,0d},new[]{2d,0d,0d},new[]{2d,2d,0d},new[]{0d,2d,0d}};
            Assert.True(OperatorModelSheetFocus.InsideConvexBoundary(Box(.2,.2,1.8,1.8),p));
            Assert.True(OperatorModelSheetFocus.InsideConvexBoundary(Box(.2,.2,1.8,1.8),p.Reverse().ToArray()));
            Assert.False(OperatorModelSheetFocus.InsideConvexBoundary(Box(-.2,.2,1.8,1.8),p));
            p[2]=new[]{.1,.1,0d};Assert.False(OperatorModelSheetFocus.InsideConvexBoundary(Box(.2,.2,.3,.3),p));
            p[2]=p[1];Assert.False(OperatorModelSheetFocus.InsideConvexBoundary(Box(.2,.2,.3,.3),p));
        }
    }
}
