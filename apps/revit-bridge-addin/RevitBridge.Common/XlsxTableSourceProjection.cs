using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public sealed class XlsxTableSourceProjectionResult
    {
        public bool Matches { get; set; } = true;
        public int IssueCount { get; set; }
        public int SourceCellCount { get; set; }
        public List<string> Issues { get; } = new List<string>();
    }
    // Fresh source-to-retained-plan checks, without native probes or writes.
    // Native values are checked by a separate invocation after creation.
    public static class XlsxTableSourceProjection
    {
        public static XlsxTableSourceProjectionResult Check(XlsxOutputSourceManifest source, XlsxTableLayoutPlan plan)
        {
            var result = new XlsxTableSourceProjectionResult();
            void Issue(string detail) { result.Matches = false;result.IssueCount++;if (result.Issues.Count < 200) result.Issues.Add(detail); }
            var sheet = source.SelectedSheet ?? throw new ArgumentException("An exact output worksheet is required.");
            result.SourceCellCount = sheet.Cells.Count;
            if (source.SourceSha256 != plan.SourceSha256 || sheet.Identity.Name != plan.Worksheet) Issue("source_identity_changed");
            XlsxTableAxes.Validate(plan.Range);
            if (!XlsxTableAxes.Contains(sheet.Bounds, plan.Range)) Issue("source_range_changed");
            var rows = sheet.Rows.ToDictionary(r => r.Index);var columns = new Dictionary<int, XlsxSourceColumn>();
            foreach (var col in sheet.Columns) for (int c = Math.Max(col.First, plan.Range.FirstColumn); c <= Math.Min(col.Last, plan.Range.LastColumn); c++) columns.Add(c, col);
            bool HiddenRow(int r) => rows.TryGetValue(r, out var row) ? row.Hidden || (row.HeightPoints ?? sheet.DefaultRowHeightPoints) == 0 : sheet.DefaultRowsHidden || sheet.DefaultRowHeightPoints == 0;
            double ColumnWidth(int c)
            {
                columns.TryGetValue(c, out var col);if (col?.Hidden == true) return 0;
                double digit = plan.Options.MaximumDigitWidthPixels;
                double baseline = sheet.DefaultColumnWidthCharacters ?? Math.Floor((sheet.BaseColumnWidthCharacters * digit + 5) / digit * 256) / 256;
                return XlsxTableAxes.ColumnInches(col?.WidthCharacters ?? baseline, digit);
            }
            var merges = new Dictionary<(int, int), XlsxSourceRange>();
            foreach (var merge in sheet.Merges.Where(m => XlsxTableAxes.Intersects(m, plan.Range)))
                for (int r = merge.FirstRow; r <= merge.LastRow; r++) for (int c = merge.FirstColumn; c <= merge.LastColumn; c++) merges.Add((r, c), merge);
            var cells = sheet.Cells.ToDictionary(c => c.Address);var catalog = new XlsxTableStyles(source);
            if (plan.Coverage.Count != cells.Count || plan.Coverage.Select(c => c.Address).Distinct().Count() != plan.Coverage.Count) Issue("source_coverage_count_or_duplicate");
            var coverage = plan.Coverage.GroupBy(c => c.Address).ToDictionary(g => g.Key, g => g.First());
            foreach (var cell in sheet.Cells)
            {
                merges.TryGetValue((cell.Row, cell.Column), out var merge);string anchor = XlsxTableAxes.Ref(merge?.FirstRow ?? cell.Row, merge?.FirstColumn ?? cell.Column);
                string state = !XlsxTableAxes.Inside(plan.Range, cell.Row, cell.Column) ? "outside_range" : HiddenRow(cell.Row) ? "hidden_row" : ColumnWidth(cell.Column) == 0 ? "hidden_column" : anchor != cell.Address ? "merged_covered" : "selected_visible";
                if (!coverage.TryGetValue(cell.Address, out var retained) || retained.State != state || retained.AnchorAddress != anchor) Issue("source_coverage_changed:" + cell.Address);
            }
            var primary = new HashSet<string>();var observedPages = new Dictionary<string, int>();
            foreach (var page in plan.Pages)
            {
                var visibleColumns = page.Columns.ToArray();double x = 0;var offsets = new Dictionary<int, double>();
                foreach (int c in visibleColumns) { offsets.Add(c, x);x += ColumnWidth(c); }
                if (Math.Abs(x - page.WidthInches) > 1e-8 || x > plan.Options.PageWidthInches + 1e-8 || page.HeightInches > plan.Options.PageHeightInches + 1e-8) Issue("source_page_width_or_bounds_changed:" + page.Index);
                foreach (var frame in page.Cells)
                {
                    int row = frame.Range.FirstRow, column = frame.Range.FirstColumn;
                    string address = XlsxTableAxes.Ref(row, column);
                    cells.TryGetValue(address, out var cell);rows.TryGetValue(row, out var rowData);columns.TryGetValue(column, out var columnData);
                    var style = catalog.Read(catalog.StyleIndex(cell, rowData, columnData));
                    var display = cell == null ? new XlsxCellDisplayValue() : XlsxCellDisplay.Format(cell, style.NumberFormat);
                    bool expectedWrap = style.Wrap || plan.Issues.Any(i => i.Code == "overflow_wrapped_for_readability" && i.Address == address);
                    merges.TryGetValue((row, column), out var merge);
                    bool sameRange = merge == null ? frame.Range.LastRow == row && frame.Range.LastColumn == column
                        : frame.Range.LastRow == merge.LastRow && frame.Range.LastColumn == merge.LastColumn;
                    double width = Enumerable.Range(column, frame.Range.LastColumn - column + 1).Sum(ColumnWidth);
                    if (frame.Address != address || !sameRange || frame.WrapText != expectedWrap || frame.Text != display.Text || frame.SourceRichTextXml != cell?.RichTextXml || frame.ValueState != (cell?.ValueState ?? "blank") || frame.SourceDataType != (cell?.DataType ?? "n")
                        || JsonSerializer.Serialize(frame.Style) != JsonSerializer.Serialize(style) || frame.RenderFontPoints != Math.Max(style.FontPoints, plan.Options.MinimumTextPoints) || frame.MinimumTextPoints != plan.Options.MinimumTextPoints)
                        Issue("source_cell_projection_changed:" + address);
                    if (!offsets.TryGetValue(frame.Column, out var expectedX) || Math.Abs(frame.XInches - expectedX) > 1e-8 || Math.Abs(frame.WidthInches - width) > 1e-8
                        || HiddenRow(frame.Row) || ColumnWidth(frame.Column) == 0 || frame.YInches < 0 || frame.HeightInches <= 0 || frame.YInches + frame.HeightInches > page.HeightInches + 1e-8)
                        Issue("source_cell_geometry_changed:" + address);
                    if (frame.RepeatedHeader)
                    { if (!page.RepeatedRows.Contains(frame.Row)) Issue("invalid_repeated_header:" + address); }
                    else if (!primary.Add(address)) Issue("duplicated_primary_cell:" + address);
                    else observedPages.Add(address, page.Index);
                }
            }
            for (int r = plan.Range.FirstRow; r <= plan.Range.LastRow; r++) for (int c = plan.Range.FirstColumn; c <= plan.Range.LastColumn; c++)
            {
                if (HiddenRow(r) || ColumnWidth(c) == 0) continue;
                if (merges.TryGetValue((r, c), out var merge) && (merge.FirstRow != r || merge.FirstColumn != c)) continue;
                if (!primary.Contains(XlsxTableAxes.Ref(r, c))) Issue("missing_primary_cell:" + XlsxTableAxes.Ref(r, c));
            }
            foreach (var retained in plan.Coverage.Where(c => c.State == "selected_visible"))
                if (!observedPages.TryGetValue(retained.Address, out var page) || retained.PrimaryPage != page) Issue("source_page_ownership_changed:" + retained.Address);
            return result;
        }
    }
}
