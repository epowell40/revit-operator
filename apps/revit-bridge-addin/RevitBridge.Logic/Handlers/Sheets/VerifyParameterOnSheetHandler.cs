using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class VerifyParameterOnSheetHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }

            // Either provide parameterName directly, or provide labelText to resolve via titleblock-label-map heuristics.
            public string? parameterName { get; set; }
            public string? labelText { get; set; }

            public bool includeCapture { get; set; } = true;
            public int imageMaxSizePx { get; set; } = 2400;
            public double marginFt { get; set; } = 0.15;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            ViewSheet? sheet = null;
            if (p.sheetViewId.HasValue && p.sheetViewId.Value != 0)
            {
                sheet = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.sheetViewId.Value)) as ViewSheet;
            }
            else if (!string.IsNullOrWhiteSpace(p.sheetNumber))
            {
                var target = (p.sheetNumber ?? "").Trim();
                sheet = new FilteredElementCollector(doc)
                    .OfClass(typeof(ViewSheet))
                    .Cast<ViewSheet>()
                    .FirstOrDefault(s => string.Equals((s.SheetNumber ?? "").Trim(), target, StringComparison.OrdinalIgnoreCase));
            }
            if (sheet == null) throw new InvalidOperationException("Sheet not found (provide sheetViewId or sheetNumber).");

            var titleblock = new FilteredElementCollector(doc, sheet.Id)
                .OfCategory(BuiltInCategory.OST_TitleBlocks)
                .WhereElementIsNotElementType()
                .Cast<Element>()
                .Select(e => e as FamilyInstance)
                .FirstOrDefault(e => e != null);

            var paramName = (p.parameterName ?? "").Trim();
            if (string.IsNullOrWhiteSpace(paramName))
            {
                var label = (p.labelText ?? "").Trim();
                if (string.IsNullOrWhiteSpace(label))
                    throw new InvalidOperationException("verify-parameter-on-sheet requires parameterName or labelText.");

                try
                {
                    var mapReq = new TitleblockLabelMapHandler.Params { sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), includeParameters = false, includeHeuristics = false };
                    var mapJson = JsonSerializer.Serialize(mapReq);
                    var raw = new TitleblockLabelMapHandler().Handle(app, mapJson).GetAwaiter().GetResult();

                    // Best-effort: parse mappings[] and match by label_text.
                    var sraw = JsonSerializer.Serialize(raw);
                    using var jd = JsonDocument.Parse(sraw);
                    if (jd.RootElement.TryGetProperty("mappings", out var m) && m.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in m.EnumerateArray())
                        {
                            if (item.ValueKind != JsonValueKind.Object) continue;
                            var lt = item.TryGetProperty("label_text", out var lte) && lte.ValueKind == JsonValueKind.String ? (lte.GetString() ?? "") : "";
                            if (!string.Equals(lt.Trim(), label, StringComparison.OrdinalIgnoreCase)) continue;
                            var drv = item.TryGetProperty("driver_parameter", out var de) && de.ValueKind == JsonValueKind.String ? (de.GetString() ?? "") : "";
                            if (!string.IsNullOrWhiteSpace(drv))
                            {
                                paramName = drv.Trim();
                                break;
                            }
                        }
                    }
                }
                catch
                {
                    // ignore; fall through to error below
                }

                if (string.IsNullOrWhiteSpace(paramName))
                    throw new InvalidOperationException($"Could not resolve a driving parameter for titleblock label '{label}'. Try providing parameterName explicitly.");
            }

            var matches = new List<object>();

            void TryAdd(string source, Element? el)
            {
                if (el == null) return;
                try
                {
                    var pr = el.LookupParameter(paramName);
                    if (pr == null) return;
                    matches.Add(new
                    {
                        source,
                        parameterName = paramName,
                        storageType = pr.StorageType.ToString(),
                        isReadOnly = pr.IsReadOnly,
                        value = ParameterValueUtil.SnapshotForWire(pr)
                    });
                }
                catch { }
            }

            TryAdd("titleblock_instance", titleblock);
            TryAdd("titleblock_type", titleblock?.Symbol);
            TryAdd("sheet", sheet);
            TryAdd("project_information", doc.ProjectInformation);

            object? capture = null;
            if (p.includeCapture)
            {
                try
                {
                    var capReq = new CaptureSheetRegionHandler.Params
                    {
                        sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                        region = "titleblock",
                        marginFt = p.marginFt,
                        imageMaxSizePx = p.imageMaxSizePx,
                        includeMapping = true,
                        fileName = $"verify_{sheet.SheetNumber}_{SanitizeForFile(paramName)}"
                    };
                    var capJson = JsonSerializer.Serialize(capReq);
                    capture = new CaptureSheetRegionHandler().Handle(app, capJson).GetAwaiter().GetResult();
                }
                catch (Exception ex)
                {
                    capture = new { error = ex.Message };
                }
            }

            return Task.FromResult<object>(new
            {
                sheetNumber = sheet.SheetNumber,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                parameterName = paramName,
                matches,
                capture,
                ok = matches.Count > 0
            });
        }

        private static string SanitizeForFile(string name)
        {
            var s = (name ?? "").Trim();
            if (s.Length == 0) return "param";
            foreach (var c in System.IO.Path.GetInvalidFileNameChars()) s = s.Replace(c, '_');
            s = s.Replace('\\', '_').Replace('/', '_');
            if (s.Length > 60) s = s.Substring(0, 60).Trim();
            return s;
        }
    }
}

