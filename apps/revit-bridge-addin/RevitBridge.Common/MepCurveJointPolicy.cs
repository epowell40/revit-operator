using System;

namespace RevitBridge.Common
{
    public static class MepCurveJointPolicy
    {
        // Connector axes point out of their owners. A bare curve-to-curve
        // connection is valid only when the ports face one another.
        public static bool AllowsDirectConnection(double[] a, double[] b)
        {
            if (a == null || b == null || a.Length != 3 || b.Length != 3) return false;
            double aa = 0, bb = 0, ab = 0;
            for (var i = 0; i < 3; i++)
            {
                if (double.IsNaN(a[i]) || double.IsInfinity(a[i]) || double.IsNaN(b[i]) || double.IsInfinity(b[i])) return false;
                aa += a[i] * a[i]; bb += b[i] * b[i]; ab += a[i] * b[i];
            }
            if (aa < 1e-12 || bb < 1e-12) return false;
            return ab / Math.Sqrt(aa * bb) <= -1.0 + 1e-8;
        }
    }
}
