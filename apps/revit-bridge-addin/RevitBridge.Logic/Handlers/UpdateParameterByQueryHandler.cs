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
    public sealed class UpdateParameterByQueryHandler : IRequestHandler
    {
        private sealed class MatchedElement
        {
            public Element Element { get; set; } = null!;
            public string Label { get; set; } = "";
            public string? MatchSource { get; set; }
            public string? FamilyName { get; set; }
            public string? TypeName { get; set; }
        }

        public sealed class Params
        {
            public string? category { get; set; }
            public List<string>? categories { get; set; }
            public string? matchStartsWith { get; set; }
            public string? matchContains { get; set; }
            public List<string>? matchParameterNames { get; set; }
            public string? familyNameContains { get; set; }
            public string? typeNameContains { get; set; }
            public Dictionary<string, JsonElement>? query { get; set; }

            public string? parameterName { get; set; }
            public string? value { get; set; }
            public bool? onlyWhenBlank { get; set; }

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public object? confirm { get; set; }
            public int? limit { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            ApplyQueryAliases(p);
            var parameterName = $"{p.parameterName ?? ""}".Trim();
            if (parameterName.Length == 0) throw new InvalidOperationException("update-parameter-by-query.parameterName is required.");

            var nextValue = p.value;
            if (nextValue == null) throw new InvalidOperationException("update-parameter-by-query.value is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var isDryRun = (p.dryRun ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;
            var onlyWhenBlank = p.onlyWhenBlank ?? true;
            var limit = p.limit.HasValue && p.limit.Value > 0 ? Math.Min(p.limit.Value, 5000) : 500;

            var requestedCats = new List<string>();
            if (!string.IsNullOrWhiteSpace(p.category)) requestedCats.Add(p.category.Trim());
            if (p.categories != null) requestedCats.AddRange(p.categories.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x.Trim()));
            var bicList = new List<BuiltInCategory>();
            var unknownCats = new List<string>();
            BuiltInCategoryTokenUtil.ParseMany(requestedCats, bicList, unknownCats);

            var matched = new List<MatchedElement>();
            var warnings = new List<string>();
            var collector = new FilteredElementCollector(doc).WhereElementIsNotElementType();
            if (bicList.Count == 1) collector.OfCategory(bicList[0]);
            else if (bicList.Count > 1) collector.WherePasses(new ElementMulticategoryFilter(bicList));

            var scanned = 0;
            foreach (var element in collector)
            {
                if (element == null) continue;
                scanned++;
                if (scanned > 500000)
                {
                    warnings.Add("Scan cap reached (500000); results may be incomplete. Narrow the query filters.");
                    break;
                }

                if (!TryMatchElement(doc, element, p, out var label, out var matchSource, out var familyName, out var typeName))
                {
                    continue;
                }

                matched.Add(new MatchedElement
                {
                    Element = element,
                    Label = label,
                    MatchSource = matchSource,
                    FamilyName = familyName,
                    TypeName = typeName
                });

                if (matched.Count >= limit)
                {
                    warnings.Add($"Results truncated to limit={limit}.");
                    break;
                }
            }

            if (unknownCats.Count > 0)
            {
                warnings.Add($"Unknown categories ignored: {string.Join(", ", unknownCats)}");
            }

            var rows = new List<object>(matched.Count);
            var updateTargets = new List<(MatchedElement match, Parameter parameter)>();
            var failedCount = 0;
            var skippedCount = 0;

            foreach (var match in matched)
            {
                var element = match.Element;
                var elementId = ElementIdCompat.GetValue(element.Id);
                var parameter = element.LookupParameter(parameterName);
                if (parameter == null)
                {
                    failedCount++;
                    rows.Add(new
                    {
                        elementId,
                        category = SelectionUtil.GetCategoryToken(element) ?? element.Category?.Name,
                        label = match.Label,
                        matchSource = match.MatchSource,
                        familyName = match.FamilyName,
                        typeName = match.TypeName,
                        parameterName,
                        status = "failed",
                        reason = $"Parameter '{parameterName}' not found.",
                        before = (object?)null,
                        after = (object?)null
                    });
                    continue;
                }

                var before = ParameterValueUtil.SnapshotForWire(parameter);
                var isBlank = IsBlankParameter(parameter, before);
                if (onlyWhenBlank && !isBlank)
                {
                    skippedCount++;
                    rows.Add(new
                    {
                        elementId,
                        category = SelectionUtil.GetCategoryToken(element) ?? element.Category?.Name,
                        label = match.Label,
                        matchSource = match.MatchSource,
                        familyName = match.FamilyName,
                        typeName = match.TypeName,
                        parameterName,
                        status = apply ? "skipped" : "would_skip",
                        reason = "Parameter already has a nonblank value.",
                        before,
                        after = before
                    });
                    continue;
                }

                updateTargets.Add((match, parameter));
                rows.Add(new
                {
                    elementId,
                    category = SelectionUtil.GetCategoryToken(element) ?? element.Category?.Name,
                    label = match.Label,
                    matchSource = match.MatchSource,
                    familyName = match.FamilyName,
                    typeName = match.TypeName,
                    parameterName,
                    status = apply ? "pending_apply" : "would_update",
                    reason = isBlank ? "Parameter is blank or missing a value." : "Parameter matched update criteria.",
                    before,
                    after = apply ? null : ParameterValueUtil.SnapshotForWire(parameter)
                });
            }

            const int ConfirmThreshold = 25;
            var requestedUpdateCount = updateTargets.Count;
            var confirmText = CoerceConfirmText(p.confirm);
            var confirmReceived = BulkConfirmUtil.Normalize(confirmText);
            string? requiredConfirm = null;
            if (apply && requestedUpdateCount > ConfirmThreshold)
            {
                requiredConfirm = BulkConfirmUtil.ExpectedApplyChanges(requestedUpdateCount);
                if (!BulkConfirmUtil.EqualsNormalized(confirmText, requiredConfirm))
                {
                    throw new OperatorToolUserErrorException(
                        message: "Bulk query-based parameter update requires typed confirmation.",
                        code: "bulk_confirm_required",
                        requiredConfirm: requiredConfirm,
                        confirmReceived: confirmReceived,
                        maxChangesPerCall: 10,
                        hint: "Retry with confirm set to the requiredConfirm string (exact, but markdown like **...** is ok). If OPERATOR_BULK_CONFIRM_SIMPLE=1, you can also use confirm:\"yes\".");
                }
            }

            var updatedCount = 0;
            var verifiedCount = 0;
            var verificationFailedCount = 0;
            if (apply && updateTargets.Count > 0)
            {
                using (var trans = new Transaction(doc, "Update Parameters By Query"))
                {
                    trans.Start();
                    for (var index = 0; index < rows.Count; index++)
                    {
                        var row = rows[index];
                        var status = GetAnonymousString(row, "status");
                        if (!string.Equals(status, "pending_apply", StringComparison.OrdinalIgnoreCase)) continue;

                        var elementId = GetAnonymousLong(row, "elementId");
                        var target = updateTargets.FirstOrDefault(x => ElementIdCompat.GetValue(x.match.Element.Id) == elementId);
                        if (target.match == null || target.parameter == null)
                        {
                            failedCount++;
                            rows[index] = new
                            {
                                elementId,
                                category = GetAnonymousString(row, "category"),
                                label = GetAnonymousString(row, "label"),
                                matchSource = GetAnonymousString(row, "matchSource"),
                                familyName = GetAnonymousString(row, "familyName"),
                                typeName = GetAnonymousString(row, "typeName"),
                                parameterName,
                                status = "failed",
                                reason = "Matched update target could not be re-resolved.",
                                before = GetAnonymousValue(row, "before"),
                                after = GetAnonymousValue(row, "before")
                            };
                            continue;
                        }

                        var before = ParameterValueUtil.SnapshotForWire(target.parameter);
                        if (!ParameterValueUtil.TrySetFromString(target.parameter, nextValue, out var changed, out var message))
                        {
                            failedCount++;
                            rows[index] = new
                            {
                                elementId,
                                category = GetAnonymousString(row, "category"),
                                label = GetAnonymousString(row, "label"),
                                matchSource = GetAnonymousString(row, "matchSource"),
                                familyName = GetAnonymousString(row, "familyName"),
                                typeName = GetAnonymousString(row, "typeName"),
                                parameterName,
                                status = "failed",
                                reason = message ?? "Parameter write failed.",
                                before,
                                after = before
                            };
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(target.parameter);
                        rows[index] = new
                        {
                            elementId,
                            category = GetAnonymousString(row, "category"),
                            label = GetAnonymousString(row, "label"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            familyName = GetAnonymousString(row, "familyName"),
                            typeName = GetAnonymousString(row, "typeName"),
                            parameterName,
                            status = changed ? "updated_pending_verify" : "skipped",
                            reason = changed ? "Parameter value was updated and is pending read-back verification." : "Parameter already had the target value.",
                            before,
                            after
                        };
                    }

                    trans.Commit();
                }

                try { doc.Regenerate(); } catch { }
                try { uidoc.RefreshActiveView(); } catch { }

                for (var index = 0; index < rows.Count; index++)
                {
                    var row = rows[index];
                    var status = GetAnonymousString(row, "status");
                    if (!string.Equals(status, "updated_pending_verify", StringComparison.OrdinalIgnoreCase)) continue;

                    var elementId = GetAnonymousLong(row, "elementId");
                    var currentParameter = ResolveParameter(doc, elementId, parameterName);
                    if (currentParameter == null)
                    {
                        rows[index] = new
                        {
                            elementId,
                            category = GetAnonymousString(row, "category"),
                            label = GetAnonymousString(row, "label"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            familyName = GetAnonymousString(row, "familyName"),
                            typeName = GetAnonymousString(row, "typeName"),
                            parameterName,
                            status = "verify_failed",
                            reason = "Parameter could not be re-read after apply.",
                            before = GetAnonymousValue(row, "before"),
                            after = (object?)null
                        };
                        continue;
                    }

                    var verifiedSnapshot = ParameterValueUtil.SnapshotForWire(currentParameter);
                    if (ParameterValueUtil.SnapshotMatchesRequestedValue(verifiedSnapshot, nextValue))
                    {
                        rows[index] = new
                        {
                            elementId,
                            category = GetAnonymousString(row, "category"),
                            label = GetAnonymousString(row, "label"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            familyName = GetAnonymousString(row, "familyName"),
                            typeName = GetAnonymousString(row, "typeName"),
                            parameterName,
                            status = "updated_verified",
                            reason = "Parameter value was updated and verified by read-back.",
                            before = GetAnonymousValue(row, "before"),
                            after = verifiedSnapshot
                        };
                    }
                    else
                    {
                        rows[index] = new
                        {
                            elementId,
                            category = GetAnonymousString(row, "category"),
                            label = GetAnonymousString(row, "label"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            familyName = GetAnonymousString(row, "familyName"),
                            typeName = GetAnonymousString(row, "typeName"),
                            parameterName,
                            status = "verify_failed",
                            reason = $"Parameter write did not persist expected value '{nextValue}'.",
                            before = GetAnonymousValue(row, "before"),
                            after = verifiedSnapshot
                        };
                    }
                }

                updatedCount = rows.Count(r => string.Equals(GetAnonymousString(r, "status"), "updated_verified", StringComparison.OrdinalIgnoreCase));
                verifiedCount = updatedCount;
                skippedCount = rows.Count(r => string.Equals(GetAnonymousString(r, "status"), "skipped", StringComparison.OrdinalIgnoreCase));
                verificationFailedCount = rows.Count(r => string.Equals(GetAnonymousString(r, "status"), "verify_failed", StringComparison.OrdinalIgnoreCase));
                failedCount = rows.Count(r =>
                    string.Equals(GetAnonymousString(r, "status"), "failed", StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(GetAnonymousString(r, "status"), "verify_failed", StringComparison.OrdinalIgnoreCase));
            }

            if (!apply)
            {
                updatedCount = updateTargets.Count;
            }

            return Task.FromResult<object>(new
            {
                status = !apply ? "Dry Run" : verificationFailedCount > 0 ? "Verification Failed" : "Applied",
                dryRun = !apply,
                parameterName,
                requestedValue = nextValue,
                onlyWhenBlank,
                matchedCount = matched.Count,
                updateCandidateCount = updateTargets.Count,
                updatedCount,
                verifiedCount,
                skippedCount,
                failedCount,
                verificationPerformed = apply && updateTargets.Count > 0,
                verificationFailedCount,
                requiredConfirm,
                confirmReceived,
                rows,
                warnings
            });
        }

        private static void ApplyQueryAliases(Params p)
        {
            if (p == null) return;
            if (string.IsNullOrWhiteSpace(p.category) && (p.categories == null || p.categories.Count == 0) && p.query != null)
            {
                var elementType = ReadQueryString(p.query, "elementType")
                    ?? ReadQueryString(p.query, "element_type")
                    ?? ReadQueryString(p.query, "category");
                if (IsSheetsAlias(elementType))
                {
                    p.category = "OST_Sheets";
                }
            }

            if (IsSheetsAlias(p.category))
            {
                p.category = "OST_Sheets";
            }
        }

        private static string? ReadQueryString(Dictionary<string, JsonElement> query, string key)
        {
            if (query == null || !query.TryGetValue(key, out var value)) return null;
            try
            {
                return value.ValueKind == JsonValueKind.String ? value.GetString() : value.ToString();
            }
            catch
            {
                return null;
            }
        }

        private static bool IsSheetsAlias(string? value)
        {
            var text = $"{value ?? ""}".Trim().ToLowerInvariant();
            return text == "sheets" || text == "sheet" || text == "viewsheet" || text == "view sheets";
        }

        private static string? CoerceConfirmText(object? confirm)
        {
            if (confirm == null) return null;
            if (confirm is string s) return s;
            if (confirm is bool b) return b ? "true" : "false";
            if (confirm is JsonElement el)
            {
                try
                {
                    return el.ValueKind switch
                    {
                        JsonValueKind.String => el.GetString(),
                        JsonValueKind.True => "true",
                        JsonValueKind.False => "false",
                        JsonValueKind.Number => el.GetRawText(),
                        _ => null
                    };
                }
                catch
                {
                    return null;
                }
            }
            return $"{confirm}".Trim();
        }

        private static bool TryMatchElement(Document doc, Element element, Params p, out string label, out string? matchSource, out string? familyName, out string? typeName)
        {
            label = element?.Name ?? "";
            matchSource = "Element.Name";
            familyName = null;
            typeName = null;

            if (!TryGetTypeInfo(doc, element, out typeName, out familyName))
            {
                typeName = null;
                familyName = null;
            }

            if (!string.IsNullOrWhiteSpace(p.typeNameContains) &&
                (typeName ?? "").IndexOf(p.typeNameContains.Trim(), StringComparison.OrdinalIgnoreCase) < 0)
            {
                return false;
            }

            if (!string.IsNullOrWhiteSpace(p.familyNameContains) &&
                (familyName ?? "").IndexOf(p.familyNameContains.Trim(), StringComparison.OrdinalIgnoreCase) < 0)
            {
                return false;
            }

            var candidates = BuildMatchCandidates(element, p.matchParameterNames);
            var startsWith = $"{p.matchStartsWith ?? ""}".Trim();
            var contains = $"{p.matchContains ?? ""}".Trim();

            if (startsWith.Length == 0 && contains.Length == 0)
            {
                var first = candidates.FirstOrDefault();
                if (first.text.Length > 0)
                {
                    label = first.text;
                    matchSource = first.source;
                }
                return true;
            }

            foreach (var candidate in candidates)
            {
                if (startsWith.Length > 0 && !candidate.text.StartsWith(startsWith, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (contains.Length > 0 && candidate.text.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                label = candidate.text;
                matchSource = candidate.source;
                return true;
            }

            return false;
        }

        private static List<(string text, string source)> BuildMatchCandidates(Element element, List<string>? matchParameterNames)
        {
            var results = new List<(string text, string source)>();
            void Add(string? text, string source)
            {
                var normalized = $"{text ?? ""}".Trim();
                if (normalized.Length == 0) return;
                if (results.Any(x => string.Equals(x.text, normalized, StringComparison.OrdinalIgnoreCase))) return;
                results.Add((normalized, source));
            }

            Add(element?.Name, "Element.Name");
            Add(TryGetMark(element), "Mark");

            foreach (var parameterName in matchParameterNames ?? new List<string>())
            {
                var normalizedName = $"{parameterName ?? ""}".Trim();
                if (normalizedName.Length == 0) continue;
                try
                {
                    var parameter = element.LookupParameter(normalizedName);
                    Add(ParameterValueToText(parameter), $"Parameter:{normalizedName}");
                }
                catch
                {
                    // best effort
                }
            }

            return results;
        }

        private static bool IsBlankParameter(Parameter parameter, object beforeSnapshot)
        {
            try
            {
                if (parameter == null) return true;
                if (!parameter.HasValue) return true;
            }
            catch
            {
                // best effort
            }

            var text = ExtractSnapshotValueString(beforeSnapshot);
            return string.IsNullOrWhiteSpace(text);
        }

        private static string? ParameterValueToText(Parameter? parameter)
        {
            if (parameter == null) return null;
            try
            {
                var direct = parameter.AsString() ?? parameter.AsValueString();
                if (!string.IsNullOrWhiteSpace(direct)) return direct;
                return ExtractSnapshotValueString(ParameterValueUtil.SnapshotForWire(parameter));
            }
            catch
            {
                return null;
            }
        }

        private static string? TryGetMark(Element element)
        {
            try
            {
                return element.get_Parameter(BuiltInParameter.ALL_MODEL_MARK)?.AsString()
                    ?? element.LookupParameter("Mark")?.AsString();
            }
            catch
            {
                return null;
            }
        }

        private static bool TryGetTypeInfo(Document doc, Element element, out string? typeName, out string? familyName)
        {
            typeName = null;
            familyName = null;
            try
            {
                var typeId = element.GetTypeId();
                if (typeId == ElementId.InvalidElementId) return false;
                var type = doc.GetElement(typeId) as ElementType;
                if (type == null) return false;
                typeName = type.Name;
                familyName = type is FamilySymbol symbol ? symbol.FamilyName : type.FamilyName;
                return true;
            }
            catch
            {
                return false;
            }
        }

        private static string? ExtractSnapshotValueString(object snapshot)
        {
            try
            {
                var json = JsonSerializer.Serialize(snapshot);
                using var doc = JsonDocument.Parse(json);
                if (doc.RootElement.TryGetProperty("valueString", out var valueString) && valueString.ValueKind == JsonValueKind.String)
                {
                    return valueString.GetString();
                }
                if (doc.RootElement.TryGetProperty("value", out var value))
                {
                    return value.ValueKind switch
                    {
                        JsonValueKind.String => value.GetString(),
                        JsonValueKind.Number => value.GetRawText(),
                        JsonValueKind.True => "true",
                        JsonValueKind.False => "false",
                        _ => null
                    };
                }
            }
            catch
            {
                // best effort
            }
            return null;
        }

        private static Parameter? ResolveParameter(Document doc, long elementId, string parameterName)
        {
            try
            {
                var element = doc.GetElement(ElementIdCompat.Create(elementId));
                return element?.LookupParameter(parameterName);
            }
            catch
            {
                return null;
            }
        }

        private static string GetAnonymousString(object row, string propertyName)
        {
            try
            {
                var value = row.GetType().GetProperty(propertyName)?.GetValue(row);
                return $"{value ?? ""}".Trim();
            }
            catch
            {
                return "";
            }
        }

        private static long GetAnonymousLong(object row, string propertyName)
        {
            try
            {
                var value = row.GetType().GetProperty(propertyName)?.GetValue(row);
                return value is long l ? l : Convert.ToInt64(value ?? 0);
            }
            catch
            {
                return 0;
            }
        }

        private static object? GetAnonymousValue(object row, string propertyName)
        {
            try
            {
                return row.GetType().GetProperty(propertyName)?.GetValue(row);
            }
            catch
            {
                return null;
            }
        }
    }
}
