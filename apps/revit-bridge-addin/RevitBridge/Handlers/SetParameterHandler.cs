using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    public class SetParameterHandler : IRequestHandler
    {
        public class SetParamEntry
        {
            public long elementId { get; set; }
            public string parameterName { get; set; }
            public string value { get; set; }
            public bool? preserveTextCase { get; set; }
        }

        public class Params
        {
            public List<SetParamEntry>? changes { get; set; }

            // Back-compat: legacy callers used {apply:false} for dry-run. Prefer {dryRun:true}.
            public bool? apply { get; set; }
            public bool? dryRun { get; set; }

            // Optional bulk safety: when changing many elements, require a typed confirmation phrase.
            // Recommended phrase: "APPLY {count} CHANGES"
            public string? confirm { get; set; }

            // Optional UX helper: allow excluding some elements from the changes list.
            public List<long>? excludeElementIds { get; set; }

            // Default false. Use true for exact-value restoration paths where the caller
            // already verified the original mixed-case value and must preserve it.
            public bool? preserveTextCase { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var doc = app.ActiveUIDocument.Document;

            var changes = (p.changes ?? new List<SetParamEntry>()).Where(x =>
                x != null &&
                x.elementId > 0 &&
                !string.IsNullOrWhiteSpace(x.parameterName)).ToList();

            if (changes.Count == 0) throw new InvalidOperationException("set-parameter.changes is required and must be a non-empty array.");

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;

            const int ConfirmThreshold = 25;
            var requestedCount = changes.Count;
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;
            if (apply && changes.Count > ConfirmThreshold)
            {
                requiredConfirm = BulkConfirmUtil.ExpectedApplyChanges(requestedCount);
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk parameter edit requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: 10,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                }
            }

            var exclude = new HashSet<long>((p.excludeElementIds ?? new List<long>()).Where(x => x > 0));
            var excludedCount = exclude.Count;
            var effectiveChanges = excludedCount > 0 ? changes.Where(x => !exclude.Contains(x.elementId)).ToList() : changes;
            var effectiveCount = effectiveChanges.Count;

            var diffs = new List<object>(capacity: Math.Min(2048, changes.Count));
            var changedCount = 0;
            var changedElementIds = new HashSet<long>();
            var titleblockHits = new Dictionary<long, HashSet<string>>();

            using (Transaction trans = new Transaction(doc, "Set Parameters"))
            {
                trans.Start();
                foreach (var entry in effectiveChanges)
                {
                    var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(entry.elementId));
                    if (elem == null)
                    {
                        diffs.Add(new
                        {
                            elementId = entry.elementId,
                            parameterName = entry.parameterName,
                            ok = false,
                            changed = false,
                            error = "Element not found."
                        });
                        continue;
                    }

                    var param = elem.LookupParameter(entry.parameterName);
                    if (param == null)
                    {
                        diffs.Add(new
                        {
                            elementId = entry.elementId,
                            parameterName = entry.parameterName,
                            ok = false,
                            changed = false,
                            error = $"Parameter '{entry.parameterName}' not found on element."
                        });
                        continue;
                    }

                    var before = ParameterValueUtil.SnapshotForWire(param);
                    var preserveTextCase = entry.preserveTextCase ?? p.preserveTextCase ?? false;
                    var requestedValue = preserveTextCase
                        ? (entry.value ?? "")
                        : RevitTextCasePolicy.NormalizeParameterValue(elem, param, entry.parameterName, entry.value);
                    if (!ParameterValueUtil.TrySetFromString(param, requestedValue, out var didChange, out var message))
                    {
                        diffs.Add(new
                        {
                            elementId = entry.elementId,
                            parameterName = entry.parameterName,
                            ok = false,
                            changed = false,
                            error = message,
                            before,
                            after = before
                        });
                        continue;
                    }

                    var after = ParameterValueUtil.SnapshotForWire(param);
                    if (didChange) changedCount++;
                    if (didChange) changedElementIds.Add(entry.elementId);
                    diffs.Add(new
                    {
                        elementId = entry.elementId,
                        parameterName = entry.parameterName,
                        ok = true,
                        changed = didChange,
                        before,
                        after
                    });

                    if (didChange)
                    {
                        try
                        {
                            var catId = RevitBridge.Common.ElementIdCompat.GetValue(elem.Category?.Id);
                            if (catId == (int)BuiltInCategory.OST_TitleBlocks)
                            {
                                if (!titleblockHits.TryGetValue(entry.elementId, out var set))
                                {
                                    set = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                                    titleblockHits[entry.elementId] = set;
                                }
                                set.Add(entry.parameterName);
                            }
                        }
                        catch
                        {
                            // best effort
                        }
                    }
                }

                if (apply) trans.Commit();
                else trans.RollBack();
            }

            if (apply && changedCount > 0)
            {
                try { doc.Regenerate(); } catch { }
                try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }
            }

            List<long>? missingAfterElementIds = null;
            if (apply && changedElementIds.Count > 0)
            {
                try
                {
                    missingAfterElementIds = changedElementIds
                        .Where(id => doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id)) == null)
                        .OrderBy(x => x)
                        .ToList();
                }
                catch
                {
                    missingAfterElementIds = null;
                }
            }

            List<object>? titleblockImpacts = null;
            try
            {
                if (titleblockHits.Count > 0)
                {
                    titleblockImpacts = new List<object>();
                    foreach (var kv in titleblockHits)
                    {
                        var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(kv.Key));
                        var ownerViewId = el?.OwnerViewId ?? ElementId.InvalidElementId;
                        var sheet = ownerViewId != ElementId.InvalidElementId ? (doc.GetElement(ownerViewId) as ViewSheet) : null;
                        titleblockImpacts.Add(new
                        {
                            titleblockElementId = kv.Key,
                            sheetViewId = ownerViewId != null && ownerViewId != ElementId.InvalidElementId ? RevitBridge.Common.ElementIdCompat.GetValue(ownerViewId) : (long?)null,
                            sheetNumber = sheet?.SheetNumber,
                            parameters = kv.Value.OrderBy(x => x).ToList()
                        });
                    }
                }
            }
            catch
            {
                titleblockImpacts = null;
            }

            return Task.FromResult<object>(new
            {
                status = apply ? "Applied" : "Dry Run",
                dryRun = !apply,
                requestedCount,
                effectiveCount,
                excludedCount,
                changedCount,
                changedElementIds = changedElementIds.OrderBy(x => x).ToList(),
                missingAfterElementIds,
                diffs,
                requiredConfirm,
                confirmReceived,
                titleblockImpacts
            });
        }
    }
}
