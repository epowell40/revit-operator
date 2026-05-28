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
    public sealed class TitleblockFamilyUpdateTextHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sheetNumber { get; set; }
            public long? sheetViewId { get; set; }
            public long? titleBlockElementId { get; set; }
            public long? titleBlockTypeId { get; set; }
            public string? familyName { get; set; }

            public string findText { get; set; } = "";
            public string replaceText { get; set; } = "";
            public string matchMode { get; set; } = "exact"; // exact | contains

            // Back-compat: legacy callers used {apply:false} for dry-run. Prefer {dryRun:true}.
            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public string? confirm { get; set; }

            public int maxEdits { get; set; } = 20;
        }

        private sealed class AlwaysOverwriteLoadOptions : IFamilyLoadOptions
        {
            public bool OnFamilyFound(bool familyInUse, out bool overwriteParameterValues)
            {
                overwriteParameterValues = true;
                return true;
            }

            public bool OnSharedFamilyFound(Family sharedFamily, bool familyInUse, out FamilySource source, out bool overwriteParameterValues)
            {
                source = FamilySource.Family;
                overwriteParameterValues = true;
                return true;
            }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrEmpty(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var find = (p.findText ?? "").Trim();
            if (string.IsNullOrWhiteSpace(find)) throw new InvalidOperationException("titleblock-family-update-text.findText is required.");
            var repl = NormalizeUserText(p.replaceText ?? "");

            var mode = (p.matchMode ?? "exact").Trim().ToLowerInvariant();
            if (mode != "exact" && mode != "contains" && mode != "normalized_exact" && mode != "normalized_contains")
                throw new InvalidOperationException("titleblock-family-update-text.matchMode must be 'exact', 'contains', 'normalized_exact', or 'normalized_contains'.");

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;

            var symbol = ResolveTitleblockType(doc, p, out var resolvedSheetNumber, out var resolvedSheetViewId);
            if (symbol == null) throw new InvalidOperationException("Could not resolve a titleblock type (provide sheetNumber/sheetViewId/titleBlockElementId/titleBlockTypeId/familyName).");

            Document? famDoc = null;
            try
            {
                famDoc = doc.EditFamily(symbol.Family);
                if (famDoc == null) throw new InvalidOperationException("Failed to open titleblock family document.");

                var findNorm = NormalizeForSearch(find);
                var matches = new List<TextNote>();
                foreach (var e in new FilteredElementCollector(famDoc).WhereElementIsNotElementType().ToElements())
                {
                    if (!(e is TextNote tn)) continue;
                    var t = (tn.Text ?? "");
                    if (mode == "exact")
                    {
                        if (string.Equals(t.Trim(), find, StringComparison.Ordinal)) matches.Add(tn);
                    }
                    else if (mode == "contains")
                    {
                        if (t.IndexOf(find, StringComparison.OrdinalIgnoreCase) >= 0) matches.Add(tn);
                    }
                    else if (mode == "normalized_exact")
                    {
                        if (string.Equals(NormalizeForSearch(t), findNorm, StringComparison.OrdinalIgnoreCase)) matches.Add(tn);
                    }
                    else // normalized_contains
                    {
                        var hay = NormalizeForSearch(t);
                        if (hay.IndexOf(findNorm, StringComparison.OrdinalIgnoreCase) >= 0) matches.Add(tn);
                    }
                }

                var max = Math.Max(0, Math.Min(200, p.maxEdits));
                if (matches.Count > max) matches = matches.Take(max).ToList();

                var changes = new List<object>();
                foreach (var tn in matches)
                {
                    var before = (tn.Text ?? "");
                    var after = mode == "exact" ? repl : ReplaceFirstInsensitive(before, find, repl);
                    changes.Add(new { elementId = RevitBridge.Common.ElementIdCompat.GetValue(tn.Id), before, after });
                }

                var requiredConfirm = (string?)null;
                var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
                if (apply && changes.Count > 0)
                {
                    requiredConfirm = $"APPLY {changes.Count} FAMILY TEXT CHANGES";
                    if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                    {
                        throw new OperatorToolUserErrorException(
                            message: "Family text edit requires typed confirmation.",
                            code: "bulk_confirm_required",
                            requiredConfirm: requiredConfirm,
                            confirmReceived: confirmReceived,
                            maxChangesPerCall: null,
                            hint: "Retry with confirm set to the requiredConfirm string (markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                    }
                }

                if (apply && changes.Count > 0)
                {
                    using (var tx = new Transaction(famDoc, "Operator Update Titleblock Text"))
                    {
                        tx.Start();
                        foreach (var tn in matches)
                        {
                            try
                            {
                                var before = tn.Text ?? "";
                                tn.Text = mode == "exact" ? repl : ReplaceFirstInsensitive(before, find, repl);
                            }
                            catch
                            {
                                // best effort
                            }
                        }
                        tx.Commit();
                    }

                    Family? loaded = null;
                    var ok = false;
                    try
                    {
                        loaded = famDoc.LoadFamily(doc, new AlwaysOverwriteLoadOptions());
                        ok = loaded != null;
                    }
                    catch
                    {
                        ok = false;
                    }

                    // Best-effort: ensure the target sheet is active so graphics update (helps reduce confusion after reload).
                    try
                    {
                        if (resolvedSheetViewId.HasValue && resolvedSheetViewId.Value != 0)
                        {
                            var v = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(resolvedSheetViewId.Value)) as View;
                            if (v != null && (uidoc.ActiveView == null || uidoc.ActiveView.Id != v.Id))
                                uidoc.ActiveView = v;
                        }
                    }
                    catch { }

                    try { doc.Regenerate(); } catch { }
                    try { uidoc.RefreshActiveView(); } catch { }

                    return Task.FromResult<object>(new
                    {
                        status = "Applied",
                        dryRun = false,
                        titleBlockTypeId = RevitBridge.Common.ElementIdCompat.GetValue(symbol.Id),
                        titleBlockTypeName = symbol.Name,
                        titleBlockFamilyName = symbol.FamilyName,
                        sheetNumber = resolvedSheetNumber,
                        sheetViewId = resolvedSheetViewId,
                        changedCount = changes.Count,
                        changes,
                        reload_ok = ok,
                        reloadedFamilyId = loaded != null ? RevitBridge.Common.ElementIdCompat.GetValue(loaded.Id) : (long?)null,
                        reloadedFamilyName = loaded != null ? loaded.Name : null,
                        requiredConfirm,
                        confirmReceived
                    });
                }

                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    titleBlockTypeId = RevitBridge.Common.ElementIdCompat.GetValue(symbol.Id),
                    titleBlockTypeName = symbol.Name,
                    titleBlockFamilyName = symbol.FamilyName,
                    sheetNumber = resolvedSheetNumber,
                    sheetViewId = resolvedSheetViewId,
                    matchCount = changes.Count,
                    changes,
                    requiredConfirm,
                    confirmReceived
                });
            }
            finally
            {
                try { famDoc?.Close(false); } catch { }
            }
        }

        private static string NormalizeForSearch(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var chars = s.Replace("\r\n", "\n").Replace('\r', '\n').ToCharArray();
            var outChars = new System.Text.StringBuilder(chars.Length);
            var inWs = false;
            foreach (var c in chars)
            {
                var keep = char.IsLetterOrDigit(c);
                if (!keep)
                {
                    if (!inWs)
                    {
                        outChars.Append(' ');
                        inWs = true;
                    }
                    continue;
                }

                inWs = false;
                outChars.Append(char.ToLowerInvariant(c));
            }
            return outChars.ToString().Trim();
        }

        private static string NormalizeUserText(string s)
        {
            // Allow callers to pass literal "\n" / "\r\n" in JSON/chat and have it become an actual line break.
            // (JSON strings already support "\n", but in practice some callers escape it twice.)
            var t = s ?? "";
            if (t.IndexOf("\\n", StringComparison.Ordinal) >= 0 || t.IndexOf("\\r", StringComparison.Ordinal) >= 0)
            {
                t = t.Replace("\\r\\n", "\n").Replace("\\n", "\n").Replace("\\r", "\n");
            }
            return t.Replace("\r\n", "\n").Replace('\r', '\n');
        }

        private static FamilySymbol? ResolveTitleblockType(Document doc, Params p, out string? sheetNumber, out long? sheetViewId)
        {
            sheetNumber = null;
            sheetViewId = null;

            try
            {
                if (p.titleBlockTypeId.HasValue && p.titleBlockTypeId.Value != 0)
                {
                    return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.titleBlockTypeId.Value)) as FamilySymbol;
                }
            }
            catch { }

            FamilyInstance? tb = null;
            ViewSheet? sheet = null;
            try
            {
                if (p.titleBlockElementId.HasValue && p.titleBlockElementId.Value != 0)
                {
                    tb = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.titleBlockElementId.Value)) as FamilyInstance;
                }
            }
            catch { tb = null; }

            if (tb == null)
            {
                try
                {
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

                    if (sheet != null)
                    {
                        tb = new FilteredElementCollector(doc, sheet.Id)
                            .OfCategory(BuiltInCategory.OST_TitleBlocks)
                            .WhereElementIsNotElementType()
                            .Cast<Element>()
                            .Select(e => e as FamilyInstance)
                            .FirstOrDefault(e => e != null);
                    }
                }
                catch { tb = null; }
            }

            if (tb != null)
            {
                try
                {
                    sheet = doc.GetElement(tb.OwnerViewId) as ViewSheet;
                    sheetNumber = sheet?.SheetNumber;
                    sheetViewId = RevitBridge.Common.ElementIdCompat.GetValue(sheet?.Id);
                }
                catch { }
                return tb.Symbol;
            }

            var famName = (p.familyName ?? "").Trim();
            if (!string.IsNullOrWhiteSpace(famName))
            {
                try
                {
                    var fam = new FilteredElementCollector(doc)
                        .OfClass(typeof(Family))
                        .Cast<Family>()
                        .FirstOrDefault(f => string.Equals((f.Name ?? "").Trim(), famName, StringComparison.OrdinalIgnoreCase));
                    if (fam != null)
                    {
                        var symId = fam.GetFamilySymbolIds().FirstOrDefault();
                        if (symId != null && symId != ElementId.InvalidElementId)
                        {
                            return doc.GetElement(symId) as FamilySymbol;
                        }
                    }
                }
                catch { }
            }

            return null;
        }

        private static string ReplaceFirstInsensitive(string src, string find, string repl)
        {
            if (string.IsNullOrEmpty(src)) return src ?? "";
            if (string.IsNullOrEmpty(find)) return src;
            var idx = src.IndexOf(find, StringComparison.OrdinalIgnoreCase);
            if (idx < 0) return src;
            return src.Substring(0, idx) + repl + src.Substring(idx + find.Length);
        }
    }
}
