using System;
using System.IO;
using System.Linq;
using RevitBridge.Common;
using Xunit;

namespace RevitBridge.Common.Tests
{
    public sealed class DraftingCubicBezierTests
    {
        private static double[][] Controls(double bend = 1) => new[] {
            new[] { 0d, 0d, 0d }, new[] { 1d, bend, 0d }, new[] { 2d, -bend, 0d }, new[] { 3d, 0d, 0d } };
        private static string Key(double[][] points, double[]? weights = null, double[]? knots = null, double end = 1)
            => DraftingCubicBezier.NativeNurbsGeometryKey(3, weights != null, false, points,
                knots ?? DraftingCubicBezier.ClampedKnots(), weights ?? new[] { 1d, 1d, 1d, 1d }, 0, end);

        [Fact]
        public void CubicUsesFourOrderedControlsAndClampedDegreeThreeKnots()
        {
            var original = Controls(); var checkedPoints = DraftingCubicBezier.ValidateControlPoints(original);
            Assert.Equal(4, checkedPoints.Length); Assert.Equal(original[1], checkedPoints[1]);
            original[1][1] = 99; Assert.Equal(1d, checkedPoints[1][1]);
            Assert.Equal(new[] { 0d, 0d, 0d, 0d, 1d, 1d, 1d, 1d }, DraftingCubicBezier.ClampedKnots());
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.ValidateControlPoints(checkedPoints.Take(3)));
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.ValidateControlPoints(checkedPoints.Concat(checkedPoints)));
            checkedPoints[1][2] = double.NaN;
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.ValidateControlPoints(checkedPoints));
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.ValidateControlPoints(null));
        }

        [Fact]
        public void NativeToleranceComesFromActualApplicationAndNeverDropsShortSourceCurves()
        {
            DraftingCubicBezier.RequireNativeLength(0.25, 0.0026);
            foreach (var length in new[] { 0, -1, 0.0026, double.NaN, double.PositiveInfinity })
                Assert.Throws<ArgumentException>(() => DraftingCubicBezier.RequireNativeLength(length, 0.0026));
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.RequireNativeLength(1, 0));
        }

        [Fact]
        public void ExactMonotoneStraightCubicsAvoidInvalidRepeatedNativeControlsWithoutFlatteningRealCurves()
        {
            var actual = new[] { new[] { 15.406722752100835, 6.231932610644249, 0d },
                new[] { 15.40567233193277, 6.231932610644249, 0d },
                new[] { 15.405042079831928, 6.231932610644249, 0d },
                new[] { 15.405042079831928, 6.231932610644249, 0d } };
            Assert.True(DraftingCubicBezier.IsExactMonotoneLine(actual));
            Assert.True(DraftingCubicBezier.IsExactMonotoneLine(actual.Reverse()));
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(Enumerable.Repeat(actual[0], 4)));
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(Controls()));
            var bowed = actual.Select(p => p.ToArray()).ToArray(); bowed[1][1] += 1e-10;
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(bowed));
            var loop = Controls(); loop[3] = loop[0].ToArray();
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(loop));
            var turnback = new[] { new[] { 0d, 0d, 0d }, new[] { 3d, 0d, 0d }, new[] { -1d, 0d, 0d }, new[] { 2d, 0d, 0d } };
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(turnback));
            Assert.False(DraftingCubicBezier.IsExactMonotoneLine(actual.Select(p => p.Select(v => v * 1e200).ToArray())));
            Assert.Throws<ArgumentException>(() => DraftingCubicBezier.IsExactMonotoneLine(actual.Take(3)));
        }

        [Fact]
        public void DifferentCubicsWithIdenticalEndpointsAndMidpointHaveDifferentFullKeys()
        {
            var a = Controls(1); var b = Controls(2);
            Assert.Equal(a[0], b[0]); Assert.Equal(a[3], b[3]);
            double MidpointY(double[][] points) => (points[0][1] + 3 * points[1][1] + 3 * points[2][1] + points[3][1]) / 8;
            Assert.Equal(MidpointY(a), MidpointY(b)); Assert.NotEqual(Key(a), Key(b));
            Assert.NotEqual(ViewOwnedDetailingSemanticSignature.Create("DetailNurbSpline", "OST_Lines", null, null, Key(a)),
                ViewOwnedDetailingSemanticSignature.Create("DetailNurbSpline", "OST_Lines", null, null, Key(b)));
        }

        [Fact]
        public void WeightsKnotsAndBoundedDomainArePartOfTheGeometryKey()
        {
            var points = Controls(); string key = Key(points);
            Assert.NotEqual(key, Key(points, new[] { 1d, 2d, 1d, 1d }));
            Assert.NotEqual(key, Key(points, knots: new[] { 0d, 0d, 0d, 0d, 2d, 2d, 2d, 2d }));
            Assert.NotEqual(key, Key(points, end: 0.5));
            Assert.Throws<ArgumentException>(() => Key(points, new[] { 1d, 1d }));
            Assert.Throws<ArgumentException>(() => Key(points, knots: new[] { 0d, 1d, 0d, 0d, 1d, 1d, 1d, 1d }));
            Assert.Throws<ArgumentException>(() => Key(points, end: double.PositiveInfinity));
        }

        [Fact]
        public void NativeHandlerPreflightsBeforeTransactionAndReadsAllNativeControlsAfterCommit()
        {
            string Read(string relative)
            {
                for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory != null; directory = directory.Parent)
                    foreach (var prefix in new[] { "apps/revit-bridge-addin", "revit-bridge-addin" })
                    {
                        var path = Path.Combine(directory.FullName, prefix, relative);
                        if (File.Exists(path)) return File.ReadAllText(path);
                    }
                throw new FileNotFoundException(relative);
            }
            var handler = Read("RevitBridge.Logic/Handlers/Drafting/DrawDetailCurvesHandler.cs");
            int preflight = handler.IndexOf("NurbSpline.CreateCurve(3, DraftingCubicBezier.ClampedKnots(), points)", StringComparison.Ordinal);
            Assert.True(preflight > 0); Assert.True(preflight < handler.IndexOf("enterNativeScope();", StringComparison.Ordinal));
            Assert.Contains("doc.Application.ShortCurveTolerance", handler);
            Assert.Contains("NativeSingleTransaction.Execute", handler);
            Assert.Contains("OperatorNativeTransactionExecution.ReadCommitted", handler);
            Assert.Contains("NativeDraftingCurveGeometry.Read", handler);
            var readback = Read("RevitBridge.Logic/NativeDraftingCurveGeometry.cs");
            foreach (var field in new[] { "spline.CtrlPoints", "spline.Knots", "spline.Weights", "spline.Degree", "spline.isRational", "spline.GetEndParameter" }) Assert.Contains(field, readback);
            var inventory = Read("RevitBridge.Logic/Handlers/ViewOwnedDetailingHandler.cs");
            Assert.Contains("NativeDraftingCurveGeometry.NurbsRelativeKey", inventory);
            Assert.Contains("if (!(curve is Line) && !(curve is Arc)) return null;", inventory);
        }
    }
}
