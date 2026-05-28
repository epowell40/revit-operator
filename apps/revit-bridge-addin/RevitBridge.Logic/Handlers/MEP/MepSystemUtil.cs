using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Mechanical;

namespace RevitBridge.Logic.Handlers.MEP
{
    internal static class MepSystemUtil
    {
        private static readonly string[] SupplyHints = { "supply", "supply air", "supplyair", "sa" };
        private static readonly string[] ReturnHints = { "return", "return air", "returnair", "ra" };
        private static readonly string[] ExhaustHints = { "exhaust", "exhaust air", "exhaustair", "ea", "relief", "relief air", "reliefair" };

        public static string? TryGetSystemName(Element e)
        {
            if (e == null) return null;
            try
            {
                var p = e.get_Parameter(BuiltInParameter.RBS_SYSTEM_NAME_PARAM);
                var s = p?.AsString();
                if (string.IsNullOrWhiteSpace(s)) s = p?.AsValueString();
                s = (s ?? "").Trim();
                return s.Length == 0 ? null : s;
            }
            catch
            {
                return null;
            }
        }

        public static IEnumerable<Connector> GetConnectors(Element e)
        {
            if (e == null) yield break;

            List<Connector>? curveConnectors = null;
            try
            {
                if (e is MEPCurve curve)
                {
                    var cm = curve.ConnectorManager;
                    if (cm != null)
                    {
                        curveConnectors = cm.Connectors.Cast<Connector>().Where(x => x != null).ToList();
                    }
                }
            }
            catch { curveConnectors = null; }

            if (curveConnectors != null && curveConnectors.Count > 0)
            {
                foreach (var c in curveConnectors) yield return c;
                yield break;
            }

            List<Connector>? fiConnectors = null;
            try
            {
                if (e is FamilyInstance fi)
                {
                    var cm = fi.MEPModel?.ConnectorManager;
                    if (cm != null)
                    {
                        fiConnectors = cm.Connectors.Cast<Connector>().Where(x => x != null).ToList();
                    }
                }
            }
            catch { fiConnectors = null; }

            if (fiConnectors != null && fiConnectors.Count > 0)
            {
                foreach (var c in fiConnectors) yield return c;
                yield break;
            }

            // Some element types (e.g., FabricationPart) also have ConnectorManager, but we keep v1 scoped to
            // common duct/equipment/family instances and avoid reflection/dynamic.
        }

        public static IEnumerable<ElementId> GetConnectedOwnerElementIds(Element e)
        {
            if (e == null) yield break;
            var ownerId = e.Id;
            var seen = new HashSet<int>();

            foreach (var c in GetConnectors(e))
            {
                if (c == null) continue;
                ConnectorSet? refs = null;
                try { refs = c.AllRefs; } catch { refs = null; }
                if (refs == null) continue;

                foreach (Connector r in refs)
                {
                    if (r == null) continue;
                    var o = r.Owner;
                    if (o == null) continue;
                    var id = o.Id;
                    if (id == null || id == ownerId) continue;
                    if (seen.Add(id.IntegerValue)) yield return id;
                }
            }
        }

        public static bool SystemNameMatches(string? actual, string? filter)
        {
            var a = (actual ?? "").Trim();
            var f = (filter ?? "").Trim();
            if (f.Length == 0) return true;
            return a.Equals(f, StringComparison.OrdinalIgnoreCase);
        }

        public static bool IsAnySystemClassification(string? required)
        {
            var raw = (required ?? "").Trim();
            if (raw.Length == 0) return true;
            return raw.Equals("any", StringComparison.OrdinalIgnoreCase) || raw.Equals("all", StringComparison.OrdinalIgnoreCase);
        }

        public static List<string> GetSystemTextCandidates(Element e)
        {
            var outList = new List<string>();
            if (e == null) return outList;

            TryAddParameterValue(e, "System Classification", outList);
            TryAddParameterValue(e, "System Classification Name", outList);
            TryAddParameterValue(e, "System Name", outList);
            TryAddParameterValue(e, "System Type", outList);

            var fromUtil = TryGetSystemName(e);
            if (!string.IsNullOrWhiteSpace(fromUtil)) outList.Add(fromUtil!);

            return outList
                .Where(x => !string.IsNullOrWhiteSpace(x))
                .Select(x => x.Trim())
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        public static bool ElementMatchesSystemClassification(Element e, string? required)
        {
            if (IsAnySystemClassification(required)) return true;
            var candidates = GetSystemTextCandidates(e);
            return MatchesSystemClassificationCandidates(candidates, required);
        }

        public static bool MatchesSystemClassificationCandidates(IEnumerable<string> candidates, string? required)
        {
            if (IsAnySystemClassification(required)) return true;

            var wantRaw = (required ?? "").Trim();
            if (wantRaw.Length == 0) return true;
            var wantNorm = NormalizeForMatch(wantRaw);
            var wantClass = CanonicalClassification(wantRaw);

            foreach (var c in candidates ?? Enumerable.Empty<string>())
            {
                var actualRaw = (c ?? "").Trim();
                if (actualRaw.Length == 0) continue;
                var actualNorm = NormalizeForMatch(actualRaw);
                var actualClass = CanonicalClassification(actualRaw);

                if (wantClass.Length > 0)
                {
                    if (actualClass.Equals(wantClass, StringComparison.OrdinalIgnoreCase)) return true;
                    if (actualNorm.IndexOf(wantClass, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                    continue;
                }

                if (actualNorm.Equals(wantNorm, StringComparison.OrdinalIgnoreCase)) return true;
                if (actualNorm.IndexOf(wantNorm, StringComparison.OrdinalIgnoreCase) >= 0) return true;
                if (wantNorm.IndexOf(actualNorm, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }

            return false;
        }

        private static void TryAddParameterValue(Element e, string name, List<string> values)
        {
            try
            {
                var p = e.LookupParameter(name);
                if (p == null) return;
                var v = p.AsString() ?? p.AsValueString();
                if (!string.IsNullOrWhiteSpace(v)) values.Add(v.Trim());
            }
            catch
            {
                // ignore
            }
        }

        private static string CanonicalClassification(string raw)
        {
            var n = NormalizeForMatch(raw);
            if (n.Length == 0) return "";
            if (n == "any" || n == "all") return "any";
            if (ContainsHint(n, SupplyHints)) return "supply";
            if (ContainsHint(n, ReturnHints)) return "return";
            if (ContainsHint(n, ExhaustHints)) return "exhaust";
            return "";
        }

        private static bool ContainsHint(string normalizedValue, string[] hints)
        {
            foreach (var hint in hints)
            {
                var h = NormalizeForMatch(hint);
                if (h.Length == 0) continue;
                if (normalizedValue.Equals(h, StringComparison.OrdinalIgnoreCase)) return true;
                if (normalizedValue.IndexOf(h, StringComparison.OrdinalIgnoreCase) >= 0) return true;
            }

            return false;
        }

        private static string NormalizeForMatch(string raw)
        {
            var src = (raw ?? "").Trim().ToLowerInvariant();
            if (src.Length == 0) return "";
            var chars = src
                .Select(ch => char.IsLetterOrDigit(ch) ? ch : ' ')
                .ToArray();
            var compact = new string(chars);
            while (compact.IndexOf("  ", StringComparison.Ordinal) >= 0)
            {
                compact = compact.Replace("  ", " ");
            }
            return compact.Trim();
        }
    }
}
