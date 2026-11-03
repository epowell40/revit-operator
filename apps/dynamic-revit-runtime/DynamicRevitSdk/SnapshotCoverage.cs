using System;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

/// <summary>Native enumeration coverage, not proof that every requested parameter exists or was readable.</summary>
public sealed class DynamicSnapshotCoverage
{
    public const int MaximumReadRows = 4096;
    public const int MaximumWriteRows = 1000;
    public string SourceScope { get; set; } = "active_document_non_type_elements";
    public string? Category { get; set; }
    public string[] ParameterNames { get; set; } = Array.Empty<string>();
    public int Limit { get; set; }
    public int ReturnedCount { get; set; }
    public bool HasMore { get; set; }

    public static DynamicSnapshotCoverage Create(string? category, string[] parameterNames, int limit, int returnedCount, bool hasMore)
    {
        var value = new DynamicSnapshotCoverage { Category = category, ParameterNames = parameterNames.ToArray(),
            Limit = limit, ReturnedCount = returnedCount, HasMore = hasMore };
        value.Validate(returnedCount);
        return value;
    }

    public void Validate(int actualCount)
    {
        if (SourceScope != "active_document_non_type_elements" || Limit < 1 || Limit > MaximumReadRows ||
            ReturnedCount < 0 || ReturnedCount > Limit || ReturnedCount != actualCount || HasMore && ReturnedCount != Limit ||
            Category != null && (string.IsNullOrWhiteSpace(Category) || Category.Length > 128) ||
            ParameterNames == null || ParameterNames.Length > 16 ||
            ParameterNames.Any(p => string.IsNullOrWhiteSpace(p) || p.Length > 128) ||
            ParameterNames.Distinct(StringComparer.Ordinal).Count() != ParameterNames.Length)
            throw new ArgumentException("Snapshot coverage is invalid or does not match the returned native rows.");
    }
}
