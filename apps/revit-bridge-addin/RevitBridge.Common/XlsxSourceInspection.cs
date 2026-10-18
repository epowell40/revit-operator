using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Xml.Linq;

namespace RevitBridge.Common
{
    // Entire source records, a source-bound cursor and an explicit response budget.
    // This inspection neither recalculates formulas nor certifies a native import.
    public static class XlsxSourceInspection
    {
        public const int MaxPageBytes = 64 * 1024;
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };

        public static object Read(byte[] package, string requestJson)
        {
            var request = XlsxSourceInspectionRequest.Parse(requestJson);
            var source = XlsxOutputSourceReader.Read(package, request.sheetName);
            var sheet = source.SelectedSheet;
            var summary = new { worksheetCount = source.Worksheets.Count, selectedSheet = sheet?.Identity, bounds = sheet?.Bounds,
                reportedDimension = sheet?.ReportedDimension, totalCells = sheet?.Cells.Count, totalRows = sheet?.Rows.Count,
                totalColumnDefinitions = sheet?.Columns.Count, totalMerges = sheet?.Merges.Count,
                formulaCount = sheet?.FormulaCount, cachedFormulaErrorCount = sheet?.CachedErrorCount, errorCellCount = sheet?.ErrorCellCount,
                missingFormulaCacheCount = sheet?.MissingFormulaCacheCount,
                defaultRowHeightPoints = sheet?.DefaultRowHeightPoints, defaultColumnWidthCharacters = sheet?.DefaultColumnWidthCharacters,
                issueCounts = source.Issues.GroupBy(i => i.Code).ToDictionary(g => g.Key, g => g.Count()),
                externalLinkPartCount = source.ExternalLinkParts.Count, activeContentPartCount = source.ActiveContentParts.Count };
            int offset = request.pageOffset ?? 0;
            bool stale = request.expectedSourceSha256 != null && request.expectedSourceSha256 != source.SourceSha256;
            var records = Records(source, request.section!).ToList();
            if (!stale && offset > records.Count) throw new ArgumentException("XLSX inspection page begins beyond the selected section.");
            var page = new List<object>();
            object Envelope() => new { schema = "operator.xlsx_source_inspection.v1", status = stale ? "SourceChanged" : "Ok", readOnly = true,
                sourcePath = request.sourcePath, sourceSha256 = source.SourceSha256, calculationPerformed = false, nativeImportVerified = false,
                summary, section = request.section, totalRecords = records.Count, offset, records = page,
                hasMore = !stale && offset + page.Count < records.Count,
                nextOffset = !stale && offset + page.Count < records.Count ? (int?)(offset + page.Count) : null,
                limits = new[] { "Source inspection only; cached formulas are not recalculated and source errors remain explicit.",
                    "Cell text is the stored value, not Excel number-format rendering. Source style definitions are separately inspectable.",
                    "No native import, legibility, visual fidelity, engineering or whole-task completion proof." } };
            if (Size(Envelope()) > MaxPageBytes) throw new InvalidOperationException("XLSX inspection summary exceeds the page budget; no field clipped.");
            if (!stale) foreach (var record in records.Skip(offset).Take(request.pageSize ?? 20))
            {
                page.Add(record);
                if (Size(Envelope()) <= MaxPageBytes) continue;
                page.RemoveAt(page.Count - 1);
                if (page.Count == 0) throw new InvalidOperationException("One complete XLSX source record exceeds the inspection page budget; no field clipped.");
                break;
            }
            // A detached camel-case JSON object also avoids provider-dependent casing.
            return JsonSerializer.SerializeToElement(Envelope(), Json);
        }

        private static int Size(object value) => Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(value, Json));
        private static IEnumerable<object> Records(XlsxOutputSourceManifest source, string section)
        {
            var sheet = source.SelectedSheet;
            switch (section)
            {
                case "summary": return Array.Empty<object>();
                case "worksheets": return source.Worksheets;
                case "cells": return sheet!.Cells.OrderBy(c => c.Row).ThenBy(c => c.Column);
                case "rows": return sheet!.Rows.OrderBy(r => r.Index);
                case "columns": return sheet!.Columns.OrderBy(c => c.First);
                case "merges": return sheet!.Merges.OrderBy(m => m.FirstRow).ThenBy(m => m.FirstColumn);
                case "issues": return source.Issues;
                case "formatting": return Formatting(source);
                case "printContext": return new object[] { new { xml = sheet!.PrintContextXml } };
                default: throw new ArgumentException("Unknown XLSX inspection section.");
            }
        }
        private static IEnumerable<object> Formatting(XlsxOutputSourceManifest source)
        {
            foreach (var part in source.FormattingParts.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                var root = XElement.Parse(part.Value);
                foreach (var group in root.Elements())
                {
                    // Leaf groups and complete indexed child records retain their own
                    // original XML. No byte slicing through an XML/style record.
                    int index = 0;
                    foreach (var item in group.HasElements ? group.Elements() : new[] { group })
                        yield return new { part = part.Key, group = group.Name.LocalName, index = index++, xml = item.ToString(SaveOptions.DisableFormatting) };
                }
            }
        }
    }
}
