using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Xml.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportElementsXlsxHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<long>? elementIds { get; set; }
            public List<string>? parameterNames { get; set; }
            public string? outputFolder { get; set; }
            public string? fileName { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var ids = (p.elementIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
            if (ids.Count == 0) throw new InvalidOperationException("export-elements-xlsx.elementIds is required and must be a non-empty array.");
            if (ids.Count > 2000) throw new InvalidOperationException("export-elements-xlsx.elementIds too large (max 2000).");

            var paramNames = (p.parameterNames ?? new List<string>()).Select(x => (x ?? "").Trim()).Where(x => x.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (paramNames.Count == 0) throw new InvalidOperationException("export-elements-xlsx.parameterNames is required and must be a non-empty array.");
            if (paramNames.Count > 100) throw new InvalidOperationException("export-elements-xlsx.parameterNames too large (max 100).");

            var dryRun = p.dryRun ?? false;
            var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "xlsx");

            var fileName = (p.fileName ?? $"elements_{DateTime.Now:yyyyMMddHHmmss}.xlsx").Trim();
            if (string.IsNullOrWhiteSpace(fileName)) fileName = $"elements_{DateTime.Now:yyyyMMddHHmmss}.xlsx";
            if (!fileName.EndsWith(".xlsx", StringComparison.OrdinalIgnoreCase)) fileName += ".xlsx";
            fileName = Path.GetFileName(fileName);

            var full = Path.Combine(folder, fileName);

            var elements = new List<Element>(capacity: ids.Count);
            foreach (var id in ids)
            {
                var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (el != null) elements.Add(el);
            }

            var header = new List<string> { "UniqueId", "ElementId", "Category", "Name" };
            header.AddRange(paramNames);

            var rows = new List<List<string>>(capacity: elements.Count + 1);
            rows.Add(header);

            foreach (var el in elements)
            {
                var r = new List<string>(capacity: header.Count);
                r.Add(el.UniqueId ?? "");
                r.Add(RevitBridge.Common.ElementIdCompat.GetValue(el.Id).ToString());
                r.Add(el.Category?.Name ?? "");
                r.Add(el.Name ?? "");

                foreach (var pn in paramNames)
                {
                    var param = el.LookupParameter(pn);
                    if (param == null)
                    {
                        r.Add("");
                        continue;
                    }

                    var snap = ParameterValueUtil.SnapshotForWire(param);
                    // snap is anonymous; use JSON to extract valueString without depending on its shape.
                    string val = "";
                    try
                    {
                        var json = JsonSerializer.Serialize(snap);
                        using var docSnap = JsonDocument.Parse(json);
                        val = docSnap.RootElement.TryGetProperty("valueString", out var vs) && vs.ValueKind == JsonValueKind.String ? (vs.GetString() ?? "") : "";
                    }
                    catch { val = ""; }
                    r.Add(val ?? "");
                }
                rows.Add(r);
            }

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    outputFolder = folder,
                    fileName,
                    path = full,
                    selectedCount = elements.Count,
                    columns = header,
                    preview = rows.Take(Math.Min(rows.Count, 5)).ToList()
                });
            }

            XlsxInlineWriter.Write(full, "Elements", rows);

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                outputFolder = folder,
                fileName,
                path = full,
                selectedCount = elements.Count,
                columns = header
            });
        }

        internal static class XlsxInlineWriter
        {
            public static void Write(string fullPath, string sheetName, List<List<string>> rows)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? ".");
                if (File.Exists(fullPath)) File.Delete(fullPath);

                using (var zip = ZipFile.Open(fullPath, ZipArchiveMode.Create))
                {
                    AddEntry(zip, "[Content_Types].xml", ContentTypesXml());
                    AddEntry(zip, "_rels/.rels", RootRelsXml());
                    AddEntry(zip, "xl/workbook.xml", WorkbookXml(sheetName));
                    AddEntry(zip, "xl/_rels/workbook.xml.rels", WorkbookRelsXml());
                    AddEntry(zip, "xl/worksheets/sheet1.xml", WorksheetXml(rows));
                }
            }

            private static void AddEntry(ZipArchive zip, string path, string xml)
            {
                var e = zip.CreateEntry(path, CompressionLevel.Optimal);
                using (var s = e.Open())
                using (var w = new StreamWriter(s, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false)))
                {
                    w.Write(xml);
                }
            }

            private static string ContentTypesXml()
            {
                var ns = XNamespace.Get("http://schemas.openxmlformats.org/package/2006/content-types");
                var doc = new XDocument(
                    new XElement(ns + "Types",
                        new XElement(ns + "Default", new XAttribute("Extension", "rels"), new XAttribute("ContentType", "application/vnd.openxmlformats-package.relationships+xml")),
                        new XElement(ns + "Default", new XAttribute("Extension", "xml"), new XAttribute("ContentType", "application/xml")),
                        new XElement(ns + "Override", new XAttribute("PartName", "/xl/workbook.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml")),
                        new XElement(ns + "Override", new XAttribute("PartName", "/xl/worksheets/sheet1.xml"), new XAttribute("ContentType", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"))
                    )
                );
                return doc.Declaration + doc.ToString(System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            private static string RootRelsXml()
            {
                var ns = XNamespace.Get("http://schemas.openxmlformats.org/package/2006/relationships");
                var doc = new XDocument(
                    new XElement(ns + "Relationships",
                        new XElement(ns + "Relationship",
                            new XAttribute("Id", "rId1"),
                            new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"),
                            new XAttribute("Target", "xl/workbook.xml"))
                    )
                );
                return doc.Declaration + doc.ToString(System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            private static string WorkbookXml(string sheetName)
            {
                var ns = XNamespace.Get("http://schemas.openxmlformats.org/spreadsheetml/2006/main");
                var r = XNamespace.Get("http://schemas.openxmlformats.org/officeDocument/2006/relationships");
                var safeName = (sheetName ?? "Sheet1").Trim();
                if (safeName.Length == 0) safeName = "Sheet1";
                if (safeName.Length > 31) safeName = safeName.Substring(0, 31);

                var doc = new XDocument(
                    new XElement(ns + "workbook",
                        new XAttribute(XNamespace.Xmlns + "r", r),
                        new XElement(ns + "sheets",
                            new XElement(ns + "sheet",
                                new XAttribute("name", safeName),
                                new XAttribute("sheetId", "1"),
                                new XAttribute(r + "id", "rId1"))))
                );
                return doc.Declaration + doc.ToString(System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            private static string WorkbookRelsXml()
            {
                var ns = XNamespace.Get("http://schemas.openxmlformats.org/package/2006/relationships");
                var doc = new XDocument(
                    new XElement(ns + "Relationships",
                        new XElement(ns + "Relationship",
                            new XAttribute("Id", "rId1"),
                            new XAttribute("Type", "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"),
                            new XAttribute("Target", "worksheets/sheet1.xml"))
                    )
                );
                return doc.Declaration + doc.ToString(System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            private static string WorksheetXml(List<List<string>> rows)
            {
                var ns = XNamespace.Get("http://schemas.openxmlformats.org/spreadsheetml/2006/main");
                var doc = new XDocument(
                    new XElement(ns + "worksheet",
                        new XElement(ns + "sheetData",
                            rows.Select((row, i) =>
                                new XElement(ns + "row",
                                    new XAttribute("r", (i + 1).ToString()),
                                    row.Select((cell, j) => InlineStrCell(ns, i + 1, j + 1, cell ?? ""))))))
                );
                return doc.Declaration + doc.ToString(System.Xml.Linq.SaveOptions.DisableFormatting);
            }

            private static XElement InlineStrCell(XNamespace ns, int row, int col, string value)
            {
                var addr = ToCellRef(col, row);
                // Excel disallows certain control chars in inline strings.
                var clean = SanitizeCell(value);
                return new XElement(ns + "c",
                    new XAttribute("r", addr),
                    new XAttribute("t", "inlineStr"),
                    new XElement(ns + "is",
                        new XElement(ns + "t", clean)));
            }

            private static string SanitizeCell(string s)
            {
                if (string.IsNullOrEmpty(s)) return "";
                var sb = new StringBuilder(s.Length);
                foreach (var ch in s)
                {
                    if (ch == '\t' || ch == '\n' || ch == '\r' || ch >= ' ')
                        sb.Append(ch);
                }
                return sb.ToString();
            }

            private static string ToCellRef(int col, int row)
            {
                var c = col;
                var sb = new StringBuilder();
                while (c > 0)
                {
                    c--;
                    sb.Insert(0, (char)('A' + (c % 26)));
                    c /= 26;
                }
                return sb.ToString() + row.ToString();
            }
        }
    }
}
