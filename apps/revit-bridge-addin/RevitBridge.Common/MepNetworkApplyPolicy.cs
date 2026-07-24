using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class MepNetworkVerificationResult
    {
        public bool Pass { get; set; }
        public List<long> MissingElementIds { get; set; } = new List<long>();
        public List<int> FailedAuditBranchIndices { get; set; } = new List<int>();
    }

    public static class MepNetworkApplyPolicy
    {
        public static MepNetworkVerificationResult Verify(
            IEnumerable<long>? expectedElementIds,
            IEnumerable<long>? existingElementIds,
            IEnumerable<string?>? branchAuditStatuses,
            bool verifyAudits)
        {
            var expected = new HashSet<long>((expectedElementIds ?? Array.Empty<long>()).Where(id => id > 0));
            var existing = new HashSet<long>((existingElementIds ?? Array.Empty<long>()).Where(id => id > 0));
            var missing = expected.Where(id => !existing.Contains(id)).OrderBy(id => id).ToList();
            var failedAudits = new List<int>();

            if (verifyAudits)
            {
                var statuses = (branchAuditStatuses ?? Array.Empty<string?>()).ToList();
                for (var index = 0; index < statuses.Count; index++)
                {
                    if (!IsPositiveAudit(statuses[index])) failedAudits.Add(index);
                }
            }

            return new MepNetworkVerificationResult
            {
                Pass = missing.Count == 0 && failedAudits.Count == 0,
                MissingElementIds = missing,
                FailedAuditBranchIndices = failedAudits
            };
        }

        private static bool IsPositiveAudit(string? status)
        {
            var value = (status ?? "").Trim();
            return value.Equals("ok", StringComparison.OrdinalIgnoreCase)
                || value.Equals("passed", StringComparison.OrdinalIgnoreCase)
                || value.Equals("success", StringComparison.OrdinalIgnoreCase);
        }
    }
}
