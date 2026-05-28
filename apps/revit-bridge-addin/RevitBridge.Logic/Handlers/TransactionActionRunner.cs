using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Structure;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal static class TransactionActionRunner
    {
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

        internal static void ExecuteAction(Document doc, JsonElement action, Impact impact, List<string> warnings, int index)
        {
            if (action.ValueKind != JsonValueKind.Object)
            {
                warnings.Add($"Action[{index}] is not an object.");
                return;
            }

            if (!action.TryGetProperty("kind", out var kindProp) || kindProp.ValueKind != JsonValueKind.String)
            {
                warnings.Add($"Action[{index}] missing 'kind'.");
                return;
            }

            var kind = kindProp.GetString();
            if (string.IsNullOrWhiteSpace(kind))
            {
                warnings.Add($"Action[{index}] has empty 'kind'.");
                return;
            }

            switch (kind)
            {
                case "delete":
                    ExecuteDelete(doc, action, impact, warnings, index);
                    break;
                case "setParameters":
                    ExecuteSetParameters(doc, action, impact, warnings, index);
                    break;
                case "placeFamilies":
                    ExecutePlaceFamilies(doc, action, impact, warnings, index);
                    break;
                default:
                    warnings.Add($"Action[{index}] unknown kind '{kind}'.");
                    break;
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

        private static void ExecuteDelete(Document doc, JsonElement action, Impact impact, List<string> warnings, int index)
        {
            if (!action.TryGetProperty("ids", out var idsProp) || idsProp.ValueKind != JsonValueKind.Array)
            {
                warnings.Add($"Action[{index}] delete missing 'ids' array.");
                return;
            }

            var ids = new List<ElementId>();
            foreach (var el in idsProp.EnumerateArray())
            {
                if (el.ValueKind != JsonValueKind.Number) continue;
                if (!el.TryGetInt64(out var id)) continue;

                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (elem == null)
                {
                    warnings.Add($"Action[{index}] delete: element {id} not found.");
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
                warnings.Add($"Action[{index}] delete: no valid existing ids.");
                return;
            }

            ICollection<ElementId> deleted;
            try
            {
                deleted = doc.Delete(ids);
            }
            catch (Exception ex)
            {
                warnings.Add($"Action[{index}] delete failed: {ex.Message}");
                return;
            }

            foreach (var did in deleted) impact.Deleted.Add(RevitBridge.Common.ElementIdCompat.GetValue(did));
        }

        private static void ExecuteSetParameters(Document doc, JsonElement action, Impact impact, List<string> warnings, int index)
        {
            if (!action.TryGetProperty("changes", out var changesProp) || changesProp.ValueKind != JsonValueKind.Array)
            {
                warnings.Add($"Action[{index}] setParameters missing 'changes' array.");
                return;
            }

            foreach (var entry in changesProp.EnumerateArray())
            {
                if (entry.ValueKind != JsonValueKind.Object) continue;
                if (!entry.TryGetProperty("elementId", out var elementIdProp) || !elementIdProp.TryGetInt64(out var elementId))
                {
                    warnings.Add($"Action[{index}] setParameters: missing 'elementId'.");
                    continue;
                }
                if (!entry.TryGetProperty("parameterName", out var parameterNameProp) || parameterNameProp.ValueKind != JsonValueKind.String)
                {
                    warnings.Add($"Action[{index}] setParameters: missing 'parameterName' for element {elementId}.");
                    continue;
                }

                var parameterName = parameterNameProp.GetString();
                var value = entry.TryGetProperty("value", out var valueProp) && valueProp.ValueKind == JsonValueKind.String
                    ? valueProp.GetString()
                    : null;

                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(elementId));
                if (elem == null)
                {
                    warnings.Add($"Action[{index}] setParameters: element {elementId} not found.");
                    continue;
                }

                if (string.IsNullOrWhiteSpace(parameterName))
                {
                    warnings.Add($"Action[{index}] setParameters: empty parameterName for element {elementId}.");
                    continue;
                }

                var param = elem.LookupParameter(parameterName);
                if (param == null)
                {
                    warnings.Add($"Action[{index}] setParameters: parameter '{parameterName}' not found on element {elementId}.");
                    continue;
                }
                if (param.IsReadOnly)
                {
                    warnings.Add($"Action[{index}] setParameters: parameter '{parameterName}' is read-only on element {elementId}.");
                    continue;
                }

                var before = ParameterValueUtil.SnapshotForWire(param);
                if (!ParameterValueUtil.TrySetFromString(param, value, out var changed, out var message))
                {
                    warnings.Add($"Action[{index}] setParameters: element {elementId} '{parameterName}': {message}");
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
            }
        }

        private static void ExecutePlaceFamilies(Document doc, JsonElement action, Impact impact, List<string> warnings, int index)
        {
            if (!action.TryGetProperty("levelName", out var levelNameProp) || levelNameProp.ValueKind != JsonValueKind.String)
            {
                warnings.Add($"Action[{index}] placeFamilies missing 'levelName'.");
                return;
            }
            if (!action.TryGetProperty("symbolName", out var symbolNameProp) || symbolNameProp.ValueKind != JsonValueKind.String)
            {
                warnings.Add($"Action[{index}] placeFamilies missing 'symbolName'.");
                return;
            }
            if (!action.TryGetProperty("instances", out var instancesProp) || instancesProp.ValueKind != JsonValueKind.Array)
            {
                warnings.Add($"Action[{index}] placeFamilies missing 'instances' array.");
                return;
            }

            var levelName = levelNameProp.GetString();
            var symbolName = symbolNameProp.GetString();
            var familyName = action.TryGetProperty("familyName", out var familyNameProp) && familyNameProp.ValueKind == JsonValueKind.String
                ? familyNameProp.GetString()
                : null;

            Level level = new FilteredElementCollector(doc)
                .OfClass(typeof(Level))
                .Cast<Level>()
                .FirstOrDefault(l => l.Name.Equals(levelName, StringComparison.OrdinalIgnoreCase));

            if (level == null)
            {
                warnings.Add($"Action[{index}] placeFamilies: level '{levelName}' not found.");
                return;
            }

            FamilySymbol symbol = new FilteredElementCollector(doc)
                .OfClass(typeof(FamilySymbol))
                .Cast<FamilySymbol>()
                .FirstOrDefault(s =>
                    (string.IsNullOrEmpty(familyName) || s.FamilyName.Equals(familyName, StringComparison.OrdinalIgnoreCase)) &&
                    s.Name.Equals(symbolName, StringComparison.OrdinalIgnoreCase));

            if (symbol == null)
            {
                warnings.Add($"Action[{index}] placeFamilies: symbol '{symbolName}' not found.");
                return;
            }

            if (!symbol.IsActive)
            {
                try { symbol.Activate(); }
                catch (Exception ex) { warnings.Add($"Action[{index}] placeFamilies: failed to activate symbol '{symbolName}': {ex.Message}"); }
            }

            foreach (var inst in instancesProp.EnumerateArray())
            {
                if (inst.ValueKind != JsonValueKind.Object) continue;
                if (!TryGetDouble(inst, "x", out var x) || !TryGetDouble(inst, "y", out var y) || !TryGetDouble(inst, "z", out var z))
                {
                    warnings.Add($"Action[{index}] placeFamilies: instance missing x/y/z.");
                    continue;
                }

                var point = new XYZ(x, y, z);
                FamilyInstance fi = null;
                try
                {
                    fi = doc.Create.NewFamilyInstance(point, symbol, level, StructuralType.NonStructural);
                }
                catch
                {
                    try { fi = doc.Create.NewFamilyInstance(point, symbol, StructuralType.NonStructural); }
                    catch (Exception ex)
                    {
                        warnings.Add($"Action[{index}] placeFamilies: failed to place instance at ({x},{y},{z}): {ex.Message}");
                        continue;
                    }
                }

                if (fi == null) continue;

                if (inst.TryGetProperty("parameters", out var parametersProp) && parametersProp.ValueKind == JsonValueKind.Object)
                {
                    foreach (var prop in parametersProp.EnumerateObject())
                    {
                        var param = fi.LookupParameter(prop.Name);
                        if (param == null || param.IsReadOnly) continue;

                        var v = prop.Value.ValueKind == JsonValueKind.String ? prop.Value.GetString() : prop.Value.ToString();
                        ParameterValueUtil.TrySetFromString(param, v, out _, out _);
                    }
                }

                var autoParam = fi.LookupParameter("ROS_AutoGenerated");
                if (autoParam != null && !autoParam.IsReadOnly)
                {
                    ParameterValueUtil.TrySetFromString(autoParam, "1", out _, out _);
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
            }
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
