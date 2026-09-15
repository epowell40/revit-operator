using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public sealed class ExportElementsXlsxHandler : IRequestHandler
    {
        private const string Route = "/revit/export-elements-xlsx";
        public sealed class Params
        {
            public List<long>? elementIds { get; set; }
            public List<string>? parameterNames { get; set; }
            public string? outputFolder { get; set; }
            public string? fileName { get; set; }
            public bool? dryRun { get; set; }
            public List<OperatorWorkbookSupplementalTables.Table>? supplementalTables { get; set; }
        }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument.Document;
            var ids = p.elementIds ?? new List<long>();
            if (ids.Count < 1 || ids.Count > 2000 || ids.Any(x => x <= 0) || ids.Distinct().Count() != ids.Count)
                throw new ArgumentException("Provide 1 to 2000 unique positive elementIds observed in the active document.");
            var names = (p.parameterNames ?? new List<string>()).Select(x => (x ?? "").Trim()).ToList();
            if (names.Count < 1 || names.Count > 100 || names.Any(x => x.Length < 1 || x.Length > 128) || names.Distinct(StringComparer.OrdinalIgnoreCase).Count() != names.Count)
                throw new ArgumentException("Provide 1 to 100 unique, exact parameter names observed on the selected elements.");
            var elements = ids.Select(id => doc.GetElement(ElementIdCompat.Create(id))).ToList();
            var missingIds = ids.Where((id, i) => elements[i] == null).ToArray();
            if (missingIds.Length > 0) throw new ArgumentException("No workbook was written. Selected elements no longer exist: " + string.Join(", ", missingIds));
            var supplemental = OperatorWorkbookSupplementalTables.Build(p.supplementalTables, elements.Select(el =>
                new OperatorWorkbookSupplementalTables.NativeIdentity { ElementId = ElementIdCompat.GetValue(el!.Id), UniqueId = el.UniqueId, Name = el.Name ?? "" }).ToArray());
            var supplementalSummary = supplemental.Select(sheet => new { name = sheet.Name, rowCount = sheet.Rows.Count - 1,
                selectedTargetCoverage = "each selected native element exactly once", contentOrigin = "assistant_authored", columns = sheet.Rows[0] }).ToArray();
            var full = OperatorWorkbookExportPath.Resolve(WorkspacePaths.GetWorkspaceRoot(), p.outputFolder, p.fileName);

            var headers = new List<object?> { "UniqueId", "ElementId", "Category", "Name" };
            foreach (var name in names) headers.AddRange(new object?[] { name + " | value", name + " | unit", name + " | display", name + " | status" });
            var rows = new List<IReadOnlyList<object?>> { headers };
            var issues = new List<IReadOnlyList<object?>> { new object?[] { "ElementId", "UniqueId", "Name", "Parameter", "Status", "Detail" } };
            var issueCounts = new Dictionary<string, int>(StringComparer.Ordinal);
            foreach (var el in elements)
            {
                var idText = ElementIdCompat.GetValue(el!.Id).ToString(CultureInfo.InvariantCulture);
                var row = new List<object?> { el.UniqueId, idText, el.Category?.Name ?? "", el.Name ?? "" };
                foreach (var name in names)
                {
                    object? value = null; var unit = ""; var display = ""; var status = "ok"; var detail = "";
                    try
                    {
                        var candidates = el.GetParameters(name);
                        if (candidates.Count == 0) { status = "missing_parameter"; detail = "Parameter is not present on this instance."; }
                        else if (candidates.Count != 1) { status = "ambiguous_parameter"; detail = candidates.Count + " parameters share this name; no value was selected."; }
                        else
                        {
                            var parameter = candidates[0];
                            if (!parameter.HasValue) { status = "unset"; detail = "Parameter is present but has no value."; }
                            else
                            {
                                display = parameter.AsValueString() ?? "";
                                switch (parameter.StorageType)
                                {
                                    case StorageType.Double:
                                        var raw = parameter.AsDouble();
                                        if (UnitUtils.IsMeasurableSpec(parameter.Definition.GetDataType()))
                                        {
                                            var unitId = parameter.GetUnitTypeId();
                                            value = UnitUtils.ConvertFromInternalUnits(raw, unitId);
                                            unit = LabelUtils.GetLabelForUnit(unitId) + " [" + unitId.TypeId + "]";
                                        }
                                        else { value = raw; unit = "dimensionless"; }
                                        if (double.IsNaN((double)value) || double.IsInfinity((double)value)) throw new InvalidOperationException("Non-finite numeric value.");
                                        break;
                                    case StorageType.Integer:
                                        value = parameter.Definition.GetDataType() == SpecTypeId.Boolean.YesNo ? (object)(parameter.AsInteger() != 0) : parameter.AsInteger();
                                        unit = value is bool ? "boolean" : "integer"; break;
                                    case StorageType.String:
                                        value = parameter.AsString() ?? ""; display = (string)value;
                                        if (string.IsNullOrWhiteSpace((string)value)) { status = "blank"; detail = "The source string is blank."; }
                                        break;
                                    case StorageType.ElementId:
                                        var referencedId = parameter.AsElementId();
                                        value = ElementIdCompat.GetValue(referencedId).ToString(CultureInfo.InvariantCulture); unit = "Revit ElementId";
                                        if (string.IsNullOrWhiteSpace(display)) display = doc.GetElement(referencedId)?.Name ?? "";
                                        break;
                                    default: status = "unsupported_storage"; detail = "The parameter has no exportable storage value."; break;
                                }
                            }
                        }
                    }
                    catch (Exception ex) { value = null; unit = ""; status = "unreadable"; detail = ex.GetType().Name + ": " + ex.Message; }
                    row.AddRange(new object?[] { value, unit, display, status });
                    if (status != "ok")
                    {
                        issues.Add(new object?[] { idText, el.UniqueId, el.Name ?? "", name, status, detail });
                        issueCounts[status] = issueCounts.TryGetValue(status, out var count) ? count + 1 : 1;
                    }
                }
                rows.Add(row);
            }
            var readme = new List<IReadOnlyList<object?>> {
                new object?[] { "Topic", "Description" },
                new object?[] { "Source model", doc.Title }, new object?[] { "Source file", doc.PathName },
                new object?[] { "Captured UTC", DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture) },
                new object?[] { "Scope", "Exact selected instances in the active document; linked documents and unselected elements are excluded. This is not proof that the selection covers every room or space." },
                new object?[] { "Exported instances", ids.Count }, new object?[] { "Requested parameters", names.Count },
                new object?[] { "Values and units", "Numeric values use the source parameter's display unit, identified in the adjacent unit column. Display strings preserve Revit formatting. Missing, duplicate-name and unreadable fields are flagged in Elements and Issues; they are not treated as zero." },
                new object?[] { "Engineering review", "Recorded model values are not independently verified engineering inputs. Confirm geometry and envelope, occupancy and schedules, equipment and lighting loads, ventilation requirements and project standards before load calculations. No heating/cooling loads or code compliance are calculated or certified by this export." },
                new object?[] { "Supplemental tables", "Optional input transcriptions, proposed quantities and review tables are assistant-authored. Their supplied values and calculations are not native model facts or verified engineering results. Native identity columns are filled by Revit; each table includes every selected element once. This does not prove that the original task scope was fully selected." },
                new object?[] { "Model changes", "No Revit transaction or model edit is performed." }
            };
            var workbookSheets = new[] { new OperatorWorkbookWriter.Sheet("Elements", rows), new OperatorWorkbookWriter.Sheet("Issues", issues), new OperatorWorkbookWriter.Sheet("Readme", readme) }.Concat(supplemental).ToArray();
            if (p.dryRun == true) return Task.FromResult<object>(new { status = "Dry Run", ok = true, dryRun = true, path = full,
                selectedCount = ids.Count, selectedElementIds = ids, parameterNames = names, parameterCount = names.Count, issueCount = issues.Count - 1, issueCounts, columns = headers,
                supplementalTables = supplementalSummary, preview = rows.Take(4).ToArray(), artifact_receipt = OperatorNativeArtifactReceipt.Preview(new[] { full }, 1, Route) });
            var capture = new OperatorNativeArtifactCapture(new[] { full }, 1, Route);
            OperatorWorkbookWriter.Write(full, workbookSheets);
            capture.RecordNativeExport(true);
            var receipt = capture.Complete();
            return Task.FromResult<object>(new { status = receipt.Status == "complete" ? "Success" : "ExportUnverified", ok = receipt.Status == "complete", dryRun = false,
                path = full, outputs = new[] { full }, selectedCount = ids.Count, requestedCount = ids.Count, itemsComplete = true, parameterCount = names.Count,
                selectedElementIds = ids, issueCount = issues.Count - 1, issueCounts, columns = headers,
                sheets = workbookSheets.Select(sheet => sheet.Name).ToArray(), supplementalTables = supplementalSummary, artifact_receipt = receipt });
        }
    }
}
