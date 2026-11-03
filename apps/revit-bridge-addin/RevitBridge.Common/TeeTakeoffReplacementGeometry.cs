using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>Geometry-only contract. Native identity/topology and fitting fit remain mandatory.</summary>
    public sealed class TeeTakeoffBridgePlan
    {
        public BranchPoint3d Start { get; set; }
        public BranchPoint3d End { get; set; }
        public BranchPoint3d BranchOrigin { get; set; }
        public double ProjectionFraction { get; set; }
        public double BranchOffsetFt { get; set; }
    }

    public static class TeeTakeoffReplacementGeometry
    {
        public static TeeTakeoffBridgePlan Plan(BranchPoint3d start, BranchPoint3d end,
            BranchPoint3d branch, BranchPoint3d firstRunOutward, BranchPoint3d secondRunOutward,
            double firstDiameterFt, double secondDiameterFt, double branchDiameterFt,
            double shortCurveToleranceFt, double toleranceFt)
        {
            foreach (var p in new[] { start, end, branch, firstRunOutward, secondRunOutward })
                if (!Finite(p.X) || !Finite(p.Y) || !Finite(p.Z)) throw new ArgumentException("Junction coordinates must be finite.");
            if (!Positive(shortCurveToleranceFt) || !Positive(toleranceFt) || toleranceFt > 0.01 ||
                !Positive(firstDiameterFt) || !Positive(secondDiameterFt) || !Positive(branchDiameterFt))
                throw new ArgumentException("Junction dimensions and tolerances must be positive finite values; tolerance is at most 0.01 ft.");
            var v = Subtract(end,start); var length = Norm(v);
            if (length <= shortCurveToleranceFt || Math.Abs(firstDiameterFt-secondDiameterFt)>toleranceFt)
                throw new ArgumentException("Replacement requires a constructible straight bridge with equal run diameters.");
            var axis = Scale(v,1/length);
            if (Dot(Unit(firstRunOutward),axis)>-0.999999 || Dot(Unit(secondRunOutward),axis)<0.999999)
                throw new ArgumentException("Run connector directions must oppose and align with the replacement bridge.");
            var fraction = Dot(Subtract(branch,start),axis)/length;
            var projected = Add(start,Scale(v,fraction)); var offset = branch.DistanceTo(projected);
            if (fraction*length <= shortCurveToleranceFt || (1-fraction)*length <= shortCurveToleranceFt || offset <= toleranceFt)
                throw new ArgumentException("Branch projection must lie strictly inside the bridge and off its axis.");
            return new TeeTakeoffBridgePlan { Start=start,End=end,BranchOrigin=branch,
                ProjectionFraction=fraction,BranchOffsetFt=offset };
        }

        public static void RequireOnlyRequestedDeletion(long teeId,IEnumerable<long> deletedIds)
        {
            const string rejection="Replacing the tee would delete additional elements; the atomic operation must roll back.";
            if (teeId<=0) throw new InvalidOperationException(rejection);
            var candidates=deletedIds.OrderBy(x=>x).ToArray();
            if (!candidates.SequenceEqual(new[]{teeId}))
            {
                var additional=candidates.Where(x=>x!=teeId).ToArray();
                // These IDs describe Delete's candidate set, not a persisted
                // effect. The enclosing transaction's settlement stays authoritative.
                throw new InvalidOperationException(rejection+" requestedTeeId="+teeId.ToString(CultureInfo.InvariantCulture)
                    +"; candidateCount="+candidates.Length.ToString(CultureInfo.InvariantCulture)
                    +"; additionalCandidateCount="+additional.Length.ToString(CultureInfo.InvariantCulture)
                    +"; candidateIds(first16)="+CandidateIds(candidates)
                    +"; additionalCandidateIds(first16)="+CandidateIds(additional)
                    +". Candidate identities describe the attempted deletion only; native transaction settlement determines persistent effects.");
            }
        }

        private static string CandidateIds(IEnumerable<long> ids)
            =>"["+string.Join(",",ids.Take(16).Select(x=>x.ToString(CultureInfo.InvariantCulture)))+"]";

        private static bool Finite(double x)=>!double.IsNaN(x)&&!double.IsInfinity(x);
        private static bool Positive(double x)=>Finite(x)&&x>0;
        private static BranchPoint3d Subtract(BranchPoint3d a,BranchPoint3d b)=>new BranchPoint3d(a.X-b.X,a.Y-b.Y,a.Z-b.Z);
        private static BranchPoint3d Add(BranchPoint3d a,BranchPoint3d b)=>new BranchPoint3d(a.X+b.X,a.Y+b.Y,a.Z+b.Z);
        private static BranchPoint3d Scale(BranchPoint3d a,double v)=>new BranchPoint3d(a.X*v,a.Y*v,a.Z*v);
        private static double Dot(BranchPoint3d a,BranchPoint3d b)=>a.X*b.X+a.Y*b.Y+a.Z*b.Z;
        private static double Norm(BranchPoint3d a)=>Math.Sqrt(Dot(a,a));
        private static BranchPoint3d Unit(BranchPoint3d a)
        { var n=Norm(a);if(n<1e-9)throw new ArgumentException("Connector direction is undefined.");return Scale(a,1/n); }
    }
}
