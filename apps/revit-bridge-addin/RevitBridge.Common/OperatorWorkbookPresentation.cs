using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>A readable projection of the native export, preserving its row order.
    /// Detailed native identities, units and failures stay in Elements and Issues.</summary>
    public static class OperatorWorkbookPresentation
    {
        public static OperatorWorkbookWriter.Sheet Build(IReadOnlyList<string> names, IReadOnlyList<IReadOnlyList<object?>> elements)
        {
            if (names.Count == 0 || elements.Count == 0 || elements.Any(r => r.Count != 4 + 4 * names.Count))
                throw new ArgumentException("Native workbook table shape is invalid.");
            var headers = new List<object?>();
            var mixed = new bool[names.Count];
            for (var c = 0; c < names.Count; c++)
            {
                var units = elements.Skip(1).Select(r => r[5 + c * 4] as string ?? "").Where(u => u.Length > 0).Distinct(StringComparer.Ordinal).ToArray();
                mixed[c] = units.Length > 1;
                var unit = units.Length == 1 ? units[0].Split('[')[0].Trim() : "";
                headers.Add(names[c] + (mixed[c] ? " (mixed units; see Elements)" : unit.Length > 0 && unit != "dimensionless" && unit != "integer" && unit != "boolean" ? " (" + unit + ")" : ""));
            }
            var rows = new List<IReadOnlyList<object?>> { headers };
            foreach (var source in elements.Skip(1))
            {
                var row = new List<object?>();
                for (var c = 0; c < names.Count; c++)
                {
                    var index = 4 + c * 4;
                    var status = source[index + 3] as string;
                    // Missing/unreadable data stays blank, never fabricated zero.
                    row.Add(status != "ok" ? null : mixed[c] ? source[index + 2] : source[index]);
                }
                rows.Add(row);
            }
            return new OperatorWorkbookWriter.Sheet("Table", rows);
        }
    }
}
