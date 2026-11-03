using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;

namespace RevitBridge.Common
{
    public static class NativeMoveReadback
    {
        public static void VerifyCommitted(Dictionary<string, object?> result, IEnumerable<long> requestedIds,
            double[] translationFeet)
        {
            if (!result.TryGetValue("transaction", out var raw) || !(raw is OperatorNativeTransactionReceipt receipt) || receipt.CommittedValue != true)
                return;
            var requested = requestedIds.Distinct().ToArray();
            var matched = new List<long>();
            var mismatched = new List<long>();
            var unavailable = new List<long>();
            bool coverage = requested.Length > 0 && requested.All(id => id > 0) && FinitePoint(translationFeet);
            try
            {
                if (!result.TryGetValue("snapshots", out var snapshots)) throw new InvalidOperationException("Missing persisted move snapshots.");
                using var document = JsonDocument.Parse(JsonSerializer.Serialize(snapshots));
                var rows = document.RootElement.EnumerateArray().ToArray();
                var ids = rows.Select(row => row.GetProperty("id").GetInt64()).ToArray();
                coverage &= ids.Length == requested.Length && ids.Distinct().Count() == ids.Length && ids.All(requested.Contains);
                foreach (var id in requested)
                {
                    var candidates = rows.Where(row => row.GetProperty("id").GetInt64() == id).ToArray();
                    if (candidates.Length != 1 || !FinitePoint(translationFeet)) { unavailable.Add(id); continue; }
                    var row = candidates[0];
                    if (!row.TryGetProperty("before", out var before) || !row.TryGetProperty("after", out var after)) { unavailable.Add(id); continue; }
                    var match = TranslationMatches(before, after, translationFeet);
                    if (match == null) unavailable.Add(id);
                    else if (match.Value) matched.Add(id);
                    else mismatched.Add(id);
                }
            }
            catch (Exception error) when (error is JsonException || error is InvalidOperationException || error is KeyNotFoundException || error is FormatException || error is OverflowException || error is ArgumentException)
            {
                coverage = false;
                unavailable = requested.Except(matched).Except(mismatched).ToList();
            }
            bool complete = coverage && unavailable.Count == 0;
            bool satisfied = complete && matched.Count == requested.Length && mismatched.Count == 0;
            result["movePostcondition"] = new { complete, satisfied, requestedTranslationFeet = FinitePoint(translationFeet) ? translationFeet : null,
                positionToleranceFeet = 0.000001, satisfiedIds = matched.ToArray(), mismatchedIds = mismatched.ToArray(),
                unavailableIds = unavailable.ToArray(), scope = "Persisted requested native anchor/curve-endpoint translation only; not collateral, appearance or whole-task verification." };
            if (!satisfied)
            {
                // The transaction already committed. Do not erase its footprint,
                // claim rollback/unknown, or invite a blind repeated mutation.
                result["success"] = false; result["ok"] = false; result["verified"] = false;
                var message = "Committed move did not establish the requested translation. Inspect the retained snapshots and effect footprint; do not repeat the move solely because this postcondition failed.";
                result["error"] = result.TryGetValue("error", out var prior) && prior is string text && text.Length > 0 ? text + "; " + message : message;
            }
            if (!(result.TryGetValue("success", out var success) && success is true))
            { result["verified"] = false; result["ok"] = false; }
        }

        private static bool FinitePoint(double[]? values) => values != null && values.Length == 3 && values.All(v => !double.IsNaN(v) && !double.IsInfinity(v));
        private static double[]? Point(JsonElement value, string name)
        {
            if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var raw) || raw.ValueKind != JsonValueKind.Array) return null;
            var point = raw.EnumerateArray().Select(n => n.GetDouble()).ToArray();
            return FinitePoint(point) ? point : null;
        }
        private static bool? TranslationMatches(JsonElement before, JsonElement after, double[] vector)
        {
            if (before.ValueKind != JsonValueKind.Object || after.ValueKind != JsonValueKind.Object
                || !before.TryGetProperty("kind", out var bk) || !after.TryGetProperty("kind", out var ak)
                || bk.ValueKind != JsonValueKind.String || ak.ValueKind != JsonValueKind.String) return null;
            if (bk.GetString() != ak.GetString()) return null;
            string[] fields;
            switch (bk.GetString())
            {
                case "LocationPoint": case "TextAnchor": case "TagHead": case "ScheduleInsertion":
                case "PanelScheduleOrigin": case "ViewportBoxCenter": case "ViewportProjectionOrigin": fields = new[] { "pointXyz" }; break;
                case "LocationCurve": fields = new[] { "startXyz", "endXyz" }; break;
                case "BboxCenter": fields = new[] { "centerXyz" }; break;
                default: return null;
            }
            foreach (var key in new[] { "ownerViewId", "ownerViewUniqueId", "elementUniqueId", "coordinateSpace" })
            {
                bool hasBefore = before.TryGetProperty(key, out var bv), hasAfter = after.TryGetProperty(key, out var av);
                if (hasBefore != hasAfter || (hasBefore && bv.GetRawText() != av.GetRawText())) return null;
            }
            bool matches = true;
            foreach (var field in fields)
            {
                var b = Point(before, field); var a = Point(after, field);
                if (b == null || a == null) return null;
                for (int i = 0; i < 3; i++) matches &= Math.Abs((a[i] - b[i]) - vector[i]) <= 0.000001;
            }
            foreach (var field in new[] { "basisXXyz", "basisYXyz", "basisZXyz" })
            {
                bool hasBefore = before.TryGetProperty(field, out _), hasAfter = after.TryGetProperty(field, out _);
                if (hasBefore != hasAfter) return null;
                if (hasBefore)
                {
                    var b = Point(before, field); var a = Point(after, field);
                    if (a == null || b == null) return null;
                    for (int i = 0; i < 3; i++) matches &= Math.Abs(a[i] - b[i]) <= 0.000001;
                }
            }
            bool hasRotation = before.TryGetProperty("rotationRadians", out var rotationBefore);
            if (hasRotation != after.TryGetProperty("rotationRadians", out var rotationAfter)) return null;
            if (hasRotation)
            {
                var b = rotationBefore.GetDouble(); var a = rotationAfter.GetDouble();
                if (double.IsNaN(a) || double.IsInfinity(a) || double.IsNaN(b) || double.IsInfinity(b)) return null;
                matches &= Math.Abs(Math.IEEERemainder(a - b, 2 * Math.PI)) <= 0.000001;
            }
            return matches;
        }
    }
}
