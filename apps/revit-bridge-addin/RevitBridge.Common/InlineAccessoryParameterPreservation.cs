using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class InlineAccessoryParameterPreservation
    {
        // Writable IFC_GUID can be copied by a native split. Native UniqueId,
        // checked separately, identifies the new element; this field does not.
        private const long IfcGuid = -1019000;
        // Only observed derived elevation fields, in internal feet. This bound
        // is one millionth of the separate 1e-6 ft geometric tolerance. Never
        // apply it to sizing, flow, pressure or arbitrary Double data. The two
        // center-elevation/offset aliases are observed in provisional85 and use
        // the same sub-geometric roundoff bound; a real elevation edit fails.
        private static readonly HashSet<long> DerivedElevations = new HashSet<long>
            { -1141029, -1140240, -1141026, -1141020, -1140239, -1141021, -1114132 };
        private const double ElevationRoundoffFt = 1e-12;
        public static bool Matches(string before, string after, bool isNewSegment)
        {
            try
            {
                using var b = Read(before); using var a = Read(after);
                var prior = b.RootElement.EnumerateArray().ToArray();
                var current = a.RootElement.EnumerateArray().ToArray();
                if (prior.Length != current.Length) return false;
                for (var i = 0; i < prior.Length; i++)
                {
                    var p = prior[i]; var n = current[i];
                    var id = p.GetProperty("id").GetInt64();
                    if (id != n.GetProperty("id").GetInt64()) return false;
                    if (DerivedElevations.Contains(id))
                    {
                        if (p.GetProperty("storage").GetString() != "Double" || n.GetProperty("storage").GetString() != "Double"
                            || !FiniteScalar(p.GetProperty("value").GetString(), out var x)
                            || !FiniteScalar(n.GetProperty("value").GetString(), out var y)
                            || Math.Abs(x - y) > ElevationRoundoffFt) return false;
                        continue;
                    }
                    if (id != IfcGuid || !isNewSegment)
                    { if (p.GetRawText() != n.GetRawText()) return false; continue; }
                    if (p.GetProperty("storage").GetString() != "String" || n.GetProperty("storage").GetString() != "String") return false;
                    var oldIdentity = p.GetProperty("value").GetString(); var newIdentity = n.GetProperty("value").GetString();
                    if (!ValidIfc(oldIdentity) || !ValidIfc(newIdentity)) return false;
                }
                return true;
            }
            catch { return false; }
        }
        private static bool ValidIfc(string? value) => value != null && Regex.IsMatch(value, "^[0-3][0-9A-Za-z_$]{21}$");
        private static bool FiniteScalar(string? text, out double value)
        {
            value = 0;
            return text != null && Regex.IsMatch(text, @"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
                && double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out value)
                && !double.IsNaN(value) && !double.IsInfinity(value);
        }
        private static JsonDocument Read(string value)
        {
            if (value == null || value.Length > 128000) throw new ArgumentException("Parameter observation exceeds bound.");
            var doc = JsonDocument.Parse(value);
            try
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() > 2048) throw new ArgumentException("Parameter array required.");
                var seen = new HashSet<long>(); long previous = long.MinValue;
                foreach (var row in doc.RootElement.EnumerateArray())
                {
                    var names = row.EnumerateObject().Select(p => p.Name).ToArray();
                    if (names.Length != 3 || !names.Contains("id") || !names.Contains("storage") || !names.Contains("value")) throw new ArgumentException("Unexpected parameter fields.");
                    var id = row.GetProperty("id").GetInt64(); var storage = row.GetProperty("storage").GetString();
                    if (id == 0 || id <= previous || !seen.Add(id) || !new[] { "String", "Double", "Integer", "ElementId", "None" }.Contains(storage)) throw new ArgumentException("Invalid parameter identity or storage.");
                    var scalar = row.GetProperty("value");
                    if (scalar.ValueKind != JsonValueKind.String && scalar.ValueKind != JsonValueKind.Null) throw new ArgumentException("Native scalar string required.");
                    previous = id;
                }
                return doc;
            }
            catch { doc.Dispose(); throw; }
        }
        public static string ChangedIds(string before, string after)
        {
            try
            {
                using var b = Read(before); using var a = Read(after);
                var prior = b.RootElement.EnumerateArray().ToDictionary(p => p.GetProperty("id").GetInt64(), p => p.GetRawText());
                var current = a.RootElement.EnumerateArray().ToDictionary(p => p.GetProperty("id").GetInt64(), p => p.GetRawText());
                return string.Join(",", prior.Keys.Union(current.Keys).OrderBy(id => id)
                    .Where(id => !prior.TryGetValue(id, out var x) || !current.TryGetValue(id, out var y) || x != y).Take(8));
            }
            catch { return "unavailable"; }
        }
    }
}
