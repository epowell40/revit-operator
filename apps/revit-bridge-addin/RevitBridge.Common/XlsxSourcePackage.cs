using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Xml;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    public static class XlsxSourcePackage
    {
        internal static readonly XNamespace S = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
        private static readonly XNamespace R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
        private static readonly XNamespace P = "http://schemas.openxmlformats.org/package/2006/relationships";
        public const int MaxPackageBytes = 64 * 1024 * 1024;
        private const int MaxPartBytes = 16 * 1024 * 1024;

        internal static void Validate(ZipArchive zip)
        {
            if (zip.Entries.Count > 2048 || zip.Entries.Select(e => e.FullName).Distinct(StringComparer.Ordinal).Count() != zip.Entries.Count)
                throw new InvalidOperationException("XLSX contains excessive or duplicate package parts.");
            long total = 0;
            foreach (var e in zip.Entries)
            {
                total = checked(total + e.Length);
                if (e.Length > MaxPartBytes || total > MaxPackageBytes) throw new InvalidOperationException("XLSX expanded source limit exceeded; no partial source returned.");
            }
        }
        internal static byte[] ReadBytes(ZipArchive zip, string path)
        {
            var entry = zip.GetEntry(path) ?? throw new InvalidOperationException("Missing XLSX part: " + path);
            if (entry.Length > MaxPartBytes) throw new InvalidOperationException("XLSX part exceeds source limit.");
            using (var input = entry.Open())
            using (var output = new MemoryStream())
            {
                var buffer = new byte[8192];int count;
                while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
                { if (output.Length + count > MaxPartBytes) throw new InvalidOperationException("XLSX part exceeded its declared limit.");output.Write(buffer, 0, count); }
                if (output.Length != entry.Length) throw new InvalidOperationException("XLSX part length mismatch.");
                return output.ToArray();
            }
        }
        internal static XDocument Xml(ZipArchive zip, string path)
        {
            using (var input = new MemoryStream(ReadBytes(zip, path), false))
            using (var reader = XmlReader.Create(input, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxPartBytes }))
                return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        }
        private static XElement Relationships(ZipArchive zip)
        {
            var root = Xml(zip, "xl/_rels/workbook.xml.rels").Root;
            if (root?.Name != P + "Relationships") throw new InvalidOperationException("Unsupported XLSX package relationship namespace.");
            var list = root.Elements(P + "Relationship").ToList();
            if (list.Any(e => string.IsNullOrEmpty((string?)e.Attribute("Id"))) || list.Select(e => (string?)e.Attribute("Id")).Distinct(StringComparer.Ordinal).Count() != list.Count)
                throw new InvalidOperationException("XLSX relationship identities are missing or ambiguous.");
            return root;
        }
        private static string Part(XElement relation)
        {
            if (string.Equals((string?)relation.Attribute("TargetMode"), "External", StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("An XLSX worksheet/style cannot resolve to an external resource.");
            var target = Uri.UnescapeDataString((string?)relation.Attribute("Target") ?? "");
            if (target.Length == 0 || target.StartsWith("//", StringComparison.Ordinal) || target.IndexOfAny(new[] { '\\', ':', '?', '#', '\0' }) >= 0)
                throw new InvalidOperationException("Invalid XLSX local part target.");
            var parts = target.StartsWith("/", StringComparison.Ordinal) ? new List<string>() : new List<string> { "xl" };
            foreach (var segment in target.Split('/'))
            {
                if (segment == "" || segment == ".") continue;
                if (segment == "..") { if (parts.Count == 0) throw new InvalidOperationException("XLSX relationship escapes its package.");parts.RemoveAt(parts.Count - 1); }
                else parts.Add(segment);
            }
            return string.Join("/", parts);
        }
        internal static List<XlsxSourceSheetIdentity> Sheets(ZipArchive zip)
        {
            var workbook = Xml(zip, "xl/workbook.xml").Root;
            if (workbook?.Name != S + "workbook") throw new InvalidOperationException("Unsupported SpreadsheetML namespace.");
            var rels = Relationships(zip);var result = new List<XlsxSourceSheetIdentity>();
            foreach (var sheet in workbook.Element(S + "sheets")?.Elements(S + "sheet") ?? Enumerable.Empty<XElement>())
            {
                var name = (string?)sheet.Attribute("name") ?? "";var id = (string?)sheet.Attribute(R + "id");
                var relation = rels.Elements(P + "Relationship").SingleOrDefault(e => (string?)e.Attribute("Id") == id) ?? throw new InvalidOperationException("XLSX sheet relationship is missing.");
                var type = (string?)relation.Attribute("Type") ?? "";var part = Part(relation);
                if (name.Length == 0 || !type.StartsWith(R.NamespaceName + "/", StringComparison.Ordinal) || zip.GetEntry(part) == null)
                    throw new InvalidOperationException("Invalid XLSX sheet identity or part.");
                result.Add(new XlsxSourceSheetIdentity { Index = result.Count, Name = name, Part = part, State = (string?)sheet.Attribute("state") ?? "visible", Kind = type.Substring(type.LastIndexOf('/') + 1) });
            }
            if (result.Count == 0 || result.Select(s => s.Name).Distinct(StringComparer.OrdinalIgnoreCase).Count() != result.Count)
                throw new InvalidOperationException("XLSX sheet names are missing or ambiguous.");
            return result;
        }
        internal static string? RelatedPart(ZipArchive zip, string kind)
        {
            var matches = Relationships(zip).Elements(P + "Relationship").Where(e => (string?)e.Attribute("Type") == R.NamespaceName + "/" + kind).ToList();
            if (matches.Count > 1) throw new InvalidOperationException("Ambiguous XLSX " + kind + " part.");
            return matches.Count == 0 ? null : Part(matches[0]);
        }
        // Compatibility boundary for existing native import/airflow callers:
        // only an unspecified sheet keeps the old first-tab default. A supplied
        // name that does not exist must never silently select calculation data.
        public static string ResolveWorksheetPath(ZipArchive zip, string? requestedSheetName, out string resolvedSheetName)
        {
            Validate(zip);var sheets = Sheets(zip);
            var chosen = string.IsNullOrWhiteSpace(requestedSheetName) ? sheets[0] : sheets.SingleOrDefault(s => string.Equals(s.Name, requestedSheetName.Trim(), StringComparison.OrdinalIgnoreCase));
            if (chosen == null) throw new InvalidOperationException("Requested XLSX worksheet was not found: " + requestedSheetName);
            if (chosen.Kind != "worksheet") throw new InvalidOperationException("The selected XLSX sheet is not a worksheet.");
            resolvedSheetName = chosen.Name;return chosen.Part;
        }
    }
}
