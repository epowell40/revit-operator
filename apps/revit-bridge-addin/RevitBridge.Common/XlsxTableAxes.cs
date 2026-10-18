using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    internal static class XlsxTableAxes
    {
        internal static bool Inside(XlsxSourceRange r, int row, int column) => row >= r.FirstRow && row <= r.LastRow && column >= r.FirstColumn && column <= r.LastColumn;
        internal static bool Intersects(XlsxSourceRange a, XlsxSourceRange b) => a.FirstRow <= b.LastRow && a.LastRow >= b.FirstRow && a.FirstColumn <= b.LastColumn && a.LastColumn >= b.FirstColumn;
        internal static bool Contains(XlsxSourceRange a, XlsxSourceRange b) => Inside(a, b.FirstRow, b.FirstColumn) && Inside(a, b.LastRow, b.LastColumn);
        internal static void Validate(XlsxSourceRange r)
        {
            if (r.FirstRow < 1 || r.LastRow < r.FirstRow || r.LastRow > 1048576 || r.FirstColumn < 1 || r.LastColumn < r.FirstColumn || r.LastColumn > 16384)
                throw new ArgumentException("Invalid worksheet layout range.");
            if ((long)(r.LastRow - r.FirstRow + 1) * (r.LastColumn - r.FirstColumn + 1) > 250000 || r.LastColumn - r.FirstColumn >= 512)
                throw new InvalidOperationException("Worksheet layout extent exceeds250000slots/512columns. Select an explicit bounded range; nothing was truncated.");
        }
        // ISO29500 column-width conversion, documented by Microsoft Column.Width:
        // width is already padded characters. The caller supplies the measured
        // Normal font's maximum digit width at96DPI; it is never guessed here.
        internal static double ColumnInches(double width, double maximumDigitWidthPixels)
        {
            if (!Finite(width) || width < 0 || width > 255 || !Finite(maximumDigitWidthPixels) || maximumDigitWidthPixels <= 0 || maximumDigitWidthPixels > 200)
                throw new ArgumentException("Invalid measured column geometry.");
            return Math.Floor(((256 * width + Math.Floor(128 / maximumDigitWidthPixels)) / 256) * maximumDigitWidthPixels) / 96;
        }
        internal static List<List<int>> Bands(IReadOnlyList<int> indices, Dictionary<int, double> sizes, double firstCapacity,
            double continuationCapacity, IReadOnlyList<XlsxSourceRange> merges, bool rows)
        {
            var output = new List<List<int>>();int start = 0;
            while (start < indices.Count)
            {
                double capacity = output.Count == 0 ? firstCapacity : continuationCapacity, used = 0;int end = start;
                while (end < indices.Count && used + sizes[indices[end]] <= capacity + 1e-9) used += sizes[indices[end++]];
                if (end < indices.Count)
                {
                    // Back up to a complete merge boundary rather than split
                    // a merged heading or let its text disappear on page2.
                    while (end > start && merges.Any(m => (rows ? m.FirstRow : m.FirstColumn) <= indices[end - 1]
                        && (rows ? m.LastRow : m.LastColumn) >= indices[end])) end--;
                }
                if (end == start) throw new InvalidOperationException("A complete row/column merge group cannot fit a readable page; increase usable geometry or explicitly revise the layout.");
                output.Add(indices.Skip(start).Take(end - start).ToList());start = end;
            }
            return output;
        }
        internal static Dictionary<int, double> Offsets(IEnumerable<int> indices, Dictionary<int, double> sizes)
        {
            var result = new Dictionary<int, double>();double offset = 0;
            foreach (var index in indices) { result.Add(index, offset);offset += sizes[index]; }
            return result;
        }
        internal static string Ref(int row, int column)
        {
            string letters = "";while (column > 0) { column--;letters = (char)('A' + column % 26) + letters;column /= 26; }
            return letters + row;
        }
        internal static XlsxSourceRange Copy(XlsxSourceRange r) => new XlsxSourceRange { Address = Ref(r.FirstRow, r.FirstColumn) + ":" + Ref(r.LastRow, r.LastColumn), FirstRow = r.FirstRow, LastRow = r.LastRow, FirstColumn = r.FirstColumn, LastColumn = r.LastColumn };
        internal static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
    }
}
