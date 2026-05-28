using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Logic.Handlers.Core;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class DuplicateTypeAndSwapInstanceHandler : IRequestHandler
    {
        public sealed class Change
        {
            public string parameterName { get; set; } = "";
            public string value { get; set; } = "";
        }

        public sealed class Params
        {
            public long instanceId { get; set; }
            public string newTypeName { get; set; } = "";
            public List<Change>? typeParamChanges { get; set; }
            public bool dryRun { get; set; } = true;
            public string? confirm { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            if (p.instanceId <= 0) throw new ArgumentException("instanceId is required.");
            var newName = (p.newTypeName ?? "").Trim();
            if (newName.Length == 0) throw new ArgumentException("newTypeName is required.");

            var changes = (p.typeParamChanges ?? new List<Change>())
                .Where(x => x != null && !string.IsNullOrWhiteSpace(x.parameterName))
                .Select(x => new Change { parameterName = x.parameterName.Trim(), value = x.value ?? "" })
                .ToList();

            const int ConfirmThreshold = 10;
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;
            if (!p.dryRun && changes.Count > ConfirmThreshold)
            {
                requiredConfirm = BulkConfirmUtil.ExpectedApplyChanges(changes.Count);
                if (!BulkConfirmUtil.EqualsNormalized(p.confirm, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk type parameter edit requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: 10,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok).");
                }
            }

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var inst = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.instanceId));
            if (inst == null) throw new InvalidOperationException($"Element {p.instanceId} not found.");

            var type = doc.GetElement(inst.GetTypeId()) as ElementType;
            if (type == null) throw new InvalidOperationException($"Element {p.instanceId} does not have a valid ElementType.");

            ElementType? created = null;
            var typeDiffs = new List<object>();
            long? swappedToTypeId = null;
            var missingAfter = new List<long>();

            using (var t = new Transaction(doc, "Duplicate Type and Swap Instance"))
            {
                t.Start();
                WarningSuppressionUtil.SuppressWarnings(t);

                created = type.Duplicate(newName) as ElementType;
                if (created == null) throw new InvalidOperationException("Duplicate did not return an ElementType.");

                foreach (var ch in changes)
                {
                    var param = created.LookupParameter(ch.parameterName);
                    if (param == null)
                    {
                        typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = false, changed = false, error = "Parameter not found on type." });
                        continue;
                    }

                    var before = ParameterValueUtil.SnapshotForWire(param);
                    var normalized = NormalizeInputForParam(doc, param, ch.value);
                    if (!ParameterValueUtil.TrySetFromString(param, normalized, out var didChange, out var message))
                    {
                        typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = false, changed = false, error = message, before, after = before });
                        continue;
                    }

                    var after = ParameterValueUtil.SnapshotForWire(param);
                    typeDiffs.Add(new { typeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id), parameterName = ch.parameterName, ok = true, changed = didChange, before, after });
                }

                try
                {
                    inst.ChangeTypeId(created.Id);
                    swappedToTypeId = RevitBridge.Common.ElementIdCompat.GetValue(created.Id);
                }
                catch (Exception ex)
                {
                    throw new InvalidOperationException($"Failed to swap instance {p.instanceId} to new type: {ex.Message}");
                }

                if (p.dryRun) t.RollBack();
                else t.Commit();
            }

            if (!p.dryRun)
            {
                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }

                if (doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.instanceId)) == null)
                {
                    missingAfter.Add(p.instanceId);
                }
            }

            return Task.FromResult<object>(new
            {
                status = p.dryRun ? "Dry Run" : "Applied",
                dryRun = p.dryRun,
                instanceId = p.instanceId,
                sourceTypeId = RevitBridge.Common.ElementIdCompat.GetValue(type.Id),
                sourceTypeName = type.Name,
                newTypeName = newName,
                newTypeId = p.dryRun ? (long?)null : RevitBridge.Common.ElementIdCompat.GetValue(created?.Id),
                swappedToTypeId,
                requestedTypeParamChanges = changes.Count,
                typeParamDiffs = typeDiffs,
                missingAfterElementIds = missingAfter,
                requiredConfirm,
                confirmReceived
            });
        }

        private static string NormalizeInputForParam(Document doc, Parameter param, string raw)
        {
            if (param == null || param.StorageType != StorageType.Double) return raw ?? "";
            if (LengthTextUtil.TryParseLengthToFeet(doc, raw, out var ft, out _))
                return ft.ToString("G17", System.Globalization.CultureInfo.InvariantCulture);
            return raw ?? "";
        }
    }
}
