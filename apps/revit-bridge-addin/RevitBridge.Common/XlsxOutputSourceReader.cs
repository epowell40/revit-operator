using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    public static class XlsxOutputSourceReader
    {
        private static readonly XNamespace S = XlsxSourcePackage.S;
        public static XlsxOutputSourceManifest Read(byte[] package, string? sheetName = null)
        {
            if (package == null || package.Length == 0 || package.Length > XlsxSourcePackage.MaxPackageBytes)
                throw new InvalidOperationException("XLSX source is empty or exceeds the package limit.");
            var manifest = new XlsxOutputSourceManifest { SourceSha256 = Hash(package) };
            using (var memory = new MemoryStream(package, false))
            using (var zip = new ZipArchive(memory, ZipArchiveMode.Read))
            {
                XlsxSourcePackage.Validate(zip);manifest.Worksheets.AddRange(XlsxSourcePackage.Sheets(zip));
                foreach (var entry in zip.Entries)
                {
                    if (entry.FullName.StartsWith("xl/externalLinks/", StringComparison.Ordinal)) manifest.ExternalLinkParts.Add(entry.FullName);
                    if (entry.FullName.EndsWith("vbaProject.bin", StringComparison.OrdinalIgnoreCase) || entry.FullName.StartsWith("xl/embeddings/", StringComparison.Ordinal)) manifest.ActiveContentParts.Add(entry.FullName);
                }
                foreach (var kind in new[] { "styles", "theme" })
                {
                    var part = XlsxSourcePackage.RelatedPart(zip, kind);
                    if (part != null) manifest.FormattingParts.Add(part, XlsxSourcePackage.Xml(zip, part).ToString(SaveOptions.DisableFormatting));
                }
                if (manifest.ExternalLinkParts.Count > 0) Issue(manifest, "external_links_not_resolved", "workbook");
                if (manifest.ActiveContentParts.Count > 0) Issue(manifest, "embedded_content_not_executed", "workbook");
                // Discovery is deliberately distinct from selecting a calculation tab.
                if (string.IsNullOrWhiteSpace(sheetName)) return manifest;
                var identity = manifest.Worksheets.SingleOrDefault(s => string.Equals(s.Name, sheetName.Trim(), StringComparison.OrdinalIgnoreCase));
                if (identity == null) throw new InvalidOperationException("Requested XLSX worksheet was not found: " + sheetName);
                if (identity.Kind != "worksheet") throw new InvalidOperationException("The selected XLSX sheet is not a worksheet.");
                var sheetBytes = XlsxSourcePackage.ReadBytes(zip, identity.Part);
                var xml = XlsxSourcePackage.Xml(zip, identity.Part).Root;
                if (xml?.Name != S + "worksheet") throw new InvalidOperationException("Unsupported XLSX worksheet namespace.");
                var stringsPart = XlsxSourcePackage.RelatedPart(zip, "sharedStrings");
                var stringsRoot = stringsPart == null ? null : XlsxSourcePackage.Xml(zip, stringsPart).Root;
                if (stringsRoot != null && stringsRoot.Name != S + "sst") throw new InvalidOperationException("Unsupported XLSX shared-string namespace.");
                var strings = stringsRoot?.Elements(S + "si").ToList() ?? new List<XElement>();
                var stylesPart = XlsxSourcePackage.RelatedPart(zip, "styles");
                var stylesRoot = stylesPart == null ? null : XlsxSourcePackage.Xml(zip, stylesPart).Root;
                if (stylesRoot != null && stylesRoot.Name != S + "styleSheet") throw new InvalidOperationException("Unsupported XLSX style namespace.");
                var styleCount = stylesPart == null ? 1 : stylesRoot?.Element(S + "cellXfs")?.Elements(S + "xf").Count() ?? 0;
                if (styleCount == 0) throw new InvalidOperationException("XLSX has no readable cell styles.");
                var result = new XlsxSourceSheet { Identity = identity, SourcePartSha256 = Hash(sheetBytes),
                    ReportedDimension = (string?)xml.Element(S + "dimension")?.Attribute("ref") ?? "",
                    DefaultRowHeightPoints = Number(xml.Element(S + "sheetFormatPr")?.Attribute("defaultRowHeight")),
                    BaseColumnWidthCharacters = Number(xml.Element(S + "sheetFormatPr")?.Attribute("baseColWidth")) ?? 8,
                    DefaultRowsHidden = Flag(xml.Element(S + "sheetFormatPr")?.Attribute("zeroHeight")),
                    DefaultColumnWidthCharacters = Number(xml.Element(S + "sheetFormatPr")?.Attribute("defaultColWidth")) };
                ReadColumns(xml, result, styleCount);ReadRows(xml, result, strings, styleCount, manifest);ReadMerges(xml, result);
                var print = new XElement("printContext", xml.Elements().Where(e => new[] { "sheetPr", "sheetFormatPr", "pageMargins", "pageSetup", "printOptions", "headerFooter", "rowBreaks", "colBreaks" }.Contains(e.Name.LocalName)).Select(e => new XElement(e)));
                print.Add(XlsxSourcePackage.Xml(zip, "xl/workbook.xml").Root!.Element(S + "definedNames")?.Elements(S + "definedName")
                    .Where(e => ((string?)e.Attribute("name") ?? "").StartsWith("_xlnm.Print_", StringComparison.Ordinal)
                        && ((string?)e.Attribute("localSheetId") == null || (string?)e.Attribute("localSheetId") == identity.Index.ToString(CultureInfo.InvariantCulture))).Select(e => new XElement(e)));
                result.PrintContextXml = print.ToString(SaveOptions.DisableFormatting);
                foreach (var feature in new[] { "drawing", "legacyDrawing", "tableParts", "conditionalFormatting", "autoFilter", "extLst" })
                    if (xml.Elements(S + feature).Any()) Issue(manifest, "source_feature_requires_render_policy", feature);
                var points = result.Cells.Select(c => new[] { c.Row, c.Column }).Concat(result.Merges.SelectMany(m => new[] { new[] { m.FirstRow, m.FirstColumn }, new[] { m.LastRow, m.LastColumn } })).ToList();
                if (points.Count > 0) result.Bounds = new XlsxSourceRange { FirstRow = points.Min(p => p[0]), LastRow = points.Max(p => p[0]), FirstColumn = points.Min(p => p[1]), LastColumn = points.Max(p => p[1]) };
                if (result.Bounds.FirstRow > 0) result.Bounds.Address = CellRef(result.Bounds.FirstColumn, result.Bounds.FirstRow) + ":" + CellRef(result.Bounds.LastColumn, result.Bounds.LastRow);
                manifest.SelectedSheet = result;
            }
            return manifest;
        }
        private static void ReadColumns(XElement xml, XlsxSourceSheet result, int styleCount)
        {
            foreach (var c in xml.Elements(S + "cols").Elements(S + "col"))
            {
                var first = Integer(c.Attribute("min"), 1, 16384);var last = Integer(c.Attribute("max"), first, 16384);
                if (result.Columns.Any(prior => first <= prior.Last && prior.First <= last)) throw new InvalidOperationException("Overlapping XLSX column definitions.");
                result.Columns.Add(new XlsxSourceColumn { First = first, Last = last, WidthCharacters = Number(c.Attribute("width")), Hidden = Flag(c.Attribute("hidden")), StyleIndex = Style(c.Attribute("style"), styleCount), PropertiesXml = c.ToString(SaveOptions.DisableFormatting) });
                if (result.Columns.Count > 16384) throw new InvalidOperationException("Excessive XLSX column definitions.");
            }
        }
        private static void ReadRows(XElement xml, XlsxSourceSheet result, List<XElement> strings, int styleCount, XlsxOutputSourceManifest manifest)
        {
            var rowIds = new HashSet<int>();var cellIds = new HashSet<string>(StringComparer.Ordinal);int previousRow = 0;
            foreach (var row in xml.Elements(S + "sheetData").Elements(S + "row"))
            {
                var index = row.Attribute("r") == null ? previousRow + 1 : Integer(row.Attribute("r"), 1, 1048576);previousRow = index;
                if (index > 1048576 || !rowIds.Add(index)) throw new InvalidOperationException("Duplicate or invalid XLSX row identity.");
                var rowProperties = new XElement(row.Name, row.Attributes());
                result.Rows.Add(new XlsxSourceRow { Index = index, HeightPoints = Number(row.Attribute("ht")), Hidden = row.Attribute("hidden") == null ? result.DefaultRowsHidden : Flag(row.Attribute("hidden")), StyleIndex = Style(row.Attribute("s"), styleCount), PropertiesXml = rowProperties.ToString(SaveOptions.DisableFormatting) });
                int column = 1;
                foreach (var element in row.Elements(S + "c"))
                {
                    var address = (string?)element.Attribute("r") ?? CellRef(column, index);var position = Position(address);column = position.Item2 + 1;
                    address = CellRef(position.Item2, position.Item1);
                    if (position.Item1 != index || !cellIds.Add(address)) throw new InvalidOperationException("Duplicate XLSX cell or mismatched owning row.");
                    var type = (string?)element.Attribute("t") ?? "n";var value = element.Element(S + "v");var formula = element.Element(S + "f");
                    if (!new[] { "n", "s", "str", "inlineStr", "b", "e", "d" }.Contains(type)) throw new InvalidOperationException("Unsupported XLSX cell type: " + type);
                    var cell = new XlsxSourceCell { Address = address, Row = index, Column = position.Item2, StyleIndex = Style(element.Attribute("s"), styleCount), DataType = type,
                        RawValue = value?.Value, HasFormula = formula != null, HasCachedValue = value != null && (value.Value.Length > 0 || type == "str"), FormulaXml = formula?.ToString(SaveOptions.DisableFormatting), SourceXml = element.ToString(SaveOptions.DisableFormatting) };
                    if (formula != null && !cell.HasCachedValue)
                    { cell.ValueState = "uncached_formula";result.MissingFormulaCacheCount++;Issue(manifest, "formula_cache_missing", address); }
                    else
                    {
                        cell.Text = value?.Value;
                        if (type == "s") { var i = Integer(value, 0, strings.Count - 1);cell.Text = PlainText(strings[i]);cell.RichTextXml = strings[i].ToString(SaveOptions.DisableFormatting); }
                        else if (type == "inlineStr") { var text = element.Element(S + "is") ?? throw new InvalidOperationException("XLSX inline string is missing.");cell.Text = PlainText(text);cell.RichTextXml = text.ToString(SaveOptions.DisableFormatting); }
                        cell.ValueState = formula != null ? type == "e" ? "cached_formula_error" : "cached_formula" : type == "e" ? "literal_error" : cell.Text == null || type == "n" && cell.RawValue == "" ? "blank" : "literal";
                        if (type == "e") { result.ErrorCellCount++;if (formula != null) result.CachedErrorCount++;Issue(manifest, "cell_error", address); }
                        if (type == "n" && cell.RawValue != null && cell.RawValue.Length > 0
                            && (!double.TryParse(cell.RawValue, NumberStyles.Float, CultureInfo.InvariantCulture, out var number) || double.IsNaN(number) || double.IsInfinity(number)))
                        { cell.ValueState = formula != null ? "invalid_numeric_cache" : "invalid_numeric_literal";Issue(manifest, cell.ValueState, address); }
                    }
                    if (formula != null) result.FormulaCount++;
                    result.Cells.Add(cell);
                    if (result.Cells.Count > 100000) throw new InvalidOperationException("XLSX source exceeds the 100000-cell inspection limit; no source truncated.");
                }
                if (result.Rows.Count > 100000) throw new InvalidOperationException("XLSX source row metadata limit exceeded.");
            }
        }
        private static void ReadMerges(XElement xml, XlsxSourceSheet result)
        {
            foreach (var merge in xml.Elements(S + "mergeCells").Elements(S + "mergeCell"))
            {
                var address = (string?)merge.Attribute("ref") ?? "";var parts = address.Split(':');
                if (parts.Length < 1 || parts.Length > 2) throw new InvalidOperationException("Invalid XLSX merge.");
                var first = Position(parts[0]);var last = Position(parts[parts.Length - 1]);
                if (last.Item1 < first.Item1 || last.Item2 < first.Item2) throw new InvalidOperationException("Reversed XLSX merge bounds.");
                var range = new XlsxSourceRange { Address = CellRef(first.Item2, first.Item1) + ":" + CellRef(last.Item2, last.Item1), FirstRow = first.Item1, LastRow = last.Item1, FirstColumn = first.Item2, LastColumn = last.Item2 };
                if (result.Merges.Any(m => range.FirstRow <= m.LastRow && m.FirstRow <= range.LastRow && range.FirstColumn <= m.LastColumn && m.FirstColumn <= range.LastColumn)) throw new InvalidOperationException("Overlapping XLSX merged cells.");
                result.Merges.Add(range);if (result.Merges.Count > 5000) throw new InvalidOperationException("XLSX merge metadata limit exceeded.");
            }
        }
        private static string PlainText(XElement source) => string.Concat(source.Elements().Where(e => e.Name == S + "t" || e.Name == S + "r").Select(e => e.Name == S + "t" ? e.Value : string.Concat(e.Elements(S + "t").Select(t => t.Value))));
        private static int? Style(XAttribute? a, int count) => a == null ? (int?)null : Integer(a, 0, count - 1);
        private static bool Flag(XAttribute? a) => a != null && new[] { "1", "true" }.Contains(a.Value);
        private static double? Number(XAttribute? a)
        {
            if (a == null) return null;
            if (!double.TryParse(a.Value, NumberStyles.Float, CultureInfo.InvariantCulture, out var n) || double.IsNaN(n) || double.IsInfinity(n) || n < 0) throw new InvalidOperationException("Invalid XLSX geometry value.");
            return n;
        }
        private static int Integer(XObject? item, int min, int max)
        {
            var text = item is XAttribute attribute ? attribute.Value : item is XElement element ? element.Value : "";
            if (!int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < min || n > max) throw new InvalidOperationException("Invalid XLSX integer or reference.");
            return n;
        }
        private static Tuple<int, int> Position(string address)
        {
            var match = Regex.Match(address.ToUpperInvariant(), @"^\$?([A-Z]{1,3})\$?([1-9][0-9]*)$");
            if (!match.Success || !int.TryParse(match.Groups[2].Value, out var row) || row > 1048576) throw new InvalidOperationException("Invalid XLSX cell reference: " + address);
            int column = 0;foreach (var c in match.Groups[1].Value) column = column * 26 + c - 'A' + 1;
            if (column > 16384) throw new InvalidOperationException("Invalid XLSX column reference.");
            return Tuple.Create(row, column);
        }
        private static string CellRef(int column, int row)
        {
            if (column < 1 || column > 16384 || row < 1 || row > 1048576) throw new InvalidOperationException("Invalid XLSX cell position.");
            var name = new StringBuilder();while (column > 0) { column--;name.Insert(0, (char)('A' + column % 26));column /= 26; }
            return name.ToString() + row.ToString(CultureInfo.InvariantCulture);
        }
        private static void Issue(XlsxOutputSourceManifest source, string code, string address) => source.Issues.Add(new XlsxSourceIssue { Code = code, Address = address });
        private static string Hash(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    }
}
