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
    public sealed class TitleblockSetDateSmartHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public string labelText { get; set; } = "Date";
            public string intendedValue { get; set; } = "";

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public string? confirm { get; set; }

            public int maxCandidates { get; set; } = 8;
            public bool includeOcrText { get; set; } = false;
        }

        private sealed class Candidate
        {
            public string Source = "";
            public Element Element = null!;
            public string ParamName = "";
            public string? BeforeValueString;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var intended = (p.intendedValue ?? "").Trim();
            if (string.IsNullOrWhiteSpace(intended)) throw new InvalidOperationException("titleblock-set-date-smart.intendedValue is required.");

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;

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
            if (titleblock == null) throw new InvalidOperationException("No titleblock instance found on the target sheet.");

            var symbol = titleblock.Symbol;
            if (symbol == null) throw new InvalidOperationException("Titleblock type not found.");

            // Resolve a driver hint from the titleblock label map (best-effort).
            var labelText = (p.labelText ?? "Date").Trim();
            var hintedParam = TryResolveHintedDriverParameter(app, sheet, labelText);

            // Collect candidates across likely sources.
            var candidates = CollectCandidates(doc, sheet, titleblock, symbol, hintedParam, max: p.maxCandidates);

            // Dry-run: show candidates and capture current titleblock (with OCR if available).
            if (!apply)
            {
                var capture = CaptureWithOcr(app, RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), expected: intended, includeOcrText: p.includeOcrText);
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    sheetNumber = sheet.SheetNumber,
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                    titleblockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                    hintedDriverParameter = hintedParam,
                    intendedValue = intended,
                    candidates = candidates.Select(c => new { source = c.Source, elementId = RevitBridge.Common.ElementIdCompat.GetValue(c.Element.Id), parameterName = c.ParamName }).ToList(),
                    capture
                });
            }

            // Apply mode requires typed confirmation because it may attempt multiple edits.
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            var requiredConfirm = $"APPLY SMART TITLEBLOCK DATE (UP TO {Math.Max(1, Math.Min(20, p.maxCandidates))} ATTEMPTS)";
            if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
            {
                throw new OperatorToolUserErrorException(
                    message: "Smart titleblock date apply requires typed confirmation.",
                    code: "bulk_confirm_required",
                    requiredConfirm: requiredConfirm,
                    confirmReceived: confirmReceived,
                    maxChangesPerCall: null,
                    hint: "Retry with confirm set to the requiredConfirm string (markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
            }

            // Baseline: ensure OCR is available before mutating. If OCR is unavailable, do not guess.
            var baseline = CaptureWithOcr(app, RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), expected: intended, includeOcrText: false);
            if (!TryGetOcrOk(baseline, out var ocrOk) || !ocrOk)
            {
                return Task.FromResult<object>(new
                {
                    status = "Not Applied",
                    dryRun = true,
                    error = "OCR is not available/configured; refusing to auto-apply candidate parameters without verification.",
                    requiredConfirm,
                    confirmReceived,
                    sheetNumber = sheet.SheetNumber,
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                    titleblockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                    hintedDriverParameter = hintedParam,
                    intendedValue = intended,
                    candidates = candidates.Select(c => new { source = c.Source, elementId = RevitBridge.Common.ElementIdCompat.GetValue(c.Element.Id), parameterName = c.ParamName }).ToList(),
                    baseline_capture = baseline
                });
            }

            var attempts = new List<object>();
            foreach (var cand in candidates)
            {
                var attemptId = $"{cand.Source}:{RevitBridge.Common.ElementIdCompat.GetValue(cand.Element.Id)}:{cand.ParamName}";
                var before = cand.BeforeValueString;
                var changed = false;
                string? message = null;

                // Set candidate value.
                using (var tx = new Transaction(doc, $"Operator Smart Titleblock Date ({cand.ParamName})"))
                {
                    tx.Start();
                    try
                    {
                        var pr = cand.Element.LookupParameter(cand.ParamName);
                        if (pr == null)
                        {
                            message = "Parameter not found on this element.";
                        }
                        else if (!ParameterValueUtil.TrySetFromString(pr, intended, out changed, out message))
                        {
                            // message already set
                        }
                    }
                    catch (Exception ex)
                    {
                        message = ex.Message;
                    }
                    tx.Commit();
                }

                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }

                var cap = CaptureWithOcr(app, RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), expected: intended, includeOcrText: p.includeOcrText);
                var matched = TryGetOcrMatchExpected(cap, out var okMatch) && okMatch;

                attempts.Add(new
                {
                    attemptId,
                    source = cand.Source,
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(cand.Element.Id),
                    parameterName = cand.ParamName,
                    beforeValueString = before,
                    intendedValue = intended,
                    changed,
                    message,
                    capture = cap,
                    matched
                });

                if (matched)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Applied + Verified",
                        dryRun = false,
                        sheetNumber = sheet.SheetNumber,
                        sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                        titleblockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                        applied = new { source = cand.Source, elementId = RevitBridge.Common.ElementIdCompat.GetValue(cand.Element.Id), parameterName = cand.ParamName },
                        requiredConfirm,
                        confirmReceived,
                        attempts
                    });
                }

                // Revert before trying next.
                try
                {
                    using (var tx = new Transaction(doc, $"Operator Revert Smart Titleblock Date ({cand.ParamName})"))
                    {
                        tx.Start();
                        var pr = cand.Element.LookupParameter(cand.ParamName);
                        if (pr != null)
                        {
                            bool _;
                            string? __;
                            ParameterValueUtil.TrySetFromString(pr, before, out _, out __);
                        }
                        tx.Commit();
                    }
                    try { doc.Regenerate(); } catch { }
                    try { uidoc.RefreshActiveView(); } catch { }
                }
                catch
                {
                    // best-effort revert
                }
            }

            return Task.FromResult<object>(new
            {
                status = "Applied (Unverified)",
                dryRun = false,
                warning = "Tried candidate parameters but OCR did not confirm the intended value. All attempted changes were reverted.",
                sheetNumber = sheet.SheetNumber,
                sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id),
                titleblockElementId = RevitBridge.Common.ElementIdCompat.GetValue(titleblock.Id),
                requiredConfirm,
                confirmReceived,
                attempts
            });
        }

        private static string? TryResolveHintedDriverParameter(UIApplication app, ViewSheet sheet, string labelText)
        {
            try
            {
                var mapReq = new TitleblockLabelMapHandler.Params { sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet.Id), includeParameters = false, includeHeuristics = false };
                var mapJson = JsonSerializer.Serialize(mapReq);
                var raw = new TitleblockLabelMapHandler().Handle(app, mapJson).GetAwaiter().GetResult();
                var sraw = JsonSerializer.Serialize(raw);
                using var jd = JsonDocument.Parse(sraw);
                if (!jd.RootElement.TryGetProperty("mappings", out var m) || m.ValueKind != JsonValueKind.Array) return null;
                foreach (var item in m.EnumerateArray())
                {
                    if (item.ValueKind != JsonValueKind.Object) continue;
                    var lt = item.TryGetProperty("label_text", out var lte) && lte.ValueKind == JsonValueKind.String ? (lte.GetString() ?? "") : "";
                    if (!string.Equals(lt.Trim(), labelText.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
                    var drv = item.TryGetProperty("driver_parameter", out var de) && de.ValueKind == JsonValueKind.String ? (de.GetString() ?? "") : "";
                    if (!string.IsNullOrWhiteSpace(drv)) return drv.Trim();
                }
            }
            catch
            {
                // ignore
            }
            return null;
        }

        private static List<Candidate> CollectCandidates(Document doc, ViewSheet sheet, FamilyInstance titleblock, FamilySymbol symbol, string? hintedParam, int max)
        {
            var outList = new List<Candidate>();

            static string? SnapshotValueString(Parameter pr)
            {
                if (pr == null) return null;
                try
                {
                    var vs = pr.AsValueString();
                    if (!string.IsNullOrWhiteSpace(vs)) return vs;
                }
                catch { }

                try
                {
                    switch (pr.StorageType)
                    {
                        case StorageType.String: return pr.AsString() ?? "";
                        case StorageType.Integer: return pr.AsInteger().ToString();
                        case StorageType.Double: return pr.AsDouble().ToString(System.Globalization.CultureInfo.InvariantCulture);
                        case StorageType.ElementId: return RevitBridge.Common.ElementIdCompat.GetValue(pr.AsElementId()).ToString();
                    }
                }
                catch { }
                return null;
            }

            void Add(string source, Element el, string paramName)
            {
                if (el == null) return;
                if (string.IsNullOrWhiteSpace(paramName)) return;
                try
                {
                    var pr = el.LookupParameter(paramName);
                    if (pr == null) return;
                    if (pr.IsReadOnly) return;
                    var before = SnapshotValueString(pr);
                    if (before == null) return; // refuse candidates we cannot safely revert
                    outList.Add(new Candidate { Source = source, Element = el, ParamName = paramName.Trim(), BeforeValueString = before });
                }
                catch { }
            }

            bool NameMatches(string name)
            {
                var n = (name ?? "").Trim();
                if (n.Length == 0) return false;
                var lower = n.ToLowerInvariant();
                return lower.Contains("date") || lower.Contains("issue") || lower.Contains("stamp") || lower.Contains("time");
            }

            void AddAllDateLike(string source, Element el)
            {
                try
                {
                    foreach (var pr in el.GetOrderedParameters())
                    {
                        if (pr == null) continue;
                        var nm = (pr.Definition?.Name ?? "").Trim();
                        if (!NameMatches(nm)) continue;
                        if (pr.IsReadOnly) continue;
                        Add(source, el, nm);
                    }
                }
                catch { }
            }

            // Hint first (if it exists on any source).
            if (!string.IsNullOrWhiteSpace(hintedParam))
            {
                Add("titleblock_instance", titleblock, hintedParam!);
                Add("titleblock_type", symbol, hintedParam!);
                Add("sheet", sheet, hintedParam!);
                Add("project_information", doc.ProjectInformation, hintedParam!);
            }

            AddAllDateLike("titleblock_instance", titleblock);
            AddAllDateLike("titleblock_type", symbol);
            AddAllDateLike("sheet", sheet);
            AddAllDateLike("project_information", doc.ProjectInformation);

            // Dedup by (elementId,param).
            var dedup = new List<Candidate>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var c in outList)
            {
                var k = $"{RevitBridge.Common.ElementIdCompat.GetValue(c.Element.Id)}:{c.ParamName}";
                if (seen.Contains(k)) continue;
                seen.Add(k);
                dedup.Add(c);
            }

            int Score(Candidate c)
            {
                var s = 0;
                var n = (c.ParamName ?? "").ToLowerInvariant();
                if (!string.IsNullOrWhiteSpace(hintedParam) && string.Equals(c.ParamName, hintedParam, StringComparison.OrdinalIgnoreCase)) s += 200;
                if (n.Contains("project issue")) s += 80;
                if (n.Contains("sheet issue")) s += 70;
                if (n.Contains("issue date")) s += 60;
                if (n.Contains("date stamp")) s += 55;
                if (n.Contains("timestamp")) s += 50;
                if (string.Equals(c.Source, "titleblock_instance", StringComparison.OrdinalIgnoreCase)) s += 30;
                if (string.Equals(c.Source, "sheet", StringComparison.OrdinalIgnoreCase)) s += 20;
                if (string.Equals(c.Source, "project_information", StringComparison.OrdinalIgnoreCase)) s += 10;
                return s;
            }

            var capped = dedup
                .OrderByDescending(Score)
                .ThenBy(c => c.ParamName)
                .Take(Math.Max(1, Math.Min(20, max)))
                .ToList();

            return capped;
        }

        private static object CaptureWithOcr(UIApplication app, long sheetViewId, string expected, bool includeOcrText)
        {
            try
            {
                var capReq = new CaptureSheetRegionHandler.Params
                {
                    sheetViewId = sheetViewId,
                    region = "titleblock",
                    marginFt = 0.15,
                    imageMaxSizePx = 2400,
                    includeMapping = true,
                    fileName = $"smart_verify_titleblock_{sheetViewId}",
                    includeOcr = true,
                    ocrKind = "date",
                    ocrExpected = expected,
                    ocrTimeoutMs = 20000
                };
                var capJson = JsonSerializer.Serialize(capReq);
                var raw = new CaptureSheetRegionHandler().Handle(app, capJson).GetAwaiter().GetResult();

                if (!includeOcrText)
                {
                    // Avoid bloating tool results: scrub large OCR text if present.
                    var sraw = JsonSerializer.Serialize(raw);
                    using var jd = JsonDocument.Parse(sraw);
                    if (jd.RootElement.TryGetProperty("ocr", out var ocr) && ocr.ValueKind == JsonValueKind.Object)
                    {
                        // Keep as-is; backend can choose not to display huge JSON.
                    }
                }

                return raw;
            }
            catch (Exception ex)
            {
                return new { ok = false, error = ex.Message };
            }
        }

        private static bool TryGetOcrOk(object captureObj, out bool ok)
        {
            ok = false;
            try
            {
                var json = JsonSerializer.Serialize(captureObj);
                using var jd = JsonDocument.Parse(json);
                if (!jd.RootElement.TryGetProperty("ocr", out var ocr) || ocr.ValueKind != JsonValueKind.Object) return false;
                if (!ocr.TryGetProperty("ok", out var oe) || (oe.ValueKind != JsonValueKind.True && oe.ValueKind != JsonValueKind.False)) return false;
                ok = oe.GetBoolean();
                return true;
            }
            catch { return false; }
        }

        private static bool TryGetOcrMatchExpected(object captureObj, out bool match)
        {
            match = false;
            try
            {
                var json = JsonSerializer.Serialize(captureObj);
                using var jd = JsonDocument.Parse(json);
                if (!jd.RootElement.TryGetProperty("ocr", out var ocr) || ocr.ValueKind != JsonValueKind.Object) return false;
                if (!ocr.TryGetProperty("match_expected", out var me) || (me.ValueKind != JsonValueKind.True && me.ValueKind != JsonValueKind.False)) return false;
                match = me.GetBoolean();
                return true;
            }
            catch { return false; }
        }
    }
}
