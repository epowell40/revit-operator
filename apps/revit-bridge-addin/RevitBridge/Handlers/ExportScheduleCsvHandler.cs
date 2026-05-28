using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportScheduleCsvHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? scheduleId { get; set; }
            public string? query { get; set; }
            public bool? exact { get; set; }

            public string? outputFolder { get; set; }
            public string? fileName { get; set; }

            public string? delimiter { get; set; } // comma|tab|semicolon|pipe|custom single char
            public string? textQualifier { get; set; } // DoubleQuote|SingleQuote|None
            public string? columnHeaders { get; set; } // MultipleRows|OneRow|None

            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var exact = p.exact ?? false;
            var schedule = ScheduleSelectionHelper.ResolveSchedule(doc, p.scheduleId, p.query, exact);
            if (schedule == null)
            {
                throw new InvalidOperationException("Schedule not found. Provide scheduleId or query.");
            }

            var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(p.outputFolder, "artifacts", "schedules");
            var fileName = BuildFileName(schedule, p.fileName);
            var delimiter = ResolveDelimiter(p.delimiter);

            var plan = new
            {
                outputFolder = folder,
                fileName,
                delimiter,
                textQualifier = string.IsNullOrWhiteSpace(p.textQualifier) ? null : p.textQualifier,
                columnHeaders = string.IsNullOrWhiteSpace(p.columnHeaders) ? null : p.columnHeaders,
                schedule = new { id = RevitBridge.Common.ElementIdCompat.GetValue(schedule.Id), name = schedule.Name }
            };

            if (p.dryRun ?? false)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    plan
                });
            }

            var options = new ViewScheduleExportOptions();
            TrySetStringProperty(options, "FieldDelimiter", delimiter);
            TrySetEnumLikeProperty(options, "TextQualifier", p.textQualifier);
            TrySetEnumLikeProperty(options, "ColumnHeaders", p.columnHeaders);

            schedule.Export(folder, fileName, options);

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                outputFolder = folder,
                fileName,
                path = Path.Combine(folder, fileName),
                delimiter,
                schedule = new { id = RevitBridge.Common.ElementIdCompat.GetValue(schedule.Id), name = schedule.Name }
            });
        }

        private static string BuildFileName(ViewSchedule schedule, string? preferred)
        {
            var raw = (preferred ?? "").Trim();
            if (string.IsNullOrWhiteSpace(raw))
            {
                raw = $"{(schedule.Name ?? "Schedule")}_{DateTime.Now:yyyyMMddHHmmss}.csv";
            }

            var sanitized = SanitizeFileName(raw);
            if (!sanitized.EndsWith(".csv", StringComparison.OrdinalIgnoreCase))
            {
                sanitized += ".csv";
            }

            return sanitized;
        }

        private static string ResolveDelimiter(string? delimiter)
        {
            var key = (delimiter ?? "comma").Trim().ToLowerInvariant();
            return key switch
            {
                "comma" => ",",
                "tab" => "\t",
                "semicolon" => ";",
                "pipe" => "|",
                _ => key.Length == 1 ? key : ","
            };
        }

        private static string SanitizeFileName(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) s = "Schedule.csv";

            foreach (var c in Path.GetInvalidFileNameChars())
            {
                s = s.Replace(c, '_');
            }

            s = s.Replace(Path.DirectorySeparatorChar, '_').Replace(Path.AltDirectorySeparatorChar, '_');
            s = Path.GetFileName(s);
            if (s.Length > 180) s = s.Substring(0, 180).Trim();
            if (s.Length == 0) s = "Schedule.csv";

            return s;
        }

        private static bool TrySetStringProperty(object target, string propName, string value)
        {
            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || p.PropertyType != typeof(string)) return false;
                p.SetValue(target, value, null);
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static bool TrySetEnumLikeProperty(object target, string propName, string? value)
        {
            var raw = (value ?? "").Trim();
            if (raw.Length == 0) return false;

            try
            {
                var p = target.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                if (p == null || !p.CanWrite || !p.PropertyType.IsEnum) return false;

                var parsed = Enum.Parse(p.PropertyType, raw, ignoreCase: true);
                p.SetValue(target, parsed, null);
                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
