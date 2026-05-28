using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportWarningsReportHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? action { get; set; } // "export" (default) | "list"
            public string? outputFolder { get; set; }
            public string? fileName { get; set; }
            public string? filePath { get; set; } // workspace-relative or absolute-under-workspace override
            public string? format { get; set; } // "txt" (default) | "json" | "csv"
            public int? max { get; set; } // legacy alias for limit
            public int? limit { get; set; } // default 500
            public int? offset { get; set; } // default 0
            public bool? includeElements { get; set; } // default true
            public bool? dryRun { get; set; }
        }

        private sealed class WarningItem
        {
            public int index { get; set; }
            public string warningId { get; set; } = "";
            public string severity { get; set; } = "Unknown";
            public string description { get; set; } = "";
            public List<long> failingElementIds { get; set; } = new List<long>();
            public List<long> additionalElementIds { get; set; } = new List<long>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var allWarnings = (doc.GetWarnings() ?? new List<FailureMessage>()).ToList();
            var totalWarnings = allWarnings.Count;
            var action = NormalizeAction(p.action);
            var offset = p.offset.GetValueOrDefault(0);
            if (offset < 0) offset = 0;

            var limit = p.limit ?? p.max ?? 500;
            if (limit < 1) limit = 1;
            if (limit > 5000) limit = 5000;

            var includeElements = p.includeElements ?? true;
            var requestedFormat = (p.format ?? "txt").Trim().ToLowerInvariant();
            var format = requestedFormat switch
            {
                "json" => "json",
                "csv" => "csv",
                _ => "txt"
            };

            var pageWarnings = allWarnings.Skip(offset).Take(limit).ToList();
            var items = new List<WarningItem>(Math.Min(limit, pageWarnings.Count));
            var index = offset;
            foreach (var warning in pageWarnings)
            {
                index++;
                var item = new WarningItem
                {
                    index = index,
                    warningId = SafeGetWarningId(warning, index),
                    severity = SafeGetSeverity(warning),
                    description = SafeGetDescription(warning)
                };

                if (includeElements)
                {
                    item.failingElementIds = SafeGetElementIds(warning, isAdditional: false);
                    item.additionalElementIds = SafeGetElementIds(warning, isAdditional: true);
                }

                items.Add(item);
            }

            var bySeverity = items
                .GroupBy(x => string.IsNullOrWhiteSpace(x.severity) ? "Unknown" : x.severity)
                .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);

            var returned = items.Count;
            var hasMore = offset + returned < totalWarnings;
            int? nextOffset = hasMore ? offset + returned : (int?)null;

            var plan = new
            {
                action,
                format,
                offset,
                limit,
                includeElements,
                totalWarnings,
                returned,
                hasMore,
                nextOffset
            };

            if (string.Equals(action, "list", StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(new
                {
                    status = "Ok",
                    action = "list",
                    dryRun = true,
                    offset,
                    limit,
                    returned,
                    totalWarnings,
                    total = totalWarnings,
                    hasMore,
                    nextOffset,
                    includeElements,
                    bySeverityCounts = bySeverity,
                    warnings = items
                });
            }

            var (folder, fileName, fullPath) = ResolveOutputPaths(p, format);
            var exportPlan = new
            {
                outputFolder = folder,
                fileName,
                path = fullPath,
                action = "export",
                format,
                offset,
                limit,
                includeElements,
                totalWarnings,
                exportedWarnings = returned,
                hasMore,
                nextOffset
            };

            if (p.dryRun ?? false)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    plan = exportPlan
                });
            }

            if (format == "json")
            {
                var payload = new
                {
                    generatedAt = DateTime.UtcNow.ToString("o"),
                    document = new
                    {
                        title = doc.Title,
                        path = doc.PathName
                    },
                    summary = new
                    {
                        totalWarnings,
                        exportedWarnings = returned,
                        offset,
                        limit,
                        returned,
                        hasMore,
                        nextOffset,
                        includeElements,
                        bySeverityCounts = bySeverity
                    },
                    warnings = items
                };

                var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(fullPath, json, Encoding.UTF8);
            }
            else if (format == "csv")
            {
                WriteCsv(fullPath, items, includeElements);
            }
            else
            {
                var sb = new StringBuilder();
                sb.AppendLine($"Generated: {DateTime.UtcNow:o}");
                sb.AppendLine($"Document: {doc.Title}");
                if (!string.IsNullOrWhiteSpace(doc.PathName)) sb.AppendLine($"Path: {doc.PathName}");
                sb.AppendLine($"Total warnings: {totalWarnings}");
                sb.AppendLine($"Exported warnings: {returned}");
                sb.AppendLine($"Offset: {offset}");
                sb.AppendLine($"Limit: {limit}");
                sb.AppendLine($"Include elements: {includeElements}");
                sb.AppendLine();

                foreach (var item in items)
                {
                    sb.AppendLine($"[{item.index}] {item.severity} ({item.warningId}): {item.description}");
                    if (includeElements)
                    {
                        if (item.failingElementIds.Count > 0)
                            sb.AppendLine($"  failingElementIds: {string.Join(", ", item.failingElementIds)}");
                        if (item.additionalElementIds.Count > 0)
                            sb.AppendLine($"  additionalElementIds: {string.Join(", ", item.additionalElementIds)}");
                    }
                    sb.AppendLine();
                }

                File.WriteAllText(fullPath, sb.ToString(), Encoding.UTF8);
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                action = "export",
                outputFolder = folder,
                fileName,
                path = fullPath,
                format,
                totalWarnings,
                exportedWarnings = returned,
                returned,
                offset,
                limit,
                hasMore,
                nextOffset,
                bySeverityCounts = bySeverity
            });
        }

        private static string NormalizeAction(string? action)
        {
            var normalized = (action ?? "export").Trim().ToLowerInvariant();
            return normalized switch
            {
                "" => "export",
                "export" => "export",
                "write" => "export",
                "list" => "list",
                "preview" => "list",
                _ => normalized
            };
        }

        private static (string folder, string fileName, string fullPath) ResolveOutputPaths(Params p, string format)
        {
            if (!string.IsNullOrWhiteSpace(p.filePath))
            {
                var fullPath = WorkspacePaths.ResolveFileUnderWorkspace(p.filePath!);
                var folder = Path.GetDirectoryName(fullPath) ?? WorkspacePaths.ResolveDirectoryUnderWorkspace(null, "artifacts", "reports");
                Directory.CreateDirectory(folder);
                var fileName = BuildFileName(Path.GetFileName(fullPath), format);
                var rewrittenFullPath = Path.Combine(folder, fileName);
                return (folder, fileName, rewrittenFullPath);
            }

            var resolvedFolder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "reports");
            var resolvedFileName = BuildFileName(p.fileName, format);
            var path = Path.Combine(resolvedFolder, resolvedFileName);
            return (resolvedFolder, resolvedFileName, path);
        }

        private static string BuildFileName(string? preferred, string format)
        {
            var ext = format == "json" ? ".json" : (format == "csv" ? ".csv" : ".txt");
            var raw = (preferred ?? "").Trim();
            if (string.IsNullOrWhiteSpace(raw))
            {
                raw = $"warnings_report_{DateTime.Now:yyyyMMddHHmmss}{ext}";
            }

            var sanitized = SanitizeFileName(raw);
            if (!sanitized.EndsWith(ext, StringComparison.OrdinalIgnoreCase))
            {
                sanitized += ext;
            }

            return sanitized;
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) s = "warnings_report.txt";

            foreach (var c in Path.GetInvalidFileNameChars())
            {
                s = s.Replace(c, '_');
            }

            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            if (s.Length == 0) s = "warnings_report.txt";

            return s;
        }

        private static void WriteCsv(string path, List<WarningItem> items, bool includeElements)
        {
            var sb = new StringBuilder();
            sb.AppendLine("index,warningId,severity,description,failingElementIds,additionalElementIds");
            foreach (var item in items)
            {
                var failing = includeElements ? string.Join("|", item.failingElementIds) : "";
                var additional = includeElements ? string.Join("|", item.additionalElementIds) : "";
                sb.AppendLine(string.Join(",",
                    Csv(item.index.ToString()),
                    Csv(item.warningId),
                    Csv(item.severity),
                    Csv(item.description),
                    Csv(failing),
                    Csv(additional)));
            }

            File.WriteAllText(path, sb.ToString(), Encoding.UTF8);
        }

        private static string Csv(string? value)
        {
            var raw = value ?? "";
            if (raw.IndexOfAny(new[] { ',', '"', '\r', '\n' }) < 0) return raw;
            return $"\"{raw.Replace("\"", "\"\"")}\"";
        }

        private static string SafeGetDescription(FailureMessage warning)
        {
            try
            {
                return warning.GetDescriptionText() ?? "";
            }
            catch
            {
                return "";
            }
        }

        private static string SafeGetSeverity(FailureMessage warning)
        {
            try
            {
                return warning.GetSeverity().ToString();
            }
            catch
            {
                return "Unknown";
            }
        }

        private static string SafeGetWarningId(FailureMessage warning, int fallbackIndex)
        {
            try
            {
                var id = warning.GetFailureDefinitionId();
                if (id != null)
                {
                    var prop = id.GetType().GetProperty("Guid");
                    if (prop != null)
                    {
                        var raw = prop.GetValue(id);
                        if (raw is Guid g && g != Guid.Empty) return g.ToString("D");
                    }

                    var asText = id.ToString();
                    if (!string.IsNullOrWhiteSpace(asText)) return asText.Trim();
                }
            }
            catch
            {
                // ignore and fallback
            }

            return $"warning-{fallbackIndex}";
        }

        private static List<long> SafeGetElementIds(FailureMessage warning, bool isAdditional)
        {
            try
            {
                ICollection<ElementId> ids = isAdditional
                    ? warning.GetAdditionalElements()
                    : warning.GetFailingElements();
                return ids?.Where(x => x != null).Select(x => RevitBridge.Common.ElementIdCompat.GetValue(x)).ToList() ?? new List<long>();
            }
            catch
            {
                return new List<long>();
            }
        }
    }
}
