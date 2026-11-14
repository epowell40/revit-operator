using System;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Screen-aligned navigation rectangle enclosing a world-axis box.
    /// This is framing, not an occlusion, visibility, or completion verdict.</summary>
    public static class OrthographicBoxFocus
    {
        public static double[][] Project(double[] a, double[] b, double[] right, double[] up)
        {
            bool Finite(double x) => !double.IsNaN(x) && !double.IsInfinity(x);
            bool Vector(double[] x) => x != null && x.Length == 3 && x.All(Finite);
            double Dot(double[] x,double[] y) => x.Zip(y,(v,w)=>v*w).Sum();
            if (!Vector(a) || !Vector(b) || !Vector(right) || !Vector(up)
                || Math.Abs(Dot(right,right)-1)>1e-6 || Math.Abs(Dot(up,up)-1)>1e-6
                || Math.Abs(Dot(right,up))>1e-6)
                throw new ArgumentException("Finite box coordinates and orthonormal current view axes are required.");

            var center=a.Zip(b,(v,w)=>v/2+w/2).ToArray();
            var half=a.Zip(b,(v,w)=>Math.Abs(v/2-w/2)).ToArray();
            // Equivalent to the extrema of all eight projected corners. The
            // two world-diagonal endpoints alone can cancel in screen space.
            var halfWidth=half.Zip(right,(v,w)=>v*Math.Abs(w)).Sum();
            var halfHeight=half.Zip(up,(v,w)=>v*Math.Abs(w)).Sum();
            // Five percent context each side; one inch minimum for flat boxes.
            halfWidth += Math.Max(halfWidth*.1,1d/12);
            halfHeight += Math.Max(halfHeight*.1,1d/12);
            var low=Enumerable.Range(0,3).Select(i=>center[i]-right[i]*halfWidth-up[i]*halfHeight).ToArray();
            var high=Enumerable.Range(0,3).Select(i=>center[i]+right[i]*halfWidth+up[i]*halfHeight).ToArray();
            if (!low.All(Finite) || !high.All(Finite)) throw new ArgumentException("Projected box is not finite.");
            return new[]{low,high};
        }
    }
}
