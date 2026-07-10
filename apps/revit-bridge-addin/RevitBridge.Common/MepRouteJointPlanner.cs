using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public sealed class MepRouteJointPlan
    {
        public int JointIndex { get; set; }
        public string ExpectedFitting { get; set; } = "connect";
        public string Reason { get; set; } = "";
        public string FromSize { get; set; } = "";
        public string ToSize { get; set; } = "";
    }

    public static class MepRouteJointPlanner
    {
        public static List<MepRouteJointPlan> PlanJoints(IReadOnlyList<string?> segmentSizes)
        {
            var plans = new List<MepRouteJointPlan>();
            if (segmentSizes == null || segmentSizes.Count < 2) return plans;

            for (var i = 0; i < segmentSizes.Count - 1; i++)
            {
                var from = NormalizeSize(segmentSizes[i]);
                var to = NormalizeSize(segmentSizes[i + 1]);
                var expected = from.Length > 0 && to.Length > 0 && !string.Equals(from, to, StringComparison.OrdinalIgnoreCase)
                    ? "transition"
                    : "elbow_or_connect";
                plans.Add(new MepRouteJointPlan
                {
                    JointIndex = i,
                    ExpectedFitting = expected,
                    Reason = expected == "transition" ? "adjacent segment sizes differ" : "adjacent segment sizes match or are unspecified",
                    FromSize = from,
                    ToSize = to
                });
            }

            return plans;
        }

        public static string NormalizeSize(string? raw)
        {
            var value = (raw ?? "").Trim();
            if (value.Length == 0) return "";
            return value
                .Replace("×", "x")
                .Replace("X", "x")
                .Replace("\"", "")
                .ToLowerInvariant()
                .Replace(" inches", "")
                .Replace(" inch", "")
                .Replace(" in", "")
                .Replace(" ", "")
                .Trim();
        }
    }
}
