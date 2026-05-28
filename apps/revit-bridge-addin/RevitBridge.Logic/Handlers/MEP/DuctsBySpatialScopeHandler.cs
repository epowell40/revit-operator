using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Logic.Handlers.MEP
{
    public sealed class DuctsBySpatialScopeHandler : IRequestHandler
    {
        private const double SizeToleranceFt = 1e-5;

        public sealed class Params
        {
            public string roomNumber { get; set; } = "";
            public string? systemClassification { get; set; }
            public string? sizeFrom { get; set; }
            public string verticalScope { get; set; } = "room+plenum"; // room | plenum | room+plenum
            public List<string>? includeCategories { get; set; } // Ducts | Duct Fittings | Air Terminals
            public string roomMode { get; set; } = "auto"; // auto | roomAware | geometry
            public bool includeConnectedOutsideRoom { get; set; } = false;
            public int? limit { get; set; } = 20000;
        }

        private sealed class AttemptResult
        {
            public string query { get; set; } = "";
            public string mode { get; set; } = "";
            public string verticalScope { get; set; } = "";
            public string spatialPreference { get; set; } = "";
            public int matchedCount { get; set; }
            public string resolvedType { get; set; } = "";
            public string resolvedNumber { get; set; } = "";
            public double confidence { get; set; }
            public string matchMode { get; set; } = "";
            public List<string> warnings { get; set; } = new List<string>();
        }

        private sealed class ElementRow
        {
            public long id { get; set; }
            public string category { get; set; } = "";
            public string categoryToken { get; set; } = "";
            public string? systemName { get; set; }
            public string size { get; set; } = "";
            public List<double> roundDiametersFt { get; set; } = new List<double>();
            public bool matchesSizeFrom { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var rawQuery = (p.roomNumber ?? "").Trim();
            if (rawQuery.Length == 0) throw new ArgumentException("roomNumber is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var modes = ResolveModes(p.roomMode);
            var verticalScopes = ResolveVerticalScopes(p.verticalScope);
            var categories = ResolveCategories(p.includeCategories);
            var max = p.limit.HasValue && p.limit.Value > 0 ? Math.Min(p.limit.Value, 200000) : 20000;
            var systemClassification = (p.systemClassification ?? "").Trim();
            var includeConnected = p.includeConnectedOutsideRoom;

            double? sizeFromFt = null;
            var sizeFrom = (p.sizeFrom ?? "").Trim();
            if (sizeFrom.Length > 0)
            {
                if (!LengthTextUtil.TryParseLengthToFeet(doc, sizeFrom, out var parsed, out var sizeErr))
                    throw new InvalidOperationException($"Could not parse sizeFrom: {sizeErr}");
                sizeFromFt = parsed;
            }

            var warnings = new List<string>();
            var attempts = new List<AttemptResult>();
            var matchedIds = new HashSet<long>();

            var queryCandidates = BuildQueryCandidates(rawQuery);
            foreach (var q in queryCandidates)
            {
                TryCollectByQuery(app, q, modes, verticalScopes, categories, systemClassification, includeConnected, max, attempts, matchedIds);
                if (matchedIds.Count > 0) break;
            }

            if (matchedIds.Count == 0)
            {
                var byName = FindFallbackNumbersByName(doc, rawQuery);
                foreach (var q in byName)
                {
                    TryCollectByQuery(app, q, modes, verticalScopes, categories, systemClassification, includeConnected, max, attempts, matchedIds);
                    if (matchedIds.Count > 0) break;
                }
            }

            var rows = new List<ElementRow>();
            foreach (var id in matchedIds)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null) continue;
                var probe = ProbeElementSize(doc, e);
                var sizeMatch = !sizeFromFt.HasValue || probe.RoundDiametersFt.Any(d => Math.Abs(d - sizeFromFt.Value) <= SizeToleranceFt);
                if (!sizeMatch) continue;

                rows.Add(new ElementRow
                {
                    id = id,
                    category = e.Category?.Name ?? "",
                    categoryToken = SelectionUtil.GetCategoryToken(e) ?? "",
                    systemName = MepSystemUtil.TryGetSystemName(e),
                    size = probe.SizeText,
                    roundDiametersFt = probe.RoundDiametersFt,
                    matchesSizeFrom = sizeMatch
                });
            }

            var byCategory = rows
                .GroupBy(r => string.IsNullOrWhiteSpace(r.categoryToken) ? (r.category ?? "None") : r.categoryToken)
                .ToDictionary(g => g.Key, g => g.Count(), StringComparer.OrdinalIgnoreCase);

            if (rows.Count == 0 && sizeFromFt.HasValue && matchedIds.Count > 0)
                warnings.Add($"No scoped elements matched sizeFrom '{sizeFrom}'.");

            return Task.FromResult<object>(new
            {
                status = "Ok",
                endpoint = "/revit/ducts-by-spatial-scope",
                query = rawQuery,
                roomMode = (p.roomMode ?? "auto"),
                verticalScope = (p.verticalScope ?? "room+plenum"),
                includeCategories = categories,
                systemClassification = systemClassification.Length > 0 ? systemClassification : null,
                sizeFrom = sizeFrom.Length > 0 ? sizeFrom : null,
                attempts,
                elementIds = rows.Select(x => x.id).OrderBy(x => x).ToList(),
                elements = rows.OrderBy(x => x.id).ToList(),
                counts = new
                {
                    matchedCount = rows.Count,
                    byCategory
                },
                warnings
            });
        }

        private static void TryCollectByQuery(
            UIApplication app,
            string roomQuery,
            List<string> modes,
            List<string> verticalScopes,
            List<string> categories,
            string? systemClassification,
            bool includeConnectedOutside,
            int max,
            List<AttemptResult> attempts,
            HashSet<long> matchedIds)
        {
            foreach (var mode in modes)
            {
                foreach (var vertical in verticalScopes)
                {
                    var roomFirst = ExecuteRoomContents(app, roomQuery, mode, vertical, "room", categories, systemClassification, includeConnectedOutside, max);
                    attempts.Add(roomFirst.attempt);
                    if (roomFirst.ids.Count > 0)
                    {
                        foreach (var id in roomFirst.ids) matchedIds.Add(id);
                        continue;
                    }

                    var spaceFallback = ExecuteRoomContents(app, roomQuery, mode, vertical, "space", categories, systemClassification, includeConnectedOutside, max);
                    attempts.Add(spaceFallback.attempt);
                    foreach (var id in spaceFallback.ids) matchedIds.Add(id);
                }
            }
        }

        private static (List<long> ids, AttemptResult attempt) ExecuteRoomContents(
            UIApplication app,
            string roomQuery,
            string mode,
            string verticalScope,
            string spatialPreference,
            List<string> categories,
            string? systemClassification,
            bool includeConnectedOutside,
            int limit)
        {
            try
            {
                var req = new RoomContentsHandler.Params
                {
                    roomNumber = roomQuery,
                    mode = mode,
                    verticalScope = verticalScope,
                    categories = categories,
                    systemClassification = systemClassification,
                    includeConnectedOutsideRoom = includeConnectedOutside,
                    spatialKindPreference = spatialPreference,
                    limit = limit
                };

                var res = new RoomContentsHandler().Handle(app, JsonSerializer.Serialize(req)).GetAwaiter().GetResult();
                var ids = new HashSet<long>();
                foreach (var id in ReadIdList(res, "elementIds")) ids.Add(id);
                foreach (var id in ReadIdList(res, "connectedOutsideRoomIds")) ids.Add(id);

                var resolved = ReadResolvedSpatial(res);
                var attempt = new AttemptResult
                {
                    query = roomQuery,
                    mode = mode,
                    verticalScope = verticalScope,
                    spatialPreference = spatialPreference,
                    matchedCount = ids.Count,
                    resolvedType = resolved.type,
                    resolvedNumber = resolved.number,
                    confidence = resolved.confidence,
                    matchMode = resolved.matchMode,
                    warnings = ReadWarnings(res)
                };
                return (ids.OrderBy(x => x).ToList(), attempt);
            }
            catch (Exception ex)
            {
                return (new List<long>(), new AttemptResult
                {
                    query = roomQuery,
                    mode = mode,
                    verticalScope = verticalScope,
                    spatialPreference = spatialPreference,
                    matchedCount = 0,
                    warnings = new List<string> { ex.Message }
                });
            }
        }

        private static List<string> ResolveModes(string? modeRaw)
        {
            var mode = (modeRaw ?? "auto").Trim();
            if (mode.Length == 0) mode = "auto";
            if (mode.Equals("auto", StringComparison.OrdinalIgnoreCase)) return new List<string> { "roomAware", "geometry" };
            if (mode.Equals("roomAware", StringComparison.OrdinalIgnoreCase)) return new List<string> { "roomAware" };
            if (mode.Equals("geometry", StringComparison.OrdinalIgnoreCase)) return new List<string> { "geometry" };
            throw new ArgumentException("roomMode must be one of: auto | roomAware | geometry.");
        }

        private static List<string> ResolveVerticalScopes(string? scopeRaw)
        {
            var s = (scopeRaw ?? "room+plenum").Trim();
            if (s.Length == 0) s = "room+plenum";
            if (s.Equals("room", StringComparison.OrdinalIgnoreCase)) return new List<string> { "room" };
            if (s.Equals("plenum", StringComparison.OrdinalIgnoreCase)) return new List<string> { "plenum" };
            if (s.Equals("room+plenum", StringComparison.OrdinalIgnoreCase) || s.Equals("both", StringComparison.OrdinalIgnoreCase))
                return new List<string> { "room", "plenum" };
            throw new ArgumentException("verticalScope must be one of: room | plenum | room+plenum.");
        }

        private static List<string> ResolveCategories(List<string>? raw)
        {
            var src = raw == null || raw.Count == 0
                ? new List<string> { "Ducts", "Duct Fittings", "Air Terminals" }
                : raw.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()).ToList();

            var outList = new List<string>();
            foreach (var c in src)
            {
                if (c.Equals("Ducts", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("Duct Curves", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("OST_DuctCurves", StringComparison.OrdinalIgnoreCase))
                {
                    outList.Add("OST_DuctCurves");
                    continue;
                }
                if (c.Equals("Duct Fittings", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("Fittings", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("OST_DuctFitting", StringComparison.OrdinalIgnoreCase))
                {
                    outList.Add("OST_DuctFitting");
                    continue;
                }
                if (c.Equals("Air Terminals", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("Terminals", StringComparison.OrdinalIgnoreCase) ||
                    c.Equals("OST_DuctTerminal", StringComparison.OrdinalIgnoreCase))
                {
                    outList.Add("OST_DuctTerminal");
                    continue;
                }
                outList.Add(c);
            }

            return outList.Distinct(StringComparer.OrdinalIgnoreCase).ToList();
        }

        private static List<string> BuildQueryCandidates(string rawQuery)
        {
            var q = (rawQuery ?? "").Trim();
            var outList = new List<string>();
            if (q.Length > 0) outList.Add(q);

            var m = Regex.Match(q, @"\d+[A-Za-z]?");
            if (m.Success)
            {
                var num = m.Value.Trim();
                if (num.Length > 0 && !outList.Contains(num, StringComparer.OrdinalIgnoreCase)) outList.Add(num);
            }

            return outList;
        }

        private static List<string> FindFallbackNumbersByName(Document doc, string rawQuery)
        {
            var q = (rawQuery ?? "").Trim();
            if (q.Length == 0) return new List<string>();

            var numberToken = Regex.Match(q, @"\d+[A-Za-z]?").Success ? Regex.Match(q, @"\d+[A-Za-z]?").Value.Trim() : "";
            var nameHint = Regex.Replace(q, @"\d+[A-Za-z]?", " ").Trim();
            if (nameHint.Length == 0) return new List<string>();

            var outSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            TryCollectNameMatches(doc, BuiltInCategory.OST_Rooms, nameHint, numberToken, outSet);
            TryCollectNameMatches(doc, BuiltInCategory.OST_MEPSpaces, nameHint, numberToken, outSet);
            return outSet.Take(5).ToList();
        }

        private static void TryCollectNameMatches(Document doc, BuiltInCategory category, string nameHint, string numberToken, HashSet<string> outSet)
        {
            try
            {
                var elems = new FilteredElementCollector(doc)
                    .OfCategory(category)
                    .WhereElementIsNotElementType()
                    .ToElements();
                foreach (var e in elems)
                {
                    if (e == null) continue;
                    var name = (e.Name ?? "").Trim();
                    if (nameHint.Length > 0 && name.IndexOf(nameHint, StringComparison.OrdinalIgnoreCase) < 0) continue;

                    var number = ReadSpatialNumber(e);
                    if (numberToken.Length > 0 && !NumbersRoughlyEqual(number, numberToken)) continue;
                    if (number.Length == 0) continue;
                    outSet.Add(number);
                    if (outSet.Count >= 5) break;
                }
            }
            catch
            {
                // ignore fallback errors
            }
        }

        private static string ReadSpatialNumber(Element e)
        {
            try
            {
                var p = e.LookupParameter("Number");
                var s = p?.AsString() ?? p?.AsValueString();
                return (s ?? "").Trim();
            }
            catch
            {
                return "";
            }
        }

        private static bool NumbersRoughlyEqual(string a, string b)
        {
            var an = NormalizeNumericRoomNumber(a);
            var bn = NormalizeNumericRoomNumber(b);
            return string.Equals(an, bn, StringComparison.OrdinalIgnoreCase);
        }

        private static string NormalizeNumericRoomNumber(string s)
        {
            var t = (s ?? "").Trim();
            if (t.Length == 0) return "";
            foreach (var c in t)
            {
                if (!char.IsDigit(c)) return t;
            }
            var stripped = t.TrimStart('0');
            return stripped.Length == 0 ? "0" : stripped;
        }

        private static List<long> ReadIdList(object payload, string key)
        {
            var outList = new List<long>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty(key, out var arr) || arr.ValueKind != JsonValueKind.Array) return outList;
                foreach (var el in arr.EnumerateArray())
                {
                    if (el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out var id) && id > 0) outList.Add(id);
                }
            }
            catch
            {
                // ignore parse errors
            }
            return outList;
        }

        private static List<string> ReadWarnings(object payload)
        {
            var outList = new List<string>();
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty("warnings", out var arr) || arr.ValueKind != JsonValueKind.Array) return outList;
                foreach (var el in arr.EnumerateArray())
                {
                    if (el.ValueKind == JsonValueKind.String)
                    {
                        var s = (el.GetString() ?? "").Trim();
                        if (s.Length > 0) outList.Add(s);
                    }
                }
            }
            catch
            {
                // ignore parse errors
            }
            return outList;
        }

        private static (string type, string number, double confidence, string matchMode) ReadResolvedSpatial(object payload)
        {
            try
            {
                using var doc = JsonDocument.Parse(JsonSerializer.Serialize(payload));
                if (!doc.RootElement.TryGetProperty("resolvedSpatial", out var rs) || rs.ValueKind != JsonValueKind.Object)
                    return ("", "", 0.0, "");

                var type = rs.TryGetProperty("type", out var t) && t.ValueKind == JsonValueKind.String ? (t.GetString() ?? "") : "";
                var number = rs.TryGetProperty("number", out var n) && n.ValueKind == JsonValueKind.String ? (n.GetString() ?? "") : "";
                var confidence = rs.TryGetProperty("confidence", out var c) && c.ValueKind == JsonValueKind.Number && c.TryGetDouble(out var d) ? d : 0.0;
                var matchMode = rs.TryGetProperty("matchMode", out var m) && m.ValueKind == JsonValueKind.String ? (m.GetString() ?? "") : "";
                return (type, number, confidence, matchMode);
            }
            catch
            {
                return ("", "", 0.0, "");
            }
        }

        private sealed class SizeProbe
        {
            public string SizeText { get; set; } = "";
            public List<double> RoundDiametersFt { get; set; } = new List<double>();
        }

        private static SizeProbe ProbeElementSize(Document doc, Element e)
        {
            var probe = new SizeProbe();
            var diameters = new HashSet<double>();

            try
            {
                foreach (var c in MepSystemUtil.GetConnectors(e))
                {
                    if (c == null) continue;
                    if (c.Shape == ConnectorProfileType.Round)
                    {
                        var d = 2.0 * c.Radius;
                        if (d > 0) diameters.Add(d);
                    }
                }
            }
            catch
            {
                // ignore
            }

            try
            {
                var pDia = e.get_Parameter(BuiltInParameter.RBS_CURVE_DIAMETER_PARAM);
                if (pDia != null && pDia.StorageType == StorageType.Double)
                {
                    var d = pDia.AsDouble();
                    if (d > 0) diameters.Add(d);
                }
            }
            catch
            {
                // ignore
            }

            var ordered = diameters.OrderBy(x => x).ToList();
            probe.RoundDiametersFt = ordered;

            if (ordered.Count > 0)
            {
                probe.SizeText = string.Join(" | ", ordered.Select(d => LengthTextUtil.FormatLength(doc, d)));
                return probe;
            }

            try
            {
                var size = e.LookupParameter("Size")?.AsValueString() ?? e.LookupParameter("Size")?.AsString();
                if (!string.IsNullOrWhiteSpace(size))
                {
                    probe.SizeText = size.Trim();
                    return probe;
                }
            }
            catch
            {
                // ignore
            }

            probe.SizeText = "";
            return probe;
        }
    }
}
