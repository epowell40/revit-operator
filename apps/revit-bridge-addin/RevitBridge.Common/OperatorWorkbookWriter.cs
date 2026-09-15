using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    /// <summary>Bounded, typed OOXML output. Text is never interpreted as a formula; existing files are never replaced.</summary>
    public static class OperatorWorkbookWriter
    {
        public sealed class Sheet
        {
            public string Name { get; }
            public IReadOnlyList<IReadOnlyList<object?>> Rows { get; }
            public Sheet(string name, IReadOnlyList<IReadOnlyList<object?>> rows) { Name = name; Rows = rows; }
        }
        private static readonly XNamespace Main = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private static readonly XNamespace Rel = "http://schemas.openxmlformats.org/package/2006/relationships";
        private static readonly XNamespace DocRel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

        public static void Write(string fullPath, IReadOnlyList<Sheet> sheets)
        {
            if (sheets.Count == 0 || sheets.Count > 8 || sheets.Select(s => s.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != sheets.Count)
                throw new ArgumentException("Provide 1 to 8 uniquely named sheets.");
            foreach (var sheet in sheets)
            {
                if (string.IsNullOrWhiteSpace(sheet.Name) || sheet.Name.Length > 31 || sheet.Name.IndexOfAny("[]:*?/\\".ToCharArray()) >= 0
                    || sheet.Rows.Count == 0 || sheet.Rows.Count > 200001 || sheet.Rows.Any(r => r.Count > 512))
                    throw new ArgumentException("Invalid or unbounded workbook sheet.");
            }
            if (File.Exists(fullPath)) throw new IOException("The workbook already exists. Choose a new file name.");
            var folder = Path.GetDirectoryName(Path.GetFullPath(fullPath))!;
            Directory.CreateDirectory(folder);
            var temporary = Path.Combine(folder, ".operator-workbook-" + Guid.NewGuid().ToString("N") + ".tmp");
            try
            {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var zip = new ZipArchive(stream, ZipArchiveMode.Create))
                {
                    XNamespace ct = "http://schemas.openxmlformats.org/package/2006/content-types";
                    Add(zip, "[Content_Types].xml", new XElement(ct + "Types",
                        new XElement(ct + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
                        new XElement(ct + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
                        new XElement(ct + "Override", new XAttribute("PartName", "/xl/workbook.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")),
                        new XElement(ct + "Override", new XAttribute("PartName", "/xl/styles.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml")),
                        sheets.Select((s, i) => new XElement(ct + "Override", new XAttribute("PartName", $"/xl/worksheets/sheet{i + 1}.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml")))));
                    Add(zip, "_rels/.rels", new XElement(Rel + "Relationships", Relationship("rId1", "officeDocument", "xl/workbook.xml")));
                    Add(zip, "xl/workbook.xml", new XElement(Main + "workbook", new XAttribute(XNamespace.Xmlns + "r", DocRel),
                        new XElement(Main + "sheets", sheets.Select((s, i) => new XElement(Main + "sheet", new XAttribute("name", s.Name), new XAttribute("sheetId", i + 1), new XAttribute(DocRel + "id", "rId" + (i + 1)))))));
                    Add(zip, "xl/_rels/workbook.xml.rels", new XElement(Rel + "Relationships",
                        sheets.Select((s, i) => Relationship("rId" + (i + 1), "worksheet", $"worksheets/sheet{i + 1}.xml")), Relationship("styles", "styles", "styles.xml")));
                    Add(zip, "xl/styles.xml", XElement.Parse("<styleSheet xmlns='http://schemas.openxmlformats.org/spreadsheetml/2006/main'><fonts count='2'><font><sz val='11'/><name val='Calibri'/></font><font><b/><color rgb='FFFFFFFF'/><sz val='11'/><name val='Calibri'/></font></fonts><fills count='3'><fill><patternFill patternType='none'/></fill><fill><patternFill patternType='gray125'/></fill><fill><patternFill patternType='solid'><fgColor rgb='FF234E5A'/><bgColor indexed='64'/></patternFill></fill></fills><borders count='1'><border/></borders><cellStyleXfs count='1'><xf/></cellStyleXfs><cellXfs count='3'><xf fontId='0' fillId='0' borderId='0' xfId='0'/><xf fontId='1' fillId='2' borderId='0' xfId='0' applyAlignment='1'><alignment wrapText='1' vertical='top'/></xf><xf fontId='0' fillId='0' borderId='0' xfId='0' applyAlignment='1'><alignment wrapText='1' vertical='top'/></xf></cellXfs><cellStyles count='1'><cellStyle name='Normal' xfId='0' builtinId='0'/></cellStyles></styleSheet>"));
                    for (var i = 0; i < sheets.Count; i++) Add(zip, $"xl/worksheets/sheet{i + 1}.xml", Worksheet(sheets[i]));
                }
                // Two-argument Move fails atomically if another writer claimed the destination.
                File.Move(temporary, fullPath);
            }
            finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
        private static XElement Relationship(string id, string kind, string target) => new XElement(Rel + "Relationship",
            new XAttribute("Id", id), new XAttribute("Type", DocRel.NamespaceName + "/" + kind), new XAttribute("Target", target));
        private static void Add(ZipArchive zip, string name, XElement xml)
        {
            using var stream = zip.CreateEntry(name, CompressionLevel.Optimal).Open();
            using var writer = XmlWriter.Create(stream, new XmlWriterSettings { Encoding = new UTF8Encoding(false) });
            xml.Save(writer);
        }
        private static XElement Worksheet(Sheet sheet)
        {
            var width = sheet.Rows.Max(r => r.Count);
            return new XElement(Main + "worksheet",
                new XElement(Main + "sheetViews", new XElement(Main + "sheetView", new XAttribute("workbookViewId", 0),
                    new XElement(Main + "pane", new XAttribute("ySplit", 1), new XAttribute("topLeftCell", "A2"), new XAttribute("activePane", "bottomLeft"), new XAttribute("state", "frozen")))),
                new XElement(Main + "cols", Enumerable.Range(1, Math.Max(1, width)).Select(i => new XElement(Main + "col", new XAttribute("min", i), new XAttribute("max", i), new XAttribute("width", sheet.Name == "Readme" ? (i == 1 ? 26 : 105) : (i == 1 ? 40 : 24)), new XAttribute("customWidth", 1)))),
                new XElement(Main + "sheetData", sheet.Rows.Select((row, i) => new XElement(Main + "row", new XAttribute("r", i + 1),
                    i == 0 ? new XAttribute("ht", 32) : null, i == 0 ? new XAttribute("customHeight", 1) : null,
                    row.Select((cell, j) => Cell(cell, i + 1, j + 1))))),
                sheet.Name != "Readme" && width > 0 ? new XElement(Main + "autoFilter", new XAttribute("ref", "A1:" + Address(width, sheet.Rows.Count))) : null);
        }
        private static XElement Cell(object? value, int row, int col)
        {
            var cell = new XElement(Main + "c", new XAttribute("r", Address(col, row)), new XAttribute("s", row == 1 ? 1 : 2));
            if (value == null) return cell;
            if (value is bool boolean) { cell.Add(new XAttribute("t", "b"), new XElement(Main + "v", boolean ? "1" : "0")); return cell; }
            if (value is double || value is float || value is decimal || value is int || value is long)
            {
                var number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (double.IsNaN(number) || double.IsInfinity(number)) throw new ArgumentException("Workbook numbers must be finite.");
                cell.Add(new XElement(Main + "v", Convert.ToString(value, CultureInfo.InvariantCulture))); return cell;
            }
            var text = Convert.ToString(value, CultureInfo.InvariantCulture) ?? "";
            if (text.Length > 32767) throw new ArgumentException("Workbook text exceeds Excel's cell limit.");
            // Fail before publication on invalid XML instead of silently corrupting source data.
            XmlConvert.VerifyXmlChars(text);
            cell.Add(new XAttribute("t", "inlineStr"), new XElement(Main + "is", new XElement(Main + "t", new XAttribute(XNamespace.Xml + "space", "preserve"), text)));
            return cell;
        }
        private static string Address(int col, int row)
        {
            var result = "";
            while (col > 0) { col--; result = (char)('A' + col % 26) + result; col /= 26; }
            return result + row.ToString(CultureInfo.InvariantCulture);
        }
    }
}
