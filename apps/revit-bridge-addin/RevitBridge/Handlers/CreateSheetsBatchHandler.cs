using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class CreateSheetsBatchHandler : IRequestHandler
    {
        private sealed class ResultEntry
        {
            public int index { get; set; }
            public bool ok { get; set; }
            public long? sheetId { get; set; }
            public string? name { get; set; }
            public string? number { get; set; }
            public bool? isPlaceholder { get; set; }
            public bool? convertedFromPlaceholder { get; set; }
            public long? convertedFromSheetId { get; set; }
            public string? error { get; set; }
        }

        public sealed class SheetSpec
        {
            public string? name { get; set; }
            public string? number { get; set; }
            public long? titleBlockId { get; set; } // type id; -1 => auto-pick first titleblock type
            public bool? placeholder { get; set; } // create placeholder sheet
            public long? convertPlaceholderSheetId { get; set; } // convert existing placeholder sheet to real sheet
        }

        public sealed class Params
        {
            public List<SheetSpec>? sheets { get; set; }
            public string? sourceCsvPath { get; set; } // optional Workspace-relative CSV path
            public string? csvDelimiter { get; set; } // comma|tab|semicolon|pipe|single char
            public long? titleBlockIdDefault { get; set; } // optional default when spec.titleBlockId omitted
            public string? behavior { get; set; } // allOrNothing|bestEffort
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var specs = (p.sheets ?? new List<SheetSpec>()).Where(x => x != null).ToList();
            if (!string.IsNullOrWhiteSpace(p.sourceCsvPath))
            {
                var fromCsv = LoadSpecsFromCsv(p.sourceCsvPath!, p.csvDelimiter);
                specs.AddRange(fromCsv);
            }
            if (specs.Count == 0) throw new InvalidOperationException("create-sheets.sheets is required and must be a non-empty array.");
            if (specs.Count > 200) throw new InvalidOperationException("create-sheets.sheets too large (max 200).");

            var dryRun = p.dryRun ?? false;
            var behavior = (p.behavior ?? "bestEffort").Trim();
            var allOrNothing = behavior.Equals("allOrNothing", StringComparison.OrdinalIgnoreCase);

            var existingNumbers = new HashSet<string>(
                new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .Where(s => s != null)
                    .Select(s => (s.SheetNumber ?? "").Trim())
                    .Where(s => !string.IsNullOrWhiteSpace(s)),
                StringComparer.OrdinalIgnoreCase);

            var planned = new List<object>(capacity: specs.Count);
            var warnings = new List<string>();

            var inputNumbers = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (var s in specs)
            {
                var n = (s.number ?? "").Trim();
                if (string.IsNullOrWhiteSpace(n)) continue;
                inputNumbers.TryGetValue(n, out var c);
                inputNumbers[n] = c + 1;
            }

            foreach (var s in specs)
            {
                var n = (s.number ?? "").Trim();
                var name = RevitTextCasePolicy.NormalizeSheetName(s.name);
                var tbId = s.titleBlockId ?? p.titleBlockIdDefault;
                var wantsPlaceholder = s.placeholder ?? false;
                var convertPlaceholderSheetId = s.convertPlaceholderSheetId;

                var ok = true;
                string? error = null;
                if (convertPlaceholderSheetId.HasValue && convertPlaceholderSheetId.Value > 0)
                {
                    var existing = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(convertPlaceholderSheetId.Value)) as ViewSheet;
                    if (existing == null)
                    {
                        ok = false;
                        error = $"Placeholder sheet {convertPlaceholderSheetId.Value} not found.";
                    }
                    else if (!existing.IsPlaceholder)
                    {
                        ok = false;
                        error = $"Sheet {convertPlaceholderSheetId.Value} is not a placeholder.";
                    }
                    else if (wantsPlaceholder)
                    {
                        ok = false;
                        error = "convertPlaceholderSheetId cannot be combined with placeholder:true.";
                    }
                }
                else if (!string.IsNullOrWhiteSpace(n) && existingNumbers.Contains(n))
                {
                    ok = false;
                    error = $"Sheet number '{n}' already exists.";
                }
                else if (!string.IsNullOrWhiteSpace(n) && inputNumbers.TryGetValue(n, out var count) && count > 1)
                {
                    ok = false;
                    error = $"Sheet number '{n}' is duplicated in request.";
                }

                planned.Add(new
                {
                    ok,
                    name = string.IsNullOrWhiteSpace(name) ? null : name,
                    number = string.IsNullOrWhiteSpace(n) ? null : n,
                    titleBlockId = tbId,
                    placeholder = wantsPlaceholder,
                    convertPlaceholderSheetId,
                    error
                });
            }

            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    requestedCount = specs.Count,
                    behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                    plan = planned,
                    warnings
                });
            }

            var results = new List<ResultEntry>(capacity: specs.Count);
            using (var t = new Transaction(doc, "Create Sheets (Batch)"))
            {
                t.Start();

                for (int i = 0; i < specs.Count; i++)
                {
                    var s = specs[i];
                    var n = (s.number ?? "").Trim();
                    var name = RevitTextCasePolicy.NormalizeSheetName(s.name);
                    var tbId = s.titleBlockId ?? p.titleBlockIdDefault ?? -1;
                    var wantsPlaceholder = s.placeholder ?? false;
                    var convertPlaceholderSheetId = s.convertPlaceholderSheetId;

                    try
                    {
                        ViewSheet sheet;
                        if (convertPlaceholderSheetId.HasValue && convertPlaceholderSheetId.Value > 0)
                        {
                            var existing = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(convertPlaceholderSheetId.Value)) as ViewSheet;
                            if (existing == null) throw new InvalidOperationException($"Placeholder sheet {convertPlaceholderSheetId.Value} not found.");
                            if (!existing.IsPlaceholder) throw new InvalidOperationException($"Sheet {convertPlaceholderSheetId.Value} is not a placeholder.");
                            var titleBlockTypeId = ResolveTitleBlockTypeId(doc, tbId);
                            sheet = ConvertPlaceholderToReal(doc, existing, titleBlockTypeId);
                        }
                        else if (wantsPlaceholder)
                        {
                            sheet = CreatePlaceholderSheet(doc);
                        }
                        else
                        {
                            var titleBlockTypeId = ResolveTitleBlockTypeId(doc, tbId);
                            sheet = ViewSheet.Create(doc, titleBlockTypeId);
                        }

                        if (!string.IsNullOrWhiteSpace(name)) sheet.Name = name;
                        if (!string.IsNullOrWhiteSpace(n)) sheet.SheetNumber = n;

                        results.Add(new ResultEntry
                        {
                            index = i,
                            ok = true,
                            sheetId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                            name = sheet.Name,
                            number = sheet.SheetNumber,
                            isPlaceholder = sheet.IsPlaceholder,
                            convertedFromPlaceholder = convertPlaceholderSheetId.HasValue && convertPlaceholderSheetId.Value > 0,
                            convertedFromSheetId = convertPlaceholderSheetId
                        });
                    }
                    catch (Exception ex)
                    {
                        results.Add(new ResultEntry { index = i, ok = false, error = ex.Message, name = string.IsNullOrWhiteSpace(name) ? null : name, number = string.IsNullOrWhiteSpace(n) ? null : n });
                        if (allOrNothing)
                        {
                            t.RollBack();
                            return Task.FromResult<object>(new
                            {
                                status = "Failed",
                                dryRun = false,
                                behavior = "allOrNothing",
                                requestedCount = specs.Count,
                                results,
                                warnings
                            });
                        }
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new
            {
                status = "Success",
                dryRun = false,
                behavior = allOrNothing ? "allOrNothing" : "bestEffort",
                requestedCount = specs.Count,
                createdCount = results.Count(x => x.ok),
                results,
                warnings
            });
        }

        private static List<SheetSpec> LoadSpecsFromCsv(string sourceCsvPath, string? delimiterToken)
        {
            var fullPath = WorkspacePaths.ResolveFileUnderWorkspace(sourceCsvPath);
            if (!File.Exists(fullPath))
            {
                throw new InvalidOperationException($"create-sheets sourceCsvPath not found: {sourceCsvPath}");
            }

            var lines = File.ReadAllLines(fullPath);
            if (lines.Length == 0) return new List<SheetSpec>();

            var delimiter = ResolveDelimiter(delimiterToken);
            var header = ParseCsvLine(lines[0], delimiter);
            var hasHeader = header.Any(h =>
                NormalizeHeader(h) == "sheetnumber" ||
                NormalizeHeader(h) == "number" ||
                NormalizeHeader(h) == "sheetname" ||
                NormalizeHeader(h) == "name");

            var rows = new List<SheetSpec>();
            var start = hasHeader ? 1 : 0;
            for (var i = start; i < lines.Length; i++)
            {
                var line = lines[i];
                if (string.IsNullOrWhiteSpace(line)) continue;

                var cols = ParseCsvLine(line, delimiter);
                if (cols.Count == 0) continue;

                var spec = hasHeader
                    ? ReadSpecFromNamedColumns(header, cols)
                    : ReadSpecFromPositionalColumns(cols);

                if (spec == null) continue;
                if (string.IsNullOrWhiteSpace(spec.name) &&
                    string.IsNullOrWhiteSpace(spec.number) &&
                    !spec.convertPlaceholderSheetId.HasValue)
                {
                    continue;
                }

                rows.Add(spec);
            }

            return rows;
        }

        private static SheetSpec? ReadSpecFromNamedColumns(List<string> header, List<string> cols)
        {
            string? Read(string key)
            {
                for (var i = 0; i < header.Count && i < cols.Count; i++)
                {
                    if (NormalizeHeader(header[i]) == key) return cols[i];
                }
                return null;
            }

            var number = Read("sheetnumber") ?? Read("number");
            var name = Read("sheetname") ?? Read("name");
            var placeholderText = Read("placeholder");
            var titleBlockText = Read("titleblockid");
            var convertText = Read("convertplaceholdersheetid");

            long? titleBlockId = null;
            if (long.TryParse((titleBlockText ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var tb))
            {
                titleBlockId = tb;
            }

            long? convertPlaceholderSheetId = null;
            if (long.TryParse((convertText ?? "").Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var convertId))
            {
                convertPlaceholderSheetId = convertId;
            }

            bool? placeholder = null;
            if (!string.IsNullOrWhiteSpace(placeholderText))
            {
                var normalized = placeholderText.Trim().ToLowerInvariant();
                if (normalized is "1" or "true" or "yes" or "y") placeholder = true;
                if (normalized is "0" or "false" or "no" or "n") placeholder = false;
            }

            return new SheetSpec
            {
                number = string.IsNullOrWhiteSpace(number) ? null : number.Trim(),
                name = string.IsNullOrWhiteSpace(name) ? null : name.Trim(),
                titleBlockId = titleBlockId,
                placeholder = placeholder,
                convertPlaceholderSheetId = convertPlaceholderSheetId
            };
        }

        private static SheetSpec? ReadSpecFromPositionalColumns(List<string> cols)
        {
            var number = cols.Count > 0 ? cols[0] : null;
            var name = cols.Count > 1 ? cols[1] : null;

            return new SheetSpec
            {
                number = string.IsNullOrWhiteSpace(number) ? null : number.Trim(),
                name = string.IsNullOrWhiteSpace(name) ? null : name.Trim()
            };
        }

        private static string NormalizeHeader(string? raw)
        {
            return (raw ?? "")
                .Trim()
                .ToLowerInvariant()
                .Replace(" ", "")
                .Replace("_", "")
                .Replace("-", "");
        }

        private static char ResolveDelimiter(string? token)
        {
            var key = (token ?? "comma").Trim().ToLowerInvariant();
            return key switch
            {
                "comma" => ',',
                "tab" => '\t',
                "semicolon" => ';',
                "pipe" => '|',
                _ => key.Length == 1 ? key[0] : ','
            };
        }

        private static List<string> ParseCsvLine(string line, char delimiter)
        {
            var output = new List<string>();
            if (line == null)
            {
                output.Add(string.Empty);
                return output;
            }

            var current = "";
            var inQuotes = false;
            for (var i = 0; i < line.Length; i++)
            {
                var c = line[i];
                if (c == '"')
                {
                    if (inQuotes && i + 1 < line.Length && line[i + 1] == '"')
                    {
                        current += '"';
                        i++;
                    }
                    else
                    {
                        inQuotes = !inQuotes;
                    }
                    continue;
                }

                if (c == delimiter && !inQuotes)
                {
                    output.Add(current);
                    current = "";
                    continue;
                }

                current += c;
            }

            output.Add(current);
            return output;
        }

        private static ElementId ResolveTitleBlockTypeId(Document doc, long titleBlockId)
        {
            if (titleBlockId > 0) return RevitBridge.Common.ElementIdCompat.Create(titleBlockId);

            var id = new FilteredElementCollector(doc)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsElementType()
                .FirstElementId();

            if (id == null || id == ElementId.InvalidElementId) throw new InvalidOperationException("No titleblock types found in document.");
            return id;
        }

        private static ViewSheet CreatePlaceholderSheet(Document doc)
        {
            var createPlaceholder = typeof(ViewSheet).GetMethod(
                "CreatePlaceholder",
                BindingFlags.Public | BindingFlags.Static,
                binder: null,
                types: new[] { typeof(Document) },
                modifiers: null);

            if (createPlaceholder != null)
            {
                var raw = createPlaceholder.Invoke(null, new object[] { doc });
                if (raw is ViewSheet placeholderSheet) return placeholderSheet;
            }

            throw new InvalidOperationException("This Revit API version does not expose ViewSheet.CreatePlaceholder.");
        }

        private static ViewSheet ConvertPlaceholderToReal(Document doc, ViewSheet placeholderSheet, ElementId titleBlockTypeId)
        {
            if (placeholderSheet == null) throw new ArgumentNullException(nameof(placeholderSheet));
            if (titleBlockTypeId == null || titleBlockTypeId == ElementId.InvalidElementId)
                throw new InvalidOperationException("A valid title block type is required to convert placeholder sheets.");

            var type = placeholderSheet.GetType();
            var candidateMethods = new[]
            {
                type.GetMethod("ConvertToRealSheet", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(ElementId) }, null),
                type.GetMethod("ConvertToSheet", BindingFlags.Public | BindingFlags.Instance, null, new[] { typeof(ElementId) }, null),
                type.GetMethod("ConvertToRealSheet", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null),
                type.GetMethod("ConvertToSheet", BindingFlags.Public | BindingFlags.Instance, null, Type.EmptyTypes, null)
            }.Where(m => m != null).Cast<MethodInfo>().ToList();

            foreach (var method in candidateMethods)
            {
                var args = method.GetParameters().Length == 1
                    ? new object[] { titleBlockTypeId }
                    : Array.Empty<object>();
                var result = method.Invoke(placeholderSheet, args);
                if (result is ViewSheet vs) return vs;
                if (result is ElementId eid && eid != ElementId.InvalidElementId)
                {
                    var resolved = doc.GetElement(eid) as ViewSheet;
                    if (resolved != null) return resolved;
                }
            }

            throw new InvalidOperationException("This Revit API version does not expose placeholder-to-real conversion methods.");
        }
    }
}
