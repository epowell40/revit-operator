using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using RevitBridge.Common;

[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("RevitBridge.Common.Tests")]

namespace RevitBridge.Logic.Handlers
{
    internal static class TransactionActionRunner
    {
        internal sealed class ActionOutcome
        {
            private readonly List<string> _errors = new List<string>();

            internal ActionOutcome(int index, string kind)
            {
                Index = index;
                Kind = kind;
            }

            internal int Index { get; }
            internal string Kind { get; }
            internal int AttemptedOperations { get; private set; }
            internal int SucceededOperations { get; private set; }
            internal IReadOnlyList<string> Errors => _errors;
            internal bool Success => _errors.Count == 0 && AttemptedOperations > 0 && SucceededOperations == AttemptedOperations;

            internal void Attempt() => AttemptedOperations++;
            internal void Succeed() => SucceededOperations++;

            internal void Fail(List<string> warnings, string message)
            {
                if (!_errors.Contains(message)) _errors.Add(message);
                if (!warnings.Contains(message)) warnings.Add(message);
            }

            internal object ToWireObject() => new
            {
                index = Index,
                kind = Kind,
                success = Success,
                attemptedOperations = AttemptedOperations,
                succeededOperations = SucceededOperations,
                failedOperations = Math.Max(0, AttemptedOperations - SucceededOperations),
                errors = _errors.ToArray()
            };
        }

        internal sealed class TransactionOperationReceipt
        {
            internal bool Attempted { get; set; }
            internal bool Succeeded { get; set; }
            internal bool Failed => !Succeeded && !VerifiedRolledBack && (Attempted || !string.IsNullOrWhiteSpace(Error));
            internal string Status { get; set; } = "NotAttempted";
            internal string? Error { get; set; }
            internal bool VerifiedRolledBack { get; set; }

            internal object ToWireObject() => new
            {
                attempted = Attempted,
                succeeded = Succeeded,
                failed = Failed,
                status = Status,
                error = Error,
                verifiedRolledBack = VerifiedRolledBack
            };
        }

        internal static string BuildFailureError(string primaryError, TransactionOperationReceipt rollbackReceipt)
        {
            if (!rollbackReceipt.Failed) return primaryError;
            var rollbackError = string.IsNullOrWhiteSpace(rollbackReceipt.Error)
                ? $"rollback ended with status '{rollbackReceipt.Status}'"
                : rollbackReceipt.Error;
            return $"{primaryError} Rollback failed: {rollbackError}";
        }

        internal sealed class Impact
        {
            internal HashSet<long> Added { get; } = new HashSet<long>();
            internal HashSet<long> Modified { get; } = new HashSet<long>();
            internal HashSet<long> Deleted { get; } = new HashSet<long>();

            internal List<object> ParameterDiffs { get; } = new List<object>();
            internal List<object> DeleteRequested { get; } = new List<object>();
            internal List<object> AddedInstances { get; } = new List<object>();

            internal object ToWireObject() => new
            {
                added = Added.OrderBy(x => x).ToList(),
                modified = Modified.OrderBy(x => x).ToList(),
                deleted = Deleted.OrderBy(x => x).ToList(),
                parameterDiffs = ParameterDiffs,
                deleteRequested = DeleteRequested,
                addedInstances = AddedInstances
            };
        }

        internal static void ExecuteActions(Document doc, IReadOnlyList<JsonElement> actions, Impact impact, List<string> warnings)
        {
            if (actions == null || actions.Count == 0)
            {
                warnings.Add("No actions provided.");
                return;
            }

            for (int i = 0; i < actions.Count; i++)
            {
                ExecuteAction(doc, actions[i], impact, warnings, i);
            }
        }

        internal static ActionOutcome ExecuteAction(Document doc, JsonElement action, Impact impact, List<string> warnings, int index)
        {
            var outcome = ValidateAction(action, warnings, index);
            if (outcome.Errors.Count > 0) return outcome;
            var kind = GetActionKind(action);

            switch (kind)
            {
                case "delete":
                    ExecuteDelete(doc, action, impact, warnings, outcome, index);
                    break;
                case "setParameters":
                    ExecuteSetParameters(doc, action, impact, warnings, outcome, index);
                    break;
                case "placeFamilies":
                    ExecutePlaceFamilies(doc, action, impact, warnings, outcome, index);
                    break;
                default:
                    outcome.Fail(warnings, $"Action[{index}] unknown kind '{kind}'.");
                    break;
            }

            return outcome;
        }

