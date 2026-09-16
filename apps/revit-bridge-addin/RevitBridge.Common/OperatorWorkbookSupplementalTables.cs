using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>Assistant-authored tables remain visibly separate from native
    /// model values. Every selected target must appear exactly once per table.</summary>
    public static class OperatorWorkbookSupplementalTables
    {
        public sealed class Table
        {
            public string? name { get; set; }
            public string? contentKind { get; set; }
            public List<string>? columns { get; set; }
            public List<Row>? rows { get; set; }
        }
        public sealed class Row
        {
            public long elementId { get; set; }
            public List<JsonElement>? values { get; set; }
        }
        public sealed class NativeIdentity
        {
            public long ElementId { get; set; }
            public string UniqueId { get; set; } = "";
            public string Name { get; set; } = "";
        }
        public static IReadOnlyList<OperatorWorkbookWriter.Sheet> Build(
            IReadOnlyList<Table>? tables, IReadOnlyList<NativeIdentity> selected)
        {
            if (tables == null || tables.Count == 0) return Array.Empty<OperatorWorkbookWriter.Sheet>();
            if (tables.Count > 4 || selected.Count < 1 || selected.Count > 2000
                || selected.Select(row => row.ElementId).Distinct().Count() != selected.Count
                || selected.Any(row => row.ElementId <= 0 || string.IsNullOrWhiteSpace(row.UniqueId)))
                throw new ArgumentException("Provide at most four supplemental tables bound to a complete selected native population.");
            var sheetNames = new HashSet<string>(new[] { "Elements", "Issues", "Readme" }, StringComparer.OrdinalIgnoreCase);
            var native = selected.ToDictionary(row => row.ElementId);
            var output = new List<OperatorWorkbookWriter.Sheet>();
            var totalCells = 0;
            var totalText = 0;
            foreach (var table in tables)
            {
                if (table == null) throw new ArgumentException("Supplemental table cannot be null.");
                var name = (table.name ?? "").Trim();
                if (name.Length < 1 || name.Length > 31 || name.IndexOfAny("[]:*?/\\".ToCharArray()) >= 0
                    || name.StartsWith("'", StringComparison.Ordinal) || name.EndsWith("'", StringComparison.Ordinal) || !sheetNames.Add(name))
                    throw new ArgumentException("Supplemental sheet names must be unique Excel names and cannot replace Elements, Issues or Readme.");
                System.Xml.XmlConvert.VerifyXmlChars(name);
                if (table.contentKind != "user_input_transcription" && table.contentKind != "assistant_proposal" && table.contentKind != "review")
                    throw new ArgumentException("contentKind must be user_input_transcription, assistant_proposal or review. None establishes native or engineering truth.");
                var columns = table.columns;
                if (columns == null || columns.Count < 1 || columns.Count > 32
                    || columns.Any(column => string.IsNullOrWhiteSpace(column) || column.Length > 128)
                    || columns.Select(column => column.Trim()).Distinct(StringComparer.OrdinalIgnoreCase).Count() != columns.Count)
                    throw new ArgumentException("Provide 1 to 32 unique, bounded supplemental column labels.");
                foreach (var column in columns) System.Xml.XmlConvert.VerifyXmlChars(column);
                var rows = table.rows;
                if (rows == null || rows.Count != selected.Count || rows.Any(row => row == null)
                    || rows.Select(row => row.elementId).Distinct().Count() != selected.Count
                    || rows.Any(row => !native.ContainsKey(row.elementId)))
                    throw new ArgumentException("Every supplemental table must contain each selected elementId exactly once. Missing, duplicate and foreign rows are rejected before writing.");
                totalCells += rows.Count * columns.Count;
                if (totalCells > 64000) throw new ArgumentException("Supplemental tables exceed the total 64000-cell limit.");
                var headers = new List<object?> { "Native ElementId", "Native UniqueId", "Native Name", "Content origin" };
                headers.AddRange(columns.Select(column => (object?)("Table | " + column)));
                var cells = new List<IReadOnlyList<object?>> { headers };
                foreach (var row in rows)
                {
                    if (row.values == null || row.values.Count != columns.Count) throw new ArgumentException("Each supplemental row must provide exactly one value per column.");
                    var identity = native[row.elementId];
                    var values = new List<object?> { identity.ElementId.ToString(System.Globalization.CultureInfo.InvariantCulture), identity.UniqueId, identity.Name,
                        "Assistant-authored " + table.contentKind + "; verify supplied values and calculations" };
                    foreach (var cell in row.values)
                    {
                        var scalar = Scalar(cell);
                        totalText += scalar is string text ? text.Length : 0;
                        if (totalText > 1000000) throw new ArgumentException("Supplemental tables exceed the total 1000000-character text limit.");
                        values.Add(scalar);
                    }
                    cells.Add(values);
                }
                output.Add(new OperatorWorkbookWriter.Sheet(name, cells));
            }
            return output;
        }
        private static object? Scalar(JsonElement value)
        {
            switch (value.ValueKind)
            {
                case JsonValueKind.Null: return null;
                case JsonValueKind.True: return true;
                case JsonValueKind.False: return false;
                case JsonValueKind.Number:
                    if (value.TryGetInt64(out var integer)) return integer >= -999999999999999L && integer <= 999999999999999L
                        ? (object)integer : integer.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (value.TryGetDecimal(out var exact))
                    {
                        var decimalText = exact.ToString(System.Globalization.CultureInfo.InvariantCulture);
                        var digits = decimalText.TrimStart('-').Replace(".", "").TrimStart('0').TrimEnd('0').Length;
                        return digits <= 15 ? (object)exact : decimalText;
                    }
                    if (!value.TryGetDouble(out var number) || double.IsNaN(number) || double.IsInfinity(number))
                        throw new ArgumentException("Supplemental numeric values must be finite.");
                    // Preserve a finite value outside decimal range as text;
                    // the spreadsheet must not silently round its transcription.
                    return value.GetRawText();
                case JsonValueKind.String:
                    var text = value.GetString() ?? "";
                    if (text.Length > 8192) throw new ArgumentException("Supplemental cell text exceeds 8192 characters.");
                    System.Xml.XmlConvert.VerifyXmlChars(text);
                    return text;
                default: throw new ArgumentException("Supplemental values must be scalar JSON values; nested objects and arrays are not accepted.");
            }
        }
    }
}
