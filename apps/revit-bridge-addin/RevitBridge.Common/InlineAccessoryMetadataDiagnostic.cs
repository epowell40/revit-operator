using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    // Diagnostic only. The native preservation comparison remains exact.
    public static class InlineAccessoryMetadataDiagnostic
    {
        private static readonly string[] Fields = { "type", "phase", "demolished", "workset", "systemType", "level", "diameter" };
        public static string Describe(string before, string after)
        {
            try
            {
                using var b = Read(before); using var a = Read(after);
                var differences = Fields.Where(f => b.RootElement.GetProperty(f).GetRawText() != a.RootElement.GetProperty(f).GetRawText())
                    .Select(f => f + ":" + b.RootElement.GetProperty(f).GetRawText() + "->" + a.RootElement.GetProperty(f).GetRawText()).ToArray();
                return "metadata; differences=" + (differences.Length > 0 ? string.Join(",", differences)
                    : before == after ? "none" : "serialization_only");
            }
            catch { return "metadata; differences=unavailable"; }
        }
        private static JsonDocument Read(string value)
        {
            if (value == null || value.Length > 4096) throw new ArgumentException("Bounded native metadata required.");
            var doc = JsonDocument.Parse(value, new JsonDocumentOptions { MaxDepth = 3 });
            try
            {
                var fields = doc.RootElement.EnumerateObject().ToArray();
                if (fields.Length != Fields.Length || new HashSet<string>(fields.Select(p => p.Name)).Count != Fields.Length
                    || fields.Any(p => !Fields.Contains(p.Name))) throw new ArgumentException("Exact native fields required.");
                foreach (var p in fields)
                {
                    if (p.Value.ValueKind == JsonValueKind.Null && (p.Name == "systemType" || p.Name == "level" || p.Name == "diameter")) continue;
                    if (p.Name == "diameter")
                    {
                        if (!p.Value.TryGetDouble(out var n) || double.IsNaN(n) || double.IsInfinity(n) || n <= 0)
                            throw new ArgumentException("Native positive diameter required.");
                    }
                    else if (!p.Value.TryGetInt64(out _)) throw new ArgumentException("Native integer identity required.");
                }
                return doc;
            }
            catch { doc.Dispose(); throw; }
        }
    }
}
