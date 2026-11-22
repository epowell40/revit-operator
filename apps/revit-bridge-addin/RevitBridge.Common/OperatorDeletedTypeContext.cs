using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    // Diagnostic identity only. This never changes transaction settlement,
    // establishes unused/safe deletion, or grants a retry/verification.
    public sealed class OperatorDeletedTypeContext
    {
        public sealed class Identity
        {
            public long Id { get; set; }
            public string UniqueId { get; set; } = "";
            public string ClassName { get; set; } = "";
            public string Name { get; set; } = "";
            public string FamilyName { get; set; } = "";
        }
        private readonly Dictionary<long, Identity> identities = new Dictionary<long, Identity>();
        public int Examined { get; private set; }
        public string Coverage { get; private set; } = "complete";
        public long ElapsedMilliseconds { get; private set; }
        public int ReadErrors { get; private set; }
        public const int MaximumTypes = 4096;
        public const int MaximumMilliseconds = 250;
        public const int MaximumReturnedDeletions = 16;

        public static OperatorDeletedTypeContext Capture(IEnumerable<long> typeIds, Func<long, Identity> read, Func<long> elapsed)
        {
            var snapshot = new OperatorDeletedTypeContext();
            try
            {
                foreach (var id in typeIds)
                {
                    if (elapsed() >= MaximumMilliseconds) { snapshot.Coverage = "time_limited"; break; }
                    if (snapshot.Examined >= MaximumTypes) { snapshot.Coverage = "count_limited"; break; }
                    snapshot.Examined++;
                    try
                    {
                        var identity = read(id);
                        if (id <= 0 || identity == null || identity.Id != id || snapshot.identities.ContainsKey(id)
                            || !Valid(identity.UniqueId, 128, false) || !Valid(identity.ClassName, 128, false)
                            || !Valid(identity.Name, 512, true) || !Valid(identity.FamilyName, 512, true))
                            throw new InvalidOperationException("Invalid type identity.");
                        snapshot.identities.Add(id, identity);
                    }
                    catch { snapshot.ReadErrors++; snapshot.Coverage = "read_errors"; }
                }
                snapshot.ElapsedMilliseconds = Math.Max(0, elapsed());
            }
            catch { snapshot.ReadErrors++; snapshot.Coverage = "read_errors"; }
            return snapshot;
        }

        private static bool Valid(string value, int maximum, bool empty)
            => value != null && value.Length <= maximum && (empty || value.Length > 0);

        public void Attach(Dictionary<string, object?> result)
        {
            if (!result.TryGetValue("success", out var ok) || !(ok is bool success) || !success
                || !result.TryGetValue("transaction", out var value) || !(value is OperatorNativeTransactionReceipt receipt)
                || receipt.Status != "committed" || receipt.CommittedValue != true || receipt.DeletedElementIds.Count == 0) return;
            var rows = receipt.DeletedElementIds.Take(MaximumReturnedDeletions).Select(id =>
            {
                if (!identities.TryGetValue(id, out var item))
                    return (object)new { element_id = id, state = "not_observed_as_type" };
                return new { element_id = id, state = "observed_type_before_execution", unique_id = item.UniqueId,
                    class_name = item.ClassName, name = item.Name, family_name = item.FamilyName };
            }).ToArray();
            result["deleted_type_context"] = new { schema = "operator.deleted-type-context.v1", purpose = "diagnostic_only",
                baseline_coverage = Coverage, examined_types = Examined, captured_types = identities.Count,
                read_errors = ReadErrors, elapsed_milliseconds = ElapsedMilliseconds, deleted_count = receipt.DeletedElementIds.Count,
                returned_count = rows.Length, rows, deletion_safety_verified = false };
        }
    }
}
