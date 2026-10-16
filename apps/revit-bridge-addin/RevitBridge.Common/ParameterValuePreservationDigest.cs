using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class PreservedParameterValue
    {
        public long Id { get; set; }
        public string Name { get; set; } = "";
        public string Storage { get; set; } = "";
        public bool HasValue { get; set; }
        public object? Value { get; set; }
        public bool IsReadOnly { get; set; }
        public bool UserModifiable { get; set; }
        public string? SharedGuid { get; set; }
    }

    /// <summary>Raw native values, ordered by parameter ID; never merge equal display names.</summary>
    public static class ParameterValuePreservationDigest
    {
        public static string Compute(IEnumerable<PreservedParameterValue> parameters, long? excludedParameterId, out int count)
        {
            var rows = new List<PreservedParameterValue>(); var ids = new HashSet<long>();
            foreach (var p in parameters)
            {
                if (excludedParameterId.HasValue && p.Id == excludedParameterId.Value) continue;
                if (rows.Count >= 2048) throw new InvalidOperationException("Parameter preservation exceeds 2048 values per element.");
                if (!ids.Add(p.Id)) throw new InvalidOperationException("Duplicate native parameter ID prevents complete preservation.");
                if (!Valid(p)) throw new InvalidOperationException("Unsupported native parameter value prevents complete preservation.");
                rows.Add(p);
            }
            count = rows.Count;
            using var sha = SHA256.Create();
            return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(rows.OrderBy(p => p.Id).ToArray()))))
                .Replace("-", "").ToLowerInvariant();
        }

        private static bool Valid(PreservedParameterValue p)
        {
            if (p.Id == 0 || string.IsNullOrEmpty(p.Name)) return false;
            if (!new[] { "None", "String", "Integer", "Double", "ElementId" }.Contains(p.Storage)) return false;
            if (!p.HasValue) return p.Value == null;
            return p.Storage == "String" ? p.Value == null || p.Value is string
                : p.Storage == "Integer" ? p.Value is int
                : p.Storage == "ElementId" ? p.Value is long
                : p.Storage == "Double" && p.Value is double number && !double.IsNaN(number) && !double.IsInfinity(number);
        }
    }
}
