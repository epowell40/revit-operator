using System;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Navigation bounds only; not a placement point, visibility or fit verdict.</summary>
    public sealed class NativeAccessoryPlanFocus
    {
        public double[] Center { get; private set; } = Array.Empty<double>();
        public double[] LowerLeft { get; private set; } = Array.Empty<double>();
        public double[] UpperRight { get; private set; } = Array.Empty<double>();
        public double HalfSpanFt { get; private set; }

        public static NativeAccessoryPlanFocus? Create(int hostCount, int maximumPlacements, bool isPlan,
            double[] start, double[] end, double[] right, double[] up, double hostSizeFt)
        {
            if (hostCount != 1 || maximumPlacements != 1 || !isPlan) return null;
            bool Finite(double n) => !double.IsNaN(n) && !double.IsInfinity(n);
            bool Vector(double[] v) => v != null && v.Length == 3 && v.All(Finite);
            double Dot(double[] a, double[] b) => a.Zip(b, (x,y)=>x*y).Sum();
            if (!Vector(start) || !Vector(end) || !Vector(right) || !Vector(up)
                || !Finite(hostSizeFt) || hostSizeFt <= 0 || hostSizeFt > 100
                || Math.Abs(Dot(right,right)-1)>1e-6 || Math.Abs(Dot(up,up)-1)>1e-6
                || Math.Abs(Dot(right,up))>1e-6)
                throw new ArgumentException("Current finite host geometry and orthonormal plan axes are required.");
            var delta=end.Zip(start,(a,b)=>a-b).ToArray();
            var projectedLength=Math.Sqrt(Math.Pow(Dot(delta,right),2)+Math.Pow(Dot(delta,up),2));
            if (!Finite(projectedLength)) throw new ArgumentException("Host projection is not finite.");
            if (projectedLength < 1e-6) return null; // End-on pipe has no visible plan segment.
            var center=start.Zip(end,(a,b)=>a/2+b/2).ToArray();
            var half=Math.Max(2d,hostSizeFt*4d);
            var lower=center.Select((x,i)=>x-half*(right[i]+up[i])).ToArray();
            var upper=center.Select((x,i)=>x+half*(right[i]+up[i])).ToArray();
            if (!Vector(center)||!Vector(lower)||!Vector(upper)) throw new ArgumentException("Focus bounds are not finite.");
            return new NativeAccessoryPlanFocus { Center=center,LowerLeft=lower,UpperRight=upper,HalfSpanFt=half };
        }
    }
}
