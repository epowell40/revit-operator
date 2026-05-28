using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class FindElementsByParameterHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? category { get; set; }
            public List<string>? categories { get; set; }

            public string? parameterName { get; set; }
            // Compatibility aliases.
            public string? parameter { get; set; }
            public string? paramName { get; set; }
            public string op { get; set; } = "equals"; // equals | contains
            public string? value { get; set; }

            public string? systemName { get; set; }
            public long? viewId { get; set; }
            public int? limit { get; set; } = 2000;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var paramName = ResolveParameterName(p);
            if (paramName.Length == 0) throw new ArgumentException("parameterName is required (aliases accepted: parameter, paramName).");

            var op = NormalizeOperator(p.op);

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var cats = new List<string>();
            if (!string.IsNullOrWhiteSpace(p.category)) cats.Add(p.category!.Trim());
            if (p.categories != null) cats.AddRange(p.categories.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));

            var bicList = new List<BuiltInCategory>();
            var unknownCats = new List<string>();
            BuiltInCategoryTokenUtil.ParseMany(cats, bicList, unknownCats);

            var collector = p.viewId.HasValue && p.viewId.Value > 0
                ? new FilteredElementCollector(doc, RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)).WhereElementIsNotElementType()
                : new FilteredElementCollector(doc).WhereElementIsNotElementType();

            if (bicList.Count == 1) collector.OfCategory(bicList[0]);
            else if (bicList.Count > 1) collector.WherePasses(new ElementMulticategoryFilter(bicList));

            var sysFilter = (p.systemName ?? "").Trim();
            var limit = p.limit.HasValue && p.limit.Value > 0 ? Math.Min(p.limit.Value, 20000) : 2000;

            var rows = new List<object>();
            var scanned = 0;
            foreach (var e in collector)
            {
                if (e == null) continue;
                scanned++;
                if (scanned > 500000) break;

                if (sysFilter.Length > 0)
                {
                    var sysName = MepSystemUtil.TryGetSystemName(e) ?? "";
                    if (!sysName.Equals(sysFilter, StringComparison.OrdinalIgnoreCase)) continue;
                }

                var param = e.LookupParameter(paramName);
                if (param == null) continue;

                if (!ParamMatches(doc, param, op, p.value ?? "", out var actualValue)) continue;

                var catToken = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? "None");
                rows.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    category = catToken,
                    name = e.Name,
                    systemName = MepSystemUtil.TryGetSystemName(e),
                    parameterName = paramName,
                    value = actualValue
                });

                if (rows.Count >= limit) break;
            }

            var warnings = new List<string>();
            if (unknownCats.Count > 0) warnings.Add($"Unknown categories ignored: {string.Join(", ", unknownCats)}");
            if (rows.Count >= limit) warnings.Add($"Result limit reached ({limit}).");

            return Task.FromResult<object>(new
            {
                status = "Ok",
                parameterName = paramName,
                op,
                expectedValue = p.value,
                systemName = sysFilter.Length > 0 ? sysFilter : null,
                viewId = p.viewId,
                categories = bicList.Select(x => x.ToString()).Distinct().ToList(),
                count = rows.Count,
                limit,
                elements = rows,
                warnings
            });
        }

        private static bool ParamMatches(Document doc, Parameter param, string op, string expected, out object actualSnapshot)
        {
            actualSnapshot = ParameterValueUtil.SnapshotForWire(param);

            var expRaw = (expected ?? "").Trim();
            if (op.Equals("contains", StringComparison.OrdinalIgnoreCase))
            {
                var s = (param.AsString() ?? param.AsValueString() ?? "").Trim();
                return s.IndexOf(expRaw, StringComparison.OrdinalIgnoreCase) >= 0;
            }

            // equals
            try
            {
                switch (param.StorageType)
                {
                    case StorageType.String:
                        return string.Equals((param.AsString() ?? "").Trim(), expRaw, StringComparison.OrdinalIgnoreCase);
                    case StorageType.Integer:
                        if (int.TryParse(expRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ei) ||
                            int.TryParse(expRaw, NumberStyles.Integer, CultureInfo.CurrentCulture, out ei))
                        {
                            return param.AsInteger() == ei;
                        }
                        return string.Equals((param.AsValueString() ?? "").Trim(), expRaw, StringComparison.OrdinalIgnoreCase);
                    case StorageType.Double:
                        if (TryParseDoubleWithUnits(doc, param, expRaw, out var expD))
                        {
                            var act = param.AsDouble();
                            return Math.Abs(act - expD) <= 1e-6;
                        }
                        return string.Equals((param.AsValueString() ?? "").Trim(), expRaw, StringComparison.OrdinalIgnoreCase);
                    case StorageType.ElementId:
                        if (long.TryParse(expRaw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var lid) ||
                            long.TryParse(expRaw, NumberStyles.Integer, CultureInfo.CurrentCulture, out lid))
                        {
                            return RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()) == lid;
                        }
                        return string.Equals((param.AsValueString() ?? "").Trim(), expRaw, StringComparison.OrdinalIgnoreCase);
                    case StorageType.None:
                    default:
                        return string.Equals((param.AsValueString() ?? "").Trim(), expRaw, StringComparison.OrdinalIgnoreCase);
                }
            }
            catch
            {
                return false;
            }
        }

        private static string ResolveParameterName(Params p)
        {
            var candidates = new[]
            {
                p.parameterName,
                p.parameter,
                p.paramName
            };

            foreach (var raw in candidates)
            {
                var name = (raw ?? "").Trim();
                if (name.Length > 0) return name;
            }

            return "";
        }

        private static string NormalizeOperator(string? raw)
        {
            var value = (raw ?? "").Trim().ToLowerInvariant();
            if (value.Length == 0) return "equals";
            return value switch
            {
                "equals" or "equal" or "eq" or "==" or "=" or "is" or "exact" => "equals",
                "contains" or "contain" or "has" or "include" or "includes" or "like" => "contains",
                _ => throw new ArgumentException("op must be 'equals' or 'contains' (aliases like 'eq' and 'has' are accepted).")
            };
        }

        private static bool TryParseDoubleWithUnits(Document doc, Parameter param, string raw, out double valueInternal)
        {
            valueInternal = 0.0;
            if (doc == null || param == null) return false;
            if (string.IsNullOrWhiteSpace(raw)) return false;

            // Fast path: pure numeric is assumed already internal (feet for length-like), which is uncommon for users.
            if (double.TryParse(raw, NumberStyles.Float, CultureInfo.InvariantCulture, out valueInternal) ||
                double.TryParse(raw, NumberStyles.Float, CultureInfo.CurrentCulture, out valueInternal))
            {
                return true;
            }

            try
            {
                var units = doc.GetUnits();
                ForgeTypeId? spec = null;
                try
                {
                    // Newer API: spec data type on parameter definition.
                    spec = param.Definition?.GetDataType();
                }
                catch { spec = null; }

                if (spec != null)
                {
                    if (UnitFormatUtils.TryParse(units, spec, raw, out var parsed))
                    {
                        valueInternal = parsed;
                        return true;
                    }
                }

                // Fallback to generic parsing.
                if (UnitFormatUtils.TryParse(units, UnitTypeId.Feet, raw, out var parsed2))
                {
                    valueInternal = parsed2;
                    return true;
                }
            }
            catch
            {
                // ignore
            }

            return false;
        }
    }
}