        internal static ActionOutcome ValidateAction(JsonElement action, List<string> warnings, int index)
        {
            var actionKind = GetActionKind(action);
            var outcome = new ActionOutcome(index, actionKind);

            if (action.ValueKind != JsonValueKind.Object)
            {
                outcome.Fail(warnings, $"Action[{index}] is not an object.");
                return outcome;
            }

            if (!action.TryGetProperty("kind", out var kindProp) || kindProp.ValueKind != JsonValueKind.String)
            {
                outcome.Fail(warnings, $"Action[{index}] missing 'kind'.");
                return outcome;
            }

            if (string.IsNullOrWhiteSpace(kindProp.GetString()))
            {
                outcome.Fail(warnings, $"Action[{index}] has empty 'kind'.");
                return outcome;
            }

            switch (actionKind)
            {
                case "delete":
                    ValidateRequiredNonEmptyArray(action, "ids", actionKind, warnings, outcome, index);
                    break;
                case "setParameters":
                    ValidateRequiredNonEmptyArray(action, "changes", actionKind, warnings, outcome, index);
                    break;
                case "placeFamilies":
                    ValidateRequiredString(action, "levelName", actionKind, warnings, outcome, index);
                    ValidateRequiredString(action, "symbolName", actionKind, warnings, outcome, index);
                    ValidateRequiredNonEmptyArray(action, "instances", actionKind, warnings, outcome, index);
                    break;
                default:
                    outcome.Fail(warnings, $"Action[{index}] unknown kind '{actionKind}'.");
                    break;
            }

            return outcome;
        }

        private static void ValidateRequiredNonEmptyArray(
            JsonElement action,
            string propertyName,
            string actionKind,
            List<string> warnings,
            ActionOutcome outcome,
            int index)
        {
            if (!action.TryGetProperty(propertyName, out var property) || property.ValueKind != JsonValueKind.Array)
            {
                outcome.Fail(warnings, $"Action[{index}] {actionKind} missing '{propertyName}' array.");
                return;
            }

            if (property.GetArrayLength() == 0)
                outcome.Fail(warnings, $"Action[{index}] {actionKind}: '{propertyName}' array is empty.");
        }

        private static void ValidateRequiredString(
            JsonElement action,
            string propertyName,
            string actionKind,
            List<string> warnings,
            ActionOutcome outcome,
            int index)
        {
            if (!action.TryGetProperty(propertyName, out var property) ||
                property.ValueKind != JsonValueKind.String ||
                string.IsNullOrWhiteSpace(property.GetString()))
            {
                outcome.Fail(warnings, $"Action[{index}] {actionKind} missing '{propertyName}'.");
            }
        }

        internal static string GetActionKind(JsonElement action)
        {
            if (action.ValueKind != JsonValueKind.Object) return "unknown";
            if (!action.TryGetProperty("kind", out var kindProp) || kindProp.ValueKind != JsonValueKind.String) return "unknown";
            var kind = kindProp.GetString();
            return string.IsNullOrWhiteSpace(kind) ? "unknown" : kind.Trim();
        }

        internal static HashSet<long> CollectWatchElementIds(IReadOnlyList<JsonElement>? actions, int maxIds = 400)
        {
            var results = new HashSet<long>();
            if (actions == null || actions.Count == 0) return results;
            for (int i = 0; i < actions.Count; i++)
            {
                if (results.Count >= maxIds) break;
                foreach (var id in CollectWatchElementIds(actions[i], maxIds - results.Count))
                    results.Add(id);
            }
            return results;
        }

        internal static HashSet<long> CollectWatchElementIds(JsonElement action, int maxIds = 400)
        {
            var results = new HashSet<long>();
            CollectWatchElementIdsRecursive(action, results, Math.Max(1, maxIds), depth: 0);
            return results;
        }

        private static void CollectWatchElementIdsRecursive(JsonElement node, HashSet<long> dest, int maxIds, int depth)
        {
            if (depth > 5 || dest.Count >= maxIds) return;

            if (node.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in node.EnumerateObject())
                {
                    if (dest.Count >= maxIds) break;
                    if (LooksLikeIdName(prop.Name) && TryReadLong(prop.Value, out var id) && id > 0)
                    {
                        dest.Add(id);
                        continue;
                    }

                    if (LooksLikeIdsName(prop.Name) && prop.Value.ValueKind == JsonValueKind.Array)
                    {
                        foreach (var item in prop.Value.EnumerateArray())
                        {
                            if (dest.Count >= maxIds) break;
                            if (TryReadLong(item, out var arrId) && arrId > 0) dest.Add(arrId);
                        }
                        continue;
                    }

                    if (prop.Value.ValueKind == JsonValueKind.Object || prop.Value.ValueKind == JsonValueKind.Array)
                        CollectWatchElementIdsRecursive(prop.Value, dest, maxIds, depth + 1);
                }
                return;
            }

