using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Xml;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    public static class DocxDrawingSpecSourceReader
    {
        private static readonly XNamespace W = DocxSourceStyles.W;
        private const int MaxPackageBytes = 64 * 1024 * 1024;
        private const int MaxPartBytes = 16 * 1024 * 1024;

        public static DrawingSpecSourceManifest Read(byte[] package)
        {
            if (package == null || package.Length == 0 || package.Length > MaxPackageBytes)
                throw new InvalidOperationException("DOCX source is empty or exceeds the 64 MiB package limit; no content was truncated.");
            var manifest = new DrawingSpecSourceManifest { SourceSha256 = Hash(package) };
            using (var stream = new MemoryStream(package, false))
            using (var zip = new ZipArchive(stream, ZipArchiveMode.Read))
            {
                if (zip.Entries.Count > 2048 || zip.Entries.Select(e => e.FullName).Distinct(StringComparer.Ordinal).Count() != zip.Entries.Count)
                    throw new InvalidOperationException("DOCX has excessive or duplicate package parts.");
                long expanded = 0;
                var parts = new Dictionary<string, byte[]>(StringComparer.Ordinal);
                foreach (var entry in zip.Entries)
                {
                    expanded = checked(expanded + entry.Length);
                    if (entry.Length > MaxPartBytes || expanded > MaxPackageBytes)
                        throw new InvalidOperationException("DOCX expanded content exceeds the supported source limit; no partial manifest was returned.");
                    using (var input = entry.Open())
                    using (var output = new MemoryStream())
                    {
                        var buffer = new byte[8192];
                        int read;
                        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                        {
                            if (output.Length + read > MaxPartBytes) throw new InvalidOperationException("DOCX part exceeded its declared size.");
                            output.Write(buffer, 0, read);
                        }
                        if (output.Length != entry.Length) throw new InvalidOperationException("DOCX part size did not match its package entry.");
                        var bytes = output.ToArray();
                        parts.Add(entry.FullName, bytes);
                        manifest.Parts.Add(new DrawingSpecSourcePart { Path = entry.FullName, Bytes = bytes.Length, Sha256 = Hash(bytes),
                            Xml = entry.FullName.EndsWith(".xml", StringComparison.OrdinalIgnoreCase) || entry.FullName.EndsWith(".rels", StringComparison.OrdinalIgnoreCase)
                                ? ParseXml(bytes).ToString(SaveOptions.DisableFormatting) : null });
                    }
                }
                if (!parts.TryGetValue("word/document.xml", out var main)) throw new InvalidOperationException("DOCX is missing word/document.xml.");
                var document = ParseXml(main);
                if (document.Root?.Name != W + "document") throw new InvalidOperationException("Unsupported WordprocessingML namespace.");
                var body = document.Root.Element(W + "body") ?? throw new InvalidOperationException("DOCX has no document body.");
                var styles = new DocxSourceStyles(parts.TryGetValue("word/styles.xml", out var styleBytes) ? ParseXml(styleBytes) : null);
                var numbering = new DocxSourceNumbering(parts.TryGetValue("word/numbering.xml", out var numberBytes) ? ParseXml(numberBytes) : null);
                int index = 0;
                foreach (var element in body.Elements()) manifest.Blocks.Add(ReadBlock(element, "body/" + index++, manifest, styles, numbering));
                foreach (var part in parts.Keys.Where(p => p.StartsWith("word/", StringComparison.Ordinal)))
                {
                    if (part.StartsWith("word/header", StringComparison.Ordinal) || part.StartsWith("word/footer", StringComparison.Ordinal))
                        Warn(manifest, "running_matter_retained_separately", part, false);
                    if ((part == "word/footnotes.xml" || part == "word/endnotes.xml") &&
                        ParseXml(parts[part]).Root!.Elements().Any(e => e.Attribute(W + "type") == null || (string?)e.Attribute(W + "type") == "normal"))
                        Warn(manifest, "notes_require_placement_policy", part, false);
                    if (part.StartsWith("word/embeddings/", StringComparison.Ordinal) || part.EndsWith("vbaProject.bin", StringComparison.OrdinalIgnoreCase))
                        Warn(manifest, "embedded_or_active_content_not_executed", part, true);
                }
            }
            return manifest;
        }

        private static DrawingSpecBlock ReadBlock(XElement source, string path, DrawingSpecSourceManifest manifest, DocxSourceStyles styles, DocxSourceNumbering numbering)
        {
            var block = new DrawingSpecBlock { SourcePath = path, Kind = source.Name.LocalName,
                ContentSha256 = Hash(Encoding.UTF8.GetBytes(source.ToString(SaveOptions.DisableFormatting))),
                PropertiesXml = source.ToString(SaveOptions.DisableFormatting) };
            if (source.Name == W + "p")
            {
                block.Kind = "paragraph";
                block.StyleId = DocxSourceStyles.Val(source.Element(W + "pPr")?.Element(W + "pStyle"));
                var properties = styles.Paragraph(source);
                block.PropertiesXml = properties.ToString(SaveOptions.DisableFormatting);
                numbering.Apply(properties, block, code => Warn(manifest, code, path, code == "numbering_unresolved"));
                var text = new StringBuilder();
                foreach (var run in source.Descendants(W + "r").Where(r => r.Ancestors(W + "p").FirstOrDefault() == source))
                {
                    var runText = new StringBuilder();
                    foreach (var item in run.Elements())
                    {
                        if (item.Name == W + "t") runText.Append(item.Value);
                        else if (item.Name == W + "tab") runText.Append('\t');
                        else if (item.Name == W + "cr") runText.Append('\n');
                        else if (item.Name == W + "br")
                        {
                            var type = (string?)item.Attribute(W + "type") ?? "textWrapping";
                            runText.Append(type == "textWrapping" ? "\n" : "\f");
                            if (type != "textWrapping") Warn(manifest, "explicit_" + type + "_break", path, false);
                        }
                        else if (item.Name == W + "noBreakHyphen") runText.Append('\u2011');
                        else if (item.Name == W + "softHyphen") runText.Append('\u00ad');
                        else if (item.Name == W + "fldChar" || item.Name == W + "instrText") Warn(manifest, "field_cache_requires_review", path, false);
                        else if (item.Name != W + "rPr" && item.Name != W + "lastRenderedPageBreak")
                            Warn(manifest, "unsupported_run_content:" + item.Name.LocalName, path, true);
                    }
                    block.Runs.Add(new DrawingSpecRun { Text = runText.ToString(), PropertiesXml = styles.Run(source, run).ToString(SaveOptions.DisableFormatting) });
                    text.Append(runText);
                }
                foreach (var nested in source.Descendants().Where(e => e.Name == W + "sdt" || e.Name == W + "ins" || e.Name == W + "del" || e.Name == W + "fldSimple" || e.Name == W + "hyperlink"))
                    Warn(manifest, "structured_or_revision_content:" + nested.Name.LocalName, path, nested.Name == W + "del" || nested.Name == W + "sdt");
                var containers = new HashSet<XName> { W + "r", W + "smartTag", W + "hyperlink", W + "fldSimple", W + "ins", W + "del" };
                var markers = new HashSet<XName> { W + "pPr", W + "smartTagPr", W + "proofErr", W + "bookmarkStart", W + "bookmarkEnd", W + "commentRangeStart", W + "commentRangeEnd", W + "permStart", W + "permEnd" };
                foreach (var child in source.Descendants().Where(e => e.Parent == source || containers.Contains(e.Parent!.Name)))
                    if (!containers.Contains(child.Name) && !markers.Contains(child.Name) && child.Parent?.Name != W + "r")
                        Warn(manifest, "unsupported_paragraph_structure:" + child.Name.LocalName, path, true);
                block.Text = text.ToString();
                if (properties.Element(W + "sectPr") != null) Warn(manifest, "section_break_requires_layout_policy", path, false);
                return block;
            }
            if (source.Name == W + "tbl" || source.Name == W + "tr" || source.Name == W + "tc")
            {
                block.Kind = source.Name == W + "tbl" ? "table" : source.Name == W + "tr" ? "table_row" : "table_cell";
                int index = 0;
                foreach (var child in source.Elements().Where(e => e.Name != W + "tblPr" && e.Name != W + "tblGrid" && e.Name != W + "trPr" && e.Name != W + "tcPr"))
                    block.Children.Add(ReadBlock(child, path + "/" + index++, manifest, styles, numbering));
                Warn(manifest, "table_requires_layout", path, false);
            }
            else if (source.Name == W + "sectPr") block.Kind = "section_properties";
            else Warn(manifest, "unsupported_body_structure:" + source.Name.LocalName, path, true);
            return block;
        }

        private static void Warn(DrawingSpecSourceManifest manifest, string code, string path, bool incomplete)
        {
            if (!manifest.Warnings.Any(w => w.Code == code && w.SourcePath == path)) manifest.Warnings.Add(new DrawingSpecWarning { Code = code, SourcePath = path });
            if (incomplete) manifest.BodyTextComplete = false;
        }

        private static XDocument ParseXml(byte[] bytes)
        {
            using (var stream = new MemoryStream(bytes, false))
            using (var reader = XmlReader.Create(stream, new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxPartBytes }))
                return XDocument.Load(reader, LoadOptions.PreserveWhitespace);
        }

        private static string Hash(byte[] bytes)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
        }
    }
}
