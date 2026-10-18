using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class XlsxTableLayout
    {
        public static XlsxTableLayoutPlan Plan(XlsxOutputSourceManifest source, XlsxTableLayoutOptions options,
            Func<XlsxTableCellFrame, double, XlsxTableTextMeasurement> measure)
        {
            if (source == null || options == null || measure == null) throw new ArgumentNullException();
            var sheet = source.SelectedSheet ?? throw new ArgumentException("Select an exact worksheet before table layout.");
            var range = XlsxTableAxes.Copy(options.Range ?? sheet.Bounds);XlsxTableAxes.Validate(range);
            if (!XlsxTableAxes.Contains(sheet.Bounds, range)) throw new ArgumentException("Requested layout range exceeds the inspected worksheet bounds.");
            if (!XlsxTableAxes.Finite(options.PageWidthInches) || !XlsxTableAxes.Finite(options.PageHeightInches) || options.PageWidthInches <= 0 || options.PageWidthInches > 100 || options.PageHeightInches <= 0 || options.PageHeightInches > 100
                || !XlsxTableAxes.Finite(options.PaddingPoints) || options.PaddingPoints < 0 || options.PaddingPoints > 36
                || !XlsxTableAxes.Finite(options.MinimumTextPoints) || options.MinimumTextPoints < 1 || options.MinimumTextPoints > 72
                || options.RepeatHeaderRows < 0 || options.RepeatHeaderRows > 20 || options.RepeatHeaderRows > range.LastRow - range.FirstRow + 1)
                throw new ArgumentException("Invalid readable paper geometry, padding, font minimum or repeated header scope.");
            var catalog = new XlsxTableStyles(source);var rowRecords = sheet.Rows.ToDictionary(r => r.Index);
            var columnRecords = new Dictionary<int, XlsxSourceColumn>();
            foreach (var column in sheet.Columns) for (int c = Math.Max(range.FirstColumn, column.First); c <= Math.Min(range.LastColumn, column.Last); c++)
                if (columnRecords.ContainsKey(c)) throw new InvalidOperationException("Overlapping source column definitions.");else columnRecords.Add(c, column);
            double digit = options.MaximumDigitWidthPixels;
            XlsxTableAxes.ColumnInches(1, digit); // Validate even when every source column is hidden.
            double defaultWidth = sheet.DefaultColumnWidthCharacters ?? Math.Floor((sheet.BaseColumnWidthCharacters * digit + 5) / digit * 256) / 256;
            var widths = Enumerable.Range(range.FirstColumn, range.LastColumn - range.FirstColumn + 1).ToDictionary(c => c, c =>
                columnRecords.TryGetValue(c, out var column) && column.Hidden ? 0 : XlsxTableAxes.ColumnInches(column?.WidthCharacters ?? defaultWidth, digit));
            var heights = Enumerable.Range(range.FirstRow, range.LastRow - range.FirstRow + 1).ToDictionary(r => r, r =>
            {
                rowRecords.TryGetValue(r, out var row);double height = row?.HeightPoints ?? sheet.DefaultRowHeightPoints ?? throw new InvalidOperationException("Source default row height is missing.");
                if (!XlsxTableAxes.Finite(height) || height < 0 || height > 409) throw new InvalidOperationException("Invalid source row height.");
                return (row?.Hidden ?? sheet.DefaultRowsHidden) ? 0 : height / 72;
            });
            var rows = heights.Where(p => p.Value > 0).Select(p => p.Key).OrderBy(i => i).ToArray();
            var columns = widths.Where(p => p.Value > 0).Select(p => p.Key).OrderBy(i => i).ToArray();
            if (rows.Length == 0 || columns.Length == 0) throw new InvalidOperationException("Selected worksheet range has no visible area.");
            var merges = sheet.Merges.Where(m => XlsxTableAxes.Intersects(m, range)).ToArray();var mergeAt = new Dictionary<(int, int), XlsxSourceRange>();
            foreach (var merge in merges)
            {
                if (!XlsxTableAxes.Contains(range, merge)) throw new ArgumentException("Selected range cuts a source merge; select the complete merge.");
                for (int r = merge.FirstRow; r <= merge.LastRow; r++) for (int c = merge.FirstColumn; c <= merge.LastColumn; c++)
                    if (mergeAt.ContainsKey((r, c))) throw new InvalidOperationException("Overlapping source merges.");else mergeAt.Add((r, c), merge);
            }
            var actual = sheet.Cells.ToDictionary(c => (c.Row, c.Column));
            var plan = new XlsxTableLayoutPlan { SourceSha256 = source.SourceSha256, Worksheet = sheet.Identity.Name, Range = range,
                Options = new XlsxTableLayoutOptions { Range = XlsxTableAxes.Copy(range), PageWidthInches = options.PageWidthInches, PageHeightInches = options.PageHeightInches,
                    PaddingPoints = options.PaddingPoints, MinimumTextPoints = options.MinimumTextPoints, MaximumDigitWidthPixels = options.MaximumDigitWidthPixels, RepeatHeaderRows = options.RepeatHeaderRows, WrapOverflow = options.WrapOverflow } };
            plan.Issues.AddRange(source.Issues.Select(i => new XlsxSourceIssue { Code = i.Code, Address = i.Address }));
            XlsxTableCellStyle StyleAt(int r, int c)
            {
                actual.TryGetValue((r, c), out var cell);rowRecords.TryGetValue(r, out var row);columnRecords.TryGetValue(c, out var column);
                int index = catalog.StyleIndex(cell, row, column);
                if (!plan.Styles.TryGetValue(index, out var style))
                {
                    style = catalog.Read(index);plan.Styles.Add(index, style);
                    foreach (var issue in style.Unsupported) plan.Issues.Add(new XlsxSourceIssue { Code = "unsupported_style:" + issue, Address = "style:" + index });
                }
                return style;
            }
            var frames = new List<XlsxTableCellFrame>();double padding = options.PaddingPoints / 72;
            foreach (int r in rows) foreach (int c in columns)
            {
                mergeAt.TryGetValue((r, c), out var merge);
                var visibleRows = merge == null ? new[] { r } : rows.Where(i => i >= merge.FirstRow && i <= merge.LastRow).ToArray();
                var visibleColumns = merge == null ? new[] { c } : columns.Where(i => i >= merge.FirstColumn && i <= merge.LastColumn).ToArray();
                if (visibleRows[0] != r || visibleColumns[0] != c) continue;
                int anchorRow = merge?.FirstRow ?? r, anchorColumn = merge?.FirstColumn ?? c;
                actual.TryGetValue((anchorRow, anchorColumn), out var cell);var style = StyleAt(anchorRow, anchorColumn);
                var display = cell == null ? new XlsxCellDisplayValue() : XlsxCellDisplay.Format(cell, style.NumberFormat);
                string address = XlsxTableAxes.Ref(anchorRow, anchorColumn);
                if (!display.Supported) plan.Issues.Add(new XlsxSourceIssue { Code = display.Issue ?? "unsupported_display", Address = address });
                if ((r != anchorRow || c != anchorColumn) && display.Text.Length > 0) throw new InvalidOperationException("A hidden merged anchor contains text; resolve its intended visibility explicitly.");
                if (style.FontPoints < options.MinimumTextPoints && display.Text.Length > 0) plan.EnlargedTextCells.Add(address);
                var frame = new XlsxTableCellFrame { Address = address, Row = r, Column = c, Range = XlsxTableAxes.Copy(merge ?? new XlsxSourceRange { FirstRow = r, LastRow = r, FirstColumn = c, LastColumn = c }),
                    WidthInches = visibleColumns.Sum(i => widths[i]), Text = display.Text, ValueState = cell?.ValueState ?? "blank", SourceDataType = cell?.DataType ?? "n", SourceRichTextXml = cell?.RichTextXml, Style = style, WrapText = style.Wrap, RenderFontPoints = Math.Max(style.FontPoints, options.MinimumTextPoints), MinimumTextPoints = options.MinimumTextPoints };
                frames.Add(frame);
            }
            var metricCache = new Dictionary<string, XlsxTableTextMeasurement>();var expanded = new HashSet<int>();
            foreach (var frame in frames.Where(f => f.Text.Length > 0))
            {
                double available = frame.WidthInches - 2 * padding;if (available <= 0) throw new InvalidOperationException("Cell padding leaves no readable text width: " + frame.Address);
                XlsxTableTextMeasurement Measure()
                {
                    var style = frame.Style;var key = JsonSerializer.Serialize(new { frame.Text, frame.SourceRichTextXml, frame.WrapText, available,
                        style.FontFamily, frame.RenderFontPoints, style.Bold, style.Italic, style.Underline, style.Strike, style.VerticalScript });
                    if (!metricCache.TryGetValue(key, out var size))
                    { size = measure(frame, available);if (size == null || !XlsxTableAxes.Finite(size.WidthInches) || !XlsxTableAxes.Finite(size.HeightInches) || size.WidthInches < 0 || size.HeightInches <= 0) throw new InvalidOperationException("Missing/invalid text measurement; no estimated fit was substituted.");metricCache.Add(key, size); }
                    return size;
                }
                var measured = Measure();
                if (measured.WidthInches > available + 1e-6 && !frame.WrapText && options.WrapOverflow)
                { frame.WrapText = true;plan.Issues.Add(new XlsxSourceIssue { Code = "overflow_wrapped_for_readability", Address = frame.Address });measured = Measure(); }
                if (measured.WidthInches > available + 1e-6) throw new InvalidOperationException("Measured text cannot fit cell width: " + frame.Address + "; widen the column or revise the explicit layout.");
                var spanRows = frame.Range.FirstRow == frame.Range.LastRow ? new[] { frame.Row } : rows.Where(r => r >= frame.Range.FirstRow && r <= frame.Range.LastRow).ToArray();
                double current = spanRows.Sum(r => heights[r]), needed = measured.HeightInches + padding * 2;
                if (needed > current + 1e-9) { int last = spanRows.Last();heights[last] += needed - current;expanded.Add(last); }
            }
            plan.MeasurementRequests = metricCache.Count;plan.ExpandedRows.AddRange(expanded.OrderBy(i => i));
            int headerEnd = range.FirstRow + options.RepeatHeaderRows - 1;
            if (options.RepeatHeaderRows > 0 && merges.Any(m => m.FirstRow <= headerEnd && m.LastRow > headerEnd)) throw new ArgumentException("Repeated header selection cuts a merged cell.");
            var headers = rows.Where(r => r <= headerEnd).ToArray();double headerHeight = headers.Sum(r => heights[r]);
            if (headerHeight >= options.PageHeightInches && rows.Any(r => r > headerEnd)) throw new InvalidOperationException("Repeated headers leave no usable continuation height.");
            var rowBands = XlsxTableAxes.Bands(rows, heights, options.PageHeightInches, options.PageHeightInches - headerHeight, merges, true);
            var columnBands = XlsxTableAxes.Bands(columns, widths, options.PageWidthInches, options.PageWidthInches, merges, false);
            if ((long)rowBands.Count * columnBands.Count > 500) throw new InvalidOperationException("More than500readable table parts are required; no pages were silently dropped.");
            foreach (var rowBand in rowBands) foreach (var columnBand in columnBands)
            {
                int ri = rowBands.IndexOf(rowBand);var pageRows = (ri == 0 ? rowBand : headers.Concat(rowBand)).ToArray();
                var page = new XlsxTablePage { Index = plan.Pages.Count, RowBand = ri, ColumnBand = columnBands.IndexOf(columnBand), WidthInches = columnBand.Sum(c => widths[c]), HeightInches = pageRows.Sum(r => heights[r]) };
                page.PrimaryRows.AddRange(rowBand);if (ri > 0) page.RepeatedRows.AddRange(headers);page.Columns.AddRange(columnBand);
                var x = XlsxTableAxes.Offsets(columnBand, widths);var y = XlsxTableAxes.Offsets(pageRows, heights);
                foreach (var frame in frames.Where(f => y.ContainsKey(f.Row) && x.ContainsKey(f.Column)))
                    page.Cells.Add(new XlsxTableCellFrame { Address = frame.Address, Row = frame.Row, Column = frame.Column, Range = frame.Range,
                        XInches = x[frame.Column], YInches = y[frame.Row], WidthInches = frame.WidthInches,
                        HeightInches = frame.Range.FirstRow == frame.Range.LastRow ? heights[frame.Row] : rows.Where(r => r >= frame.Range.FirstRow && r <= frame.Range.LastRow).Sum(r => heights[r]),
                        Text = frame.Text, Style = frame.Style, ValueState = frame.ValueState, SourceDataType = frame.SourceDataType, SourceRichTextXml = frame.SourceRichTextXml, WrapText = frame.WrapText, RenderFontPoints = frame.RenderFontPoints, MinimumTextPoints = frame.MinimumTextPoints, RepeatedHeader = ri > 0 && frame.Row <= headerEnd });
                page.Borders.AddRange(XlsxTableBorders.Build(page.Cells, widths, heights, StyleAt, plan.Issues));
                plan.Pages.Add(page);
            }
            var primary = plan.Pages.SelectMany(p => p.Cells.Where(c => !c.RepeatedHeader).Select(c => (c.Address, p.Index))).ToDictionary(c => c.Address, c => c.Index);
            foreach (var cell in sheet.Cells)
            {
                bool inside = XlsxTableAxes.Inside(range, cell.Row, cell.Column);mergeAt.TryGetValue((cell.Row, cell.Column), out var merge);
                string anchor = XlsxTableAxes.Ref(merge?.FirstRow ?? cell.Row, merge?.FirstColumn ?? cell.Column);
                string state = !inside ? "outside_range" : heights[cell.Row] == 0 ? "hidden_row" : widths[cell.Column] == 0 ? "hidden_column"
                    : anchor != cell.Address ? "merged_covered" : "selected_visible";
                plan.Coverage.Add(new XlsxTableCellCoverage { Address = cell.Address, AnchorAddress = anchor, State = state, PrimaryPage = primary.TryGetValue(anchor, out var page) ? page : (int?)null });
            }
            return plan;
        }
    }
}
