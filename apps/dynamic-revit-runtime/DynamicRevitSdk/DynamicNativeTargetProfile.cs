using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitOperator.DynamicRevitSdk;

// Closed platform profiles, not caller-selected assembly references. Actual
// bytes still come from the native host and remain pinned through compilation.
public static class DynamicNativeTargetProfile
{
    private static readonly string[] Framework = { "RevitAPI", "System", "System.Core", "mscorlib" };
    private static readonly string[] Core = { "RevitAPI", "System.Collections", "System.Linq", "System.Private.CoreLib", "System.Runtime", "System.Runtime.Extensions" };
    public static bool Supports(int year) => year >= 2023 && year <= 2027;
    public static int FrameworkMajor(int year)
        => !Supports(year) ? throw new ArgumentException("Unsupported native Revit target.") : year <= 2024 ? 4 : year <= 2026 ? 8 : 10;
    public static string[] ReferenceNames(int year)
        => (FrameworkMajor(year) == 4 ? Framework : Core).ToArray();
    public static bool KnownReferenceNames(IEnumerable<string> names)
    {
        var actual = names.OrderBy(n => n, StringComparer.Ordinal).ToArray();
        return actual.SequenceEqual(Framework) || actual.SequenceEqual(Core);
    }
    public static bool MatchesAssembly(int year, string name, string version)
    {
        return Supports(year) && ReferenceNames(year).Contains(name) && Version.TryParse(version, out var parsed)
            && parsed.Major == (name == "RevitAPI" ? year - 2000 : FrameworkMajor(year));
    }
}
