using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

namespace RevitBridge.Common
{
    internal static class XlsxTableBorders
    {
        internal static IEnumerable<XlsxTableBorderSegment> Build(IEnumerable<XlsxTableCellFrame> frames,
            Dictionary<int, double> widths, Dictionary<int, double> heights, Func<int, int, XlsxTableCellStyle> styleAt, List<XlsxSourceIssue> issues)
        {
            var unique = new Dictionary<string, XlsxTableBorderSegment>();var conflicts = new HashSet<string>();
            void Edge(string side, int row, int column, double x1, double y1, double x2, double y2)
            {
                if (!styleAt(row, column).Borders.TryGetValue(side, out var border) || Math.Abs(x1 - x2) + Math.Abs(y1 - y2) < 1e-9) return;
                var line = new XlsxTableBorderSegment { X1 = x1, Y1 = y1, X2 = x2, Y2 = y2, Style = border.Style, Color = border.Color };
                string key = string.Join(":", new[] { x1, y1, x2, y2 }.Select(Number));
                if (unique.TryGetValue(key, out var prior) && (prior.Style != line.Style || prior.Color != line.Color))
                {
                    // Retain the conflict; no unqualified visual-fidelity claim.
                    if (conflicts.Add(key)) issues.Add(new XlsxSourceIssue { Code = "adjacent_border_precedence_requires_review", Address = XlsxTableAxes.Ref(row, column) });
                    if (Rank(prior.Style) >= Rank(line.Style)) return;
                }
                unique[key] = line;
            }
            foreach (var frame in frames)
            {
                var r = frame.Range;double x = frame.XInches, y = frame.YInches;
                // Only the outer perimeter of a merged cell is visible. Read
                // every source edge, including formatted non-anchor blanks.
                for (int c = r.FirstColumn; c <= r.LastColumn; c++)
                {
                    Edge("top", r.FirstRow, c, x, y, x + widths[c], y);
                    Edge("bottom", r.LastRow, c, x, y + frame.HeightInches, x + widths[c], y + frame.HeightInches);x += widths[c];
                }
                for (int row = r.FirstRow; row <= r.LastRow; row++)
                {
                    Edge("left", row, r.FirstColumn, frame.XInches, y, frame.XInches, y + heights[row]);
                    Edge("right", row, r.LastColumn, frame.XInches + frame.WidthInches, y, frame.XInches + frame.WidthInches, y + heights[row]);y += heights[row];
                }
            }
            // Fewer native detail lines, with exactly the same visible edges:
            // join only coincident, contiguous segments of the same style/color.
            foreach (var group in unique.Values.GroupBy(l => (horizontal: Math.Abs(l.Y1 - l.Y2) < 1e-9,
                fixedAxis: Number(Math.Abs(l.Y1 - l.Y2) < 1e-9 ? l.Y1 : l.X1), l.Style, l.Color)))
            {
                XlsxTableBorderSegment? current = null;bool horizontal = group.Key.horizontal;
                foreach (var next in group.OrderBy(l => horizontal ? l.X1 : l.Y1))
                {
                    if (current != null && Math.Abs((horizontal ? current.X2 : current.Y2) - (horizontal ? next.X1 : next.Y1)) < 1e-8)
                    { current.X2 = next.X2;current.Y2 = next.Y2; }
                    else { if (current != null) yield return current;current = next; }
                }
                if (current != null) yield return current;
            }
        }
        private static string Number(double n) => n.ToString("F8", CultureInfo.InvariantCulture);
        private static int Rank(string style) => style == "double" ? 5 : style == "thick" ? 4 : style.StartsWith("medium", StringComparison.Ordinal) ? 3 : style == "hair" ? 1 : 2;
    }
}