            if (node.ValueKind == JsonValueKind.Array)
            {
                foreach (var item in node.EnumerateArray())
                {
                    if (dest.Count >= maxIds) break;
                    CollectWatchElementIdsRecursive(item, dest, maxIds, depth + 1);
                }
            }
        }

        private static bool LooksLikeIdName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            return name.Equals("id", StringComparison.OrdinalIgnoreCase) ||
                   name.EndsWith("Id", StringComparison.OrdinalIgnoreCase);
        }

        private static bool LooksLikeIdsName(string name)
        {
            if (string.IsNullOrWhiteSpace(name)) return false;
            return name.Equals("ids", StringComparison.OrdinalIgnoreCase) ||
                   name.EndsWith("Ids", StringComparison.OrdinalIgnoreCase);
        }

        private static bool TryReadLong(JsonElement node, out long value)
        {
            value = 0;
            if (node.ValueKind == JsonValueKind.Number) return node.TryGetInt64(out value);
            if (node.ValueKind != JsonValueKind.String) return false;
            var s = node.GetString();
            return long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out value) ||
                   long.TryParse(s, NumberStyles.Integer, CultureInfo.CurrentCulture, out value);
        }

        private static void ExecuteDelete(Document doc, JsonElement action, Impact impact, List<string> warnings, ActionOutcome outcome, int index)
        {
            if (!action.TryGetProperty("ids", out var idsProp) || idsProp.ValueKind != JsonValueKind.Array)
            {
                outcome.Fail(warnings, $"Action[{index}] delete missing 'ids' array.");
                return;
            }

            if (idsProp.GetArrayLength() == 0)
            {
                outcome.Fail(warnings, $"Action[{index}] delete: 'ids' array is empty.");
                return;
            }

            var ids = new List<ElementId>();
            foreach (var el in idsProp.EnumerateArray())
            {
                outcome.Attempt();
                if (el.ValueKind != JsonValueKind.Number || !el.TryGetInt64(out var id) || id <= 0)
                {
                    outcome.Fail(warnings, $"Action[{index}] delete: id must be a positive integer.");
                    continue;
                }

                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (elem == null)
                {
                    outcome.Fail(warnings, $"Action[{index}] delete: element {id} not found.");
                    continue;
                }

                impact.DeleteRequested.Add(new
                {
                    elementId = id,
                    uniqueId = elem.UniqueId,
                    category = elem.Category?.Name,
                    name = elem.Name,
                    typeId = RevitBridge.Common.ElementIdCompat.GetValue(elem.GetTypeId())
                });

                ids.Add(RevitBridge.Common.ElementIdCompat.Create(id));
            }

            if (ids.Count == 0)
            {
                outcome.Fail(warnings, $"Action[{index}] delete: no valid existing ids.");
                return;
            }

            ICollection<ElementId> deleted;
            try
            {
                deleted = doc.Delete(ids);
            }
            catch (Exception ex)
            {
                outcome.Fail(warnings, $"Action[{index}] delete failed: {ex.Message}");
                return;
            }

            var deletedIds = new HashSet<long>(deleted.Select(RevitBridge.Common.ElementIdCompat.GetValue));
            foreach (var did in deletedIds) impact.Deleted.Add(did);
            foreach (var requestedId in ids.Select(RevitBridge.Common.ElementIdCompat.GetValue))
            {
                if (deletedIds.Contains(requestedId))
                    outcome.Succeed();
                else
                    outcome.Fail(warnings, $"Action[{index}] delete: Revit did not report element {requestedId} as deleted.");
            }
        }

        private static void ExecuteSetParameters(Document doc, JsonElement action, Impact impact, List<string> warnings, ActionOutcome outcome, int index)
        {
            if (!action.TryGetProperty("changes", out var changesProp) || changesProp.ValueKind != JsonValueKind.Array)
            {
                outcome.Fail(warnings, $"Action[{index}] setParameters missing 'changes' array.");
                return;
            }

            if (changesProp.GetArrayLength() == 0)
            {
                outcome.Fail(warnings, $"Action[{index}] setParameters: 'changes' array is empty.");
                return;
            }

            foreach (var entry in changesProp.EnumerateArray())
            {
                outcome.Attempt();
                if (entry.ValueKind != JsonValueKind.Object)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: change must be an object.");
                    continue;
                }
                if (!entry.TryGetProperty("elementId", out var elementIdProp) || !elementIdProp.TryGetInt64(out var elementId))
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: missing 'elementId'.");
                    continue;
                }
                if (elementId <= 0)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: 'elementId' must be a positive integer.");
                    continue;
                }
                if (!entry.TryGetProperty("parameterName", out var parameterNameProp) || parameterNameProp.ValueKind != JsonValueKind.String)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: missing 'parameterName' for element {elementId}.");
                    continue;
                }
                if (!entry.TryGetProperty("value", out var valueProp) || valueProp.ValueKind != JsonValueKind.String)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: missing string 'value' for element {elementId}.");
                    continue;
                }

                var parameterName = parameterNameProp.GetString();
                var value = valueProp.GetString();

                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(elementId));
                if (elem == null)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: element {elementId} not found.");
                    continue;
                }

                if (string.IsNullOrWhiteSpace(parameterName))
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: empty parameterName for element {elementId}.");
                    continue;
                }

                var param = elem.LookupParameter(parameterName);
                if (param == null)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: parameter '{parameterName}' not found on element {elementId}.");
                    continue;
                }
                if (param.IsReadOnly)
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: parameter '{parameterName}' is read-only on element {elementId}.");
                    continue;
                }

                var before = ParameterValueUtil.SnapshotForWire(param);
                if (!ParameterValueUtil.TrySetFromString(param, value, out var changed, out var message))
                {
                    outcome.Fail(warnings, $"Action[{index}] setParameters: element {elementId} '{parameterName}': {message}");
                    impact.ParameterDiffs.Add(new
                    {
                        elementId,
                        parameterName,
                        ok = false,
                        changed = false,
                        error = message,
                        before,
                        after = before
                    });
                    continue;
                }

                var after = ParameterValueUtil.SnapshotForWire(param);
                impact.ParameterDiffs.Add(new
                {
                    elementId,
                    parameterName,
                    ok = true,
                    changed,
                    before,
                    after
                });

                if (changed) impact.Modified.Add(elementId);
                outcome.Succeed();
            }
        }

        private static void ExecutePlaceFamilies(Document doc, JsonElement action, Impact impact, List<string> warnings, ActionOutcome outcome, int index)
        {
            if (!action.TryGetProperty("levelName", out var levelNameProp) || levelNameProp.ValueKind != JsonValueKind.String)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies missing 'levelName'.");
                return;
            }
            if (!action.TryGetProperty("symbolName", out var symbolNameProp) || symbolNameProp.ValueKind != JsonValueKind.String)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies missing 'symbolName'.");
                return;
            }
            if (!action.TryGetProperty("instances", out var instancesProp) || instancesProp.ValueKind != JsonValueKind.Array)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies missing 'instances' array.");
                return;
            }
            if (instancesProp.GetArrayLength() == 0)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies: 'instances' array is empty.");
                return;
            }

            var levelName = levelNameProp.GetString();
            var symbolName = symbolNameProp.GetString();
            var familyName = action.TryGetProperty("familyName", out var familyNameProp) && familyNameProp.ValueKind == JsonValueKind.String
                ? familyNameProp.GetString()
                : null;

            Level? level = new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .FirstOrDefault(l => l.Name.Equals(levelName, StringComparison.OrdinalIgnoreCase));

            if (level == null)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies: level '{levelName}' not found.");
                return;
            }

            FamilySymbol? symbol = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(s =>
                    (string.IsNullOrEmpty(familyName) || s.FamilyName.Equals(familyName, StringComparison.OrdinalIgnoreCase)) &&
                    s.Name.Equals(symbolName, StringComparison.OrdinalIgnoreCase));

            if (symbol == null)
            {
                outcome.Fail(warnings, $"Action[{index}] placeFamilies: symbol '{symbolName}' not found.");
                return;
            }

            if (!symbol.IsActive)
            {
                try { symbol.Activate(); }
                catch (Exception ex)
                {
                    outcome.Fail(warnings, $"Action[{index}] placeFamilies: failed to activate symbol '{symbolName}': {ex.Message}");
                    return;
                }
            }

            foreach (var inst in instancesProp.EnumerateArray())
            {
                outcome.Attempt();
                var errorsBefore = outcome.Errors.Count;
                if (inst.ValueKind != JsonValueKind.Object)
                {
                    outcome.Fail(warnings, $"Action[{index}] placeFamilies: instance must be an object.");
                    continue;
                }
                if (!TryGetFiniteDouble(inst, "x", out var x) || !TryGetFiniteDouble(inst, "y", out var y) || !TryGetFiniteDouble(inst, "z", out var z))
                {
                    outcome.Fail(warnings, $"Action[{index}] placeFamilies: instance requires finite x/y/z values.");
                    continue;
                }

                var point = new XYZ(x, y, z);
                FamilyInstance? fi = null;
                try
                {
                    fi = doc.Create.NewFamilyInstance(point, symbol, level, StructuralType.NonStructural);
                }
                catch
                {
                    try { fi = doc.Create.NewFamilyInstance(point, symbol, StructuralType.NonStructural); }
                    catch (Exception ex)
                    {
                        outcome.Fail(warnings, $"Action[{index}] placeFamilies: failed to place instance at ({x},{y},{z}): {ex.Message}");
                        continue;
                    }
                }

                if (fi == null)
                {
                    outcome.Fail(warnings, $"Action[{index}] placeFamilies: Revit returned no instance at ({x},{y},{z}).");
                    continue;
                }

                if (inst.TryGetProperty("parameters", out var parametersProp))
                {
                    if (parametersProp.ValueKind != JsonValueKind.Object)
                    {
                        outcome.Fail(warnings, $"Action[{index}] placeFamilies: 'parameters' must be an object.");
                    }

                    if (parametersProp.ValueKind == JsonValueKind.Object)
                    {
                    foreach (var prop in parametersProp.EnumerateObject())
                    {
                        var param = fi.LookupParameter(prop.Name);
                        if (param == null)
                        {
                            outcome.Fail(warnings, $"Action[{index}] placeFamilies: parameter '{prop.Name}' not found on created element {RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)}.");
                            continue;
                        }
                        if (param.IsReadOnly)
                        {
                            outcome.Fail(warnings, $"Action[{index}] placeFamilies: parameter '{prop.Name}' is read-only on created element {RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)}.");
                            continue;
                        }

                        var v = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() : prop.Value.ToString();
                        if (!ParameterValueUtil.TrySetFromString(param, v, out _, out var parameterError))
                            outcome.Fail(warnings, $"Action[{index}] placeFamilies: element {RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)} '{prop.Name}': {parameterError}");
                    }
                    }
                }

                var autoParam = fi.LookupParameter("ROS_AutoGenerated");
                if (autoParam != null && !autoParam.IsReadOnly)
                {
                    if (!ParameterValueUtil.TrySetFromString(autoParam, "1", out _, out var autoError))
                        outcome.Fail(warnings, $"Action[{index}] placeFamilies: failed to set ROS_AutoGenerated on element {RevitBridge.Common.ElementIdCompat.GetValue(fi.Id)}: {autoError}");
                }

                impact.Added.Add(RevitBridge.Common.ElementIdCompat.GetValue(fi.Id));
                impact.AddedInstances.Add(new
                {
                    elementId = RevitBridge.Common.ElementIdCompat.GetValue(fi.Id),
                    familyName = fi.Symbol?.FamilyName,
                    symbolName = fi.Symbol?.Name,
                    levelId = RevitBridge.Common.ElementIdCompat.GetValue(level.Id),
                    x = point.X,
                    y = point.Y,
                    z = point.Z
                });
                if (outcome.Errors.Count == errorsBefore) outcome.Succeed();
            }
        }

        private static bool TryGetFiniteDouble(JsonElement obj, string prop, out double value)
        {
            if (!TryGetDouble(obj, prop, out value)) return false;
            return !double.IsNaN(value) && !double.IsInfinity(value);
        }

        private static bool TryGetDouble(JsonElement obj, string prop, out double value)
        {
            value = 0;
            if (!obj.TryGetProperty(prop, out var el)) return false;
            if (el.ValueKind == JsonValueKind.Number) return el.TryGetDouble(out value);
            if (el.ValueKind == JsonValueKind.String)
            {
                var s = el.GetString();
                return double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out value)
                    || double.TryParse(s, NumberStyles.Float, CultureInfo.CurrentCulture, out value);
            }
            return false;
        }

        // Note: parameter conversions handled via ParameterValueUtil.
    }
}
