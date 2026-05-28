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
    public class QuantifyElementsHandler : IRequestHandler
    {
        public class QuantifyRequest
        {
            public string intent { get; set; } // "count", "list", "count_and_list"
            public string scope { get; set; } // "host" | "links" | "both"
            public List<string> categories { get; set; } // e.g., "OST_PlumbingFixtures"
            public FilterOptions filters { get; set; }
            public List<string> group_by { get; set; } // "Level", "Room", "Type"
            public bool room_resolution { get; set; }
        }

        public class FilterOptions
        {
            public string level { get; set; } // Level Name
            public List<string> keywords_include { get; set; }
            public List<string> keywords_exclude { get; set; }
            public List<ParamFilter> parameters { get; set; }
        }

        public class ParamFilter
        {
            public string param { get; set; }
            public string value { get; set; }
            public string op { get; set; } // "contains", "equals", "startwith"
        }

        public class QuantifyResponse
        {
            public QuantifySummary summary { get; set; } = new QuantifySummary();
            public List<QuantifyRow> rows { get; set; } = new List<QuantifyRow>();
            public string resultSetId { get; set; }
            public List<string> warnings { get; set; } = new List<string>();
        }

        public class QuantifySummary
        {
            public int total { get; set; }
            public Dictionary<string, int> groups { get; set; } = new Dictionary<string, int>();
        }

        public class QuantifyRow
        {
            public long id { get; set; }
            public string source { get; set; } // "host" | "link"
            public long? linkInstanceId { get; set; }
            public string linkName { get; set; }
            public string category { get; set; }
            public string type { get; set; }
            public string name { get; set; } // Instance name or Mark
            public string level { get; set; }
            public string room { get; set; }
            public string room_status { get; set; } // "resolved" | "unresolved:<reason>"
            public Dictionary<string, string> parameters { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var uidoc = app.ActiveUIDocument;
            var doc = uidoc.Document;
            var request = JsonSerializer.Deserialize<QuantifyRequest>(jsonData) ?? new QuantifyRequest();
            var response = new QuantifyResponse();

            var scope = (request.scope ?? "host").Trim().ToLowerInvariant();
            if (scope != "host" && scope != "links" && scope != "both") scope = "host";
            var includeHost = scope != "links";
            var includeLinks = scope == "links" || scope == "both";

            var includeKeywords = NormalizeKeywords(request.filters?.keywords_include);
            var excludeKeywords = NormalizeKeywords(request.filters?.keywords_exclude);
            var paramFilters = NormalizeParamFilters(request.filters?.parameters);

            // 1) Resolve categories
            var categories = new List<BuiltInCategory>();
            if (request.categories != null && request.categories.Any())
            {
                foreach (var catName in request.categories)
                {
                    if (Enum.TryParse<BuiltInCategory>(catName, out var bic))
                        categories.Add(bic);
                }
            }

            ElementFilter catFilter = null;
            if (categories.Count == 1)
                catFilter = new ElementCategoryFilter(categories[0]);
            else if (categories.Count > 1)
                catFilter = new LogicalOrFilter(categories.Select(c => new ElementCategoryFilter(c)).Cast<ElementFilter>().ToList());

            // 2) Collect + filter across host and (optionally) links
            var hostIdsForResultSet = new List<long>();
            var allRows = new List<QuantifyRow>();
            var roomUnresolvedCounts = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);

            if (includeHost)
            {
                CollectForDoc(doc, "host", null, null, catFilter, request, includeKeywords, excludeKeywords, paramFilters, hostIdsForResultSet, allRows, roomUnresolvedCounts);
            }

            var linkedCount = 0;
            if (includeLinks)
            {
                var links = new FilteredElementCollector(doc)
                    .OfClass(typeof(RevitLinkInstance))
                    .Cast<RevitLinkInstance>()
                    .ToList();

                foreach (var li in links)
                {
                    Document linkDoc = null;
                    try { linkDoc = li.GetLinkDocument(); } catch { linkDoc = null; }
                    if (linkDoc == null)
                    {
                        response.warnings.Add($"Link '{li.Name}' is unloaded or not accessible.");
                        continue;
                    }

                    linkedCount++;
                    CollectForDoc(linkDoc, "link", RevitBridge.Common.ElementIdCompat.GetValue(li.Id), li.Name, catFilter, request, includeKeywords, excludeKeywords, paramFilters, hostIdsForResultSet: null, allRows, roomUnresolvedCounts);
                }
            }

            response.summary.total = allRows.Count;

            // 3) Build groups (supports multi-key group_by; default Type)
            var groupKeys = (request.group_by ?? new List<string>()).Where(x => !string.IsNullOrWhiteSpace(x)).ToList();
            if (groupKeys.Count == 0) groupKeys.Add("Type");
            if (groupKeys.Count > 3) groupKeys = groupKeys.Take(3).ToList();

            foreach (var r in allRows)
            {
                var gk = BuildGroupKey(r, groupKeys);
                if (string.IsNullOrWhiteSpace(gk)) gk = "Unknown";
                if (!response.summary.groups.ContainsKey(gk)) response.summary.groups[gk] = 0;
                response.summary.groups[gk]++;
            }

            // 4) Warnings (room unresolved summary)
            if (request.room_resolution && roomUnresolvedCounts.Count > 0)
            {
                var top = roomUnresolvedCounts
                    .OrderByDescending(kv => kv.Value)
                    .Take(6)
                    .Select(kv => $"{kv.Key}:{kv.Value}")
                    .ToList();
                response.warnings.Add($"Room resolution unresolved ({string.Join(", ", top)})");
            }

            if (includeLinks && linkedCount == 0)
            {
                response.warnings.Add("No linked models found.");
            }

            // 5) Persist result set for follow-ups (host-only visualization)
            response.resultSetId = QuantifyResultSetStore.Put(hostIdsForResultSet);
            if (hostIdsForResultSet.Count == 0 && includeHost)
            {
                // No host elements matched; links may still have rows.
                response.warnings.Add("No host elements in result set (linked elements cannot be visualized in host views).");
            }

            // 6) Rows (honor intent)
            var intent = (request.intent ?? "").Trim();
            if (intent.Equals("count", StringComparison.OrdinalIgnoreCase))
            {
                response.rows.Clear();
            }
            else
            {
                response.rows = allRows;
            }

            return Task.FromResult<object>(response);
        }

        private string GetLevelName(Document doc, Element e)
        {
            if (e.LevelId != ElementId.InvalidElementId)
            {
                var l = doc.GetElement(e.LevelId) as Level;
                return l?.Name;
            }
            return null;
        }

        private string ResolveRoom(Document doc, Element e, out string roomStatus)
        {
            roomStatus = "unresolved";

            // 1. Try FamilyInstance.Room property
            if (e is FamilyInstance fi)
            {
                if (fi.Room != null) { roomStatus = "resolved"; return $"{fi.Room.Number} {fi.Room.Name}"; }
                // Try ToRoom/FromRoom for doors/windows?
                if (fi.ToRoom != null) { roomStatus = "resolved"; return $"{fi.ToRoom.Number} {fi.ToRoom.Name}"; }
                if (fi.FromRoom != null) { roomStatus = "resolved"; return $"{fi.FromRoom.Number} {fi.FromRoom.Name}"; }
            }

            // 2. Try Phase-aware Room lookup
            // Need to know phase. Default to last phase?
            // For now, simple Point location check
            XYZ p = null;
            if (e.Location is LocationPoint lp)
            {
                p = lp.Point;
            }
            else if (e.Location is LocationCurve lc && lc.Curve != null)
            {
                p = lc.Curve.Evaluate(0.5, true);
            }

            if (p != null)
            {
                var phases = doc.Phases;
                if (phases.Size > 0)
                {
                    var lastPhase = phases.get_Item(phases.Size - 1);
                    var room = doc.GetRoomAtPoint(p, lastPhase);
                    if (room != null) { roomStatus = "resolved"; return $"{room.Number} {room.Name}"; }
                    roomStatus = "unresolved:no_room_at_point";
                }
                else
                {
                    roomStatus = "unresolved:no_phases";
                }
            }
            else
            {
                roomStatus = "unresolved:no_location";
            }

            return "Unresolved";
        }

        private static List<string> NormalizeKeywords(List<string> kws)
        {
            if (kws == null) return null;
            var outList = new List<string>();
            foreach (var kw in kws)
            {
                var t = (kw ?? "").Trim();
                if (t.Length == 0) continue;
                outList.Add(t);
            }
            return outList.Count > 0 ? outList : null;
        }

        private static List<ParamFilter> NormalizeParamFilters(List<ParamFilter> filters)
        {
            if (filters == null) return null;
            var outList = new List<ParamFilter>();
            foreach (var f in filters)
            {
                if (f == null) continue;
                var p = (f.param ?? "").Trim();
                var v = (f.value ?? "").Trim();
                if (p.Length == 0) continue;
                outList.Add(new ParamFilter { param = p, value = v, op = (f.op ?? "").Trim() });
            }
            return outList.Count > 0 ? outList : null;
        }

        private void CollectForDoc(
            Document targetDoc,
            string source,
            long? linkInstanceId,
            string linkName,
            ElementFilter catFilter,
            QuantifyRequest request,
            List<string> includeKeywords,
            List<string> excludeKeywords,
            List<ParamFilter> paramFilters,
            List<long> hostIdsForResultSet,
            List<QuantifyRow> outRows,
            Dictionary<string, int> roomUnresolvedCounts)
        {
            var collector = new FilteredElementCollector(targetDoc);
            if (catFilter != null) collector.WherePasses(catFilter);
            collector.WhereElementIsNotElementType();

            foreach (var e in collector.ToElements())
            {
                // Level Filter
                var levelName = GetLevelName(targetDoc, e);
                if (!string.IsNullOrEmpty(request.filters?.level))
                {
                    if (levelName == null || !levelName.Equals(request.filters.level, StringComparison.OrdinalIgnoreCase))
                        continue;
                }

                // Keyword Filter (Type/Family + instance name)
                if (includeKeywords != null || excludeKeywords != null)
                {
                    var typeId = e.GetTypeId();
                    var type = targetDoc.GetElement(typeId) as ElementType;
                    var familyName = type?.FamilyName ?? "";
                    var typeName = type?.Name ?? "";
                    var combinedName = $"{familyName} {typeName} {e.Name}";

                    if (includeKeywords != null)
                    {
                        bool hit = false;
                        foreach (var kw in includeKeywords)
                        {
                            if (combinedName.IndexOf(kw, StringComparison.OrdinalIgnoreCase) >= 0) { hit = true; break; }
                        }
                        if (!hit) continue;
                    }

                    if (excludeKeywords != null)
                    {
                        bool hit = false;
                        foreach (var kw in excludeKeywords)
                        {
                            if (combinedName.IndexOf(kw, StringComparison.OrdinalIgnoreCase) >= 0) { hit = true; break; }
                        }
                        if (hit) continue;
                    }
                }

                // Parameter filters (instance parameters; string compare)
                if (paramFilters != null)
                {
                    if (!MatchesParamFilters(e, paramFilters)) continue;
                }

                var typeEl = targetDoc.GetElement(e.GetTypeId()) as ElementType;
                var row = new QuantifyRow
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    source = source,
                    linkInstanceId = linkInstanceId,
                    linkName = linkName,
                    category = e.Category?.Name,
                    type = typeEl?.Name ?? e.Name,
                    name = e.Name,
                    level = levelName
                };

                // Mark parameter
                var pMark = e.get_Parameter(BuiltInParameter.ALL_MODEL_MARK);
                if (pMark != null && pMark.HasValue)
                {
                    try
                    {
                        var m = pMark.AsString();
                        if (!string.IsNullOrWhiteSpace(m)) row.name = m;
                    }
                    catch { }
                }

                if (request.room_resolution)
                {
                    row.room = ResolveRoom(targetDoc, e, out var status);
                    row.room_status = status;
                    if (!string.Equals(status, "resolved", StringComparison.OrdinalIgnoreCase))
                    {
                        if (!roomUnresolvedCounts.ContainsKey(status)) roomUnresolvedCounts[status] = 0;
                        roomUnresolvedCounts[status]++;
                    }
                }

                outRows.Add(row);
                if (hostIdsForResultSet != null && string.Equals(source, "host", StringComparison.OrdinalIgnoreCase))
                {
                    hostIdsForResultSet.Add(RevitBridge.Common.ElementIdCompat.GetValue(e.Id));
                }
            }
        }

        private static bool MatchesParamFilters(Element e, List<ParamFilter> filters)
        {
            foreach (var f in filters)
            {
                var paramName = (f.param ?? "").Trim();
                if (paramName.Length == 0) continue;

                var param = e.LookupParameter(paramName);
                if (param == null) return false;

                var actual = TryGetParameterString(param);
                var expected = (f.value ?? "").Trim();
                var op = (f.op ?? "").Trim().ToLowerInvariant();
                if (op.Length == 0) op = "contains";

                if (actual == null) actual = "";

                if (op == "equals")
                {
                    if (!string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)) return false;
                }
                else if (op == "startswith" || op == "startwith" || op == "starts_with")
                {
                    if (!actual.StartsWith(expected, StringComparison.OrdinalIgnoreCase)) return false;
                }
                else // contains
                {
                    if (actual.IndexOf(expected, StringComparison.OrdinalIgnoreCase) < 0) return false;
                }
            }
            return true;
        }

        private static string TryGetParameterString(Parameter param)
        {
            if (param == null) return null;
            try
            {
                if (param.StorageType == StorageType.String) return param.AsString() ?? "";
            }
            catch { }

            try
            {
                var vs = param.AsValueString();
                if (!string.IsNullOrWhiteSpace(vs)) return vs;
            }
            catch { }

            try
            {
                switch (param.StorageType)
                {
                    case StorageType.Integer:
                        return param.AsInteger().ToString();
                    case StorageType.Double:
                        return param.AsDouble().ToString("G", System.Globalization.CultureInfo.InvariantCulture);
                    case StorageType.ElementId:
                        var id = param.AsElementId();
                        return id == null ? "" : RevitBridge.Common.ElementIdCompat.GetValue(id).ToString();
                    default:
                        return "";
                }
            }
            catch
            {
                return "";
            }
        }

        private static string BuildGroupKey(QuantifyRow row, List<string> keys)
        {
            if (keys == null || keys.Count == 0) return row?.type ?? "Unknown";
            if (keys.Count == 1) return ResolveGroupValue(row, keys[0]);
            var parts = new List<string>();
            foreach (var k in keys)
            {
                var v = ResolveGroupValue(row, k);
                parts.Add(string.IsNullOrWhiteSpace(v) ? "Unknown" : v);
            }
            return string.Join(" | ", parts);
        }

        private static string ResolveGroupValue(QuantifyRow row, string keyRaw)
        {
            var key = (keyRaw ?? "").Trim().ToLowerInvariant();
            if (key == "level") return row.level ?? "Unassigned";
            if (key == "room") return row.room ?? "Unplaced";
            if (key == "category") return row.category ?? "Unknown";
            return row.type ?? "Unknown";
        }
    }
}

