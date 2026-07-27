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
    /// <summary>
    /// Resolves a user-visible schedule row and field to one backing Revit parameter,
    /// then optionally updates it. Grouped schedules are resolved through their backing
    /// elements and remain writable only when the row key yields one unique editable
    /// parameter; duplicate identifiers, calculated fields, and read-only data fail closed.
    /// </summary>
    public sealed class UpdateScheduleCellHandler : IRequestHandler
    {
        public sealed class Params
        {
            public long? scheduleId { get; set; }
            public string? scheduleQuery { get; set; }
            public bool? scheduleExact { get; set; }
            public string? rowKey { get; set; }
            public string? rowField { get; set; }
            public string? targetField { get; set; }
            public string? expectedValue { get; set; }
            public string? value { get; set; }
            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public int? maxSchedules { get; set; }
        }

        private sealed class FieldRef
        {
            public ScheduleField Field { get; set; } = null!;
            public string Name { get; set; } = "";
            public string Heading { get; set; } = "";
            public ElementId ParameterId { get; set; } = ElementId.InvalidElementId;
        }

        private sealed class ParameterRef
        {
            public Element Owner { get; set; } = null!;
            public Parameter Parameter { get; set; } = null!;
            public string OwnerKind { get; set; } = "instance";
        }

        private sealed class Candidate
        {
            public ViewSchedule Schedule { get; set; } = null!;
            public Element SourceElement { get; set; } = null!;
            public FieldRef RowField { get; set; } = null!;
            public ParameterRef RowParameter { get; set; } = null!;
            public FieldRef TargetField { get; set; } = null!;
            public ParameterRef TargetParameter { get; set; } = null!;
        }

        private sealed class ScheduleDiagnostic
        {
            public long ScheduleId { get; set; }
            public string ScheduleName { get; set; } = "";
            public long RawCategoryId { get; set; }
            public bool InferredMultiCategory { get; set; }
            public bool IsItemized { get; set; }
            public bool IsKeySchedule { get; set; }
            public bool IsMaterialTakeoff { get; set; }
            public bool HasEmbeddedSchedule { get; set; }
            public bool IsEmbedded { get; set; }
            public bool IncludeLinkedFiles { get; set; }
            public bool IsFilteredBySheet { get; set; }
            public int DisplayedRowMatchCount { get; set; }
            public int? ScheduleFilteredElementCount { get; set; }
            public int RowParameterResolvedCount { get; set; }
            public int RowValueMatchCount { get; set; }
            public int TargetParameterResolvedCount { get; set; }
            public int TargetParameterMissingCount { get; set; }
            public bool BackingOwnerUnproven { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var rowKey = (p.rowKey ?? "").Trim();
            var targetField = (p.targetField ?? "").Trim();
            var requestedValue = (p.value ?? "").Trim();
            if (rowKey.Length == 0) throw new InvalidOperationException("update-schedule-cell.rowKey is required.");
            if (targetField.Length == 0) throw new InvalidOperationException("update-schedule-cell.targetField is required.");
            if (requestedValue.Length == 0) throw new InvalidOperationException("update-schedule-cell.value is required.");

            var issues = new List<object>();
            var schedules = ResolveSchedules(doc, p, issues);
            var candidates = new List<Candidate>();
            var visibleRowMatches = new List<object>();
            var targetFieldSuggestions = new List<string>();
            var scheduleDiagnostics = new List<ScheduleDiagnostic>();
            foreach (var schedule in schedules)
            {
                ResolveCandidates(doc, schedule, p, rowKey, targetField, candidates, issues, visibleRowMatches, targetFieldSuggestions, scheduleDiagnostics);
            }

            candidates = candidates
                .GroupBy(c => string.Join(":", new[]
                {
                    ElementIdCompat.GetValue(c.TargetParameter.Owner.Id).ToString(),
                    ElementIdCompat.GetValue(c.TargetParameter.Parameter.Id).ToString()
                }), StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();

            var evidence = candidates.Select(BuildCandidateEvidence).ToList();
            if (candidates.Count == 0)
            {
                var visibleRowFound = visibleRowMatches.Count > 0;
                var suggestions = targetFieldSuggestions
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Take(6)
                    .ToList();
                var blockedReason = visibleRowFound
                    ? $"The schedule visibly contains row '{rowKey}', but Revit did not expose one editable backing parameter for '{targetField}'; no write was attempted."
                    : "No unique editable schedule-backed cell matched the requested row and field.";
                var clarificationQuestion = suggestions.Count > 0
                    ? $"I could not find a column named '{targetField}'. Did you mean {FormatAlternatives(suggestions)}?"
                    : visibleRowFound
                        ? $"Which exact model element and backing parameter should I use for '{rowKey}', or should I update a different schedule column?"
                        : $"Which exact schedule row and column should I update for '{rowKey}'?";
                return Task.FromResult<object>(new
                {
                    status = visibleRowFound ? "Blocked" : "Not Found",
                    applied = false,
                    blockedReason,
                    clarificationQuestion,
                    schedulesScanned = schedules.Count,
                    candidateCount = 0,
                    candidates = evidence,
                    visibleRowMatches,
                    targetFieldSuggestions = suggestions,
                    scheduleDiagnostics,
                    issues
                });
            }
            if (candidates.Count != 1)
            {
                return Task.FromResult<object>(new
                {
                    status = "Ambiguous",
                    applied = false,
                    blockedReason = "The requested row and field resolved to multiple schedule-backed parameters; no write was attempted.",
                    schedulesScanned = schedules.Count,
                    candidateCount = candidates.Count,
                    candidates = evidence,
                    issues
                });
            }

            var candidate = candidates[0];
            var parameter = candidate.TargetParameter.Parameter;
            if (candidate.TargetParameter.OwnerKind == "type")
            {
                var affectedInstances = CountInstancesOfType(doc, candidate.TargetParameter.Owner.Id, 51);
                if (affectedInstances > 1)
                {
                    return Task.FromResult<object>(new
                    {
                        status = "Blocked",
                        applied = false,
                        blockedReason = $"The resolved target is a type parameter shared by {affectedInstances}{(affectedInstances >= 51 ? "+" : "")} instances; a one-row update would change other elements.",
                        candidate = BuildCandidateEvidence(candidate),
                        affectedInstanceCount = affectedInstances,
                        issues
                    });
                }
            }
            var beforeRaw = ReadRawValue(parameter);
            var beforeDisplay = ReadDisplayValue(parameter);
            var expected = (p.expectedValue ?? "").Trim();
            if (expected.Length > 0 && !ScheduleCellUpdatePolicy.ValueMatches(expected, beforeRaw, beforeDisplay))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    blockedReason = "The current scheduled value does not match the expected old value; no write was attempted.",
                    schedulesScanned = schedules.Count,
                    candidateCount = 1,
                    candidate = BuildCandidateEvidence(candidate),
                    expectedValue = expected,
                    observedValue = beforeDisplay ?? beforeRaw,
                    issues
                });
            }
            if (parameter.IsReadOnly)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    blockedReason = "The resolved schedule field is read-only.",
                    candidate = BuildCandidateEvidence(candidate),
                    issues
                });
            }

            var isDryRun = (p.dryRun ?? false) || p.apply != true;
            var setSucceeded = false;
            var changed = false;
            string? setError = null;
            string? proposedRaw = null;
            string? proposedDisplay = null;
            using (var transaction = new Transaction(doc, "Update Schedule Cell"))
            {
                transaction.Start();
                setSucceeded = TrySetDisplayValue(parameter, requestedValue, out changed, out setError);
                if (setSucceeded)
                {
                    try { doc.Regenerate(); } catch { }
                    proposedRaw = ReadRawValue(parameter);
                    proposedDisplay = ReadDisplayValue(parameter);
                }
                if (isDryRun || !setSucceeded) transaction.RollBack();
                else transaction.Commit();
            }

            if (!setSucceeded)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    blockedReason = setError ?? "Revit rejected the requested schedule value.",
                    candidate = BuildCandidateEvidence(candidate),
                    before = new { raw = beforeRaw, display = beforeDisplay },
                    requestedValue,
                    issues
                });
            }

            if (isDryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    applied = false,
                    changed,
                    candidate = BuildCandidateEvidence(candidate),
                    before = new { raw = beforeRaw, display = beforeDisplay },
                    proposed = new { raw = proposedRaw, display = proposedDisplay },
                    requestedValue,
                    issues
                });
            }

            try { doc.Regenerate(); } catch { }
            try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }
            var committed = ResolveParameter(doc, candidate.TargetParameter.Owner.Id, candidate.TargetParameter.Parameter.Id);
            var afterRaw = committed == null ? null : ReadRawValue(committed);
            var afterDisplay = committed == null ? null : ReadDisplayValue(committed);
            var verified = committed != null && ScheduleCellUpdatePolicy.ValueMatches(requestedValue, afterRaw, afterDisplay);
            return Task.FromResult<object>(new
            {
                status = verified ? "Applied and Verified" : "Applied With Verification Failure",
                dryRun = false,
                applied = true,
                changed,
                verified,
                verificationFailedCount = verified ? 0 : 1,
                candidate = BuildCandidateEvidence(candidate),
                before = new { raw = beforeRaw, display = beforeDisplay },
                after = new { raw = afterRaw, display = afterDisplay },
                requestedValue,
                issues
            });
        }

        private static List<ViewSchedule> ResolveSchedules(Document doc, Params p, List<object> issues)
        {
            if (p.scheduleId.HasValue && p.scheduleId.Value > 0)
            {
                var schedule = doc.GetElement(ElementIdCompat.Create(p.scheduleId.Value)) as ViewSchedule;
                if (schedule == null) issues.Add(new { code = "schedule_not_found", scheduleId = p.scheduleId.Value });
                return schedule == null ? new List<ViewSchedule>() : new List<ViewSchedule> { schedule };
            }

            var query = (p.scheduleQuery ?? "").Trim();
            var exact = p.scheduleExact ?? false;
            var max = Math.Max(1, Math.Min(500, p.maxSchedules ?? 200));
            return ScheduleSelectionHelper.CollectSchedules(doc)
                .Where(schedule => !schedule.IsTemplate)
                .Where(schedule => query.Length == 0 || (exact
                    ? string.Equals(schedule.Name, query, StringComparison.OrdinalIgnoreCase)
                    : (schedule.Name ?? "").IndexOf(query, StringComparison.OrdinalIgnoreCase) >= 0))
                .OrderBy(schedule => schedule.Name, StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();
        }

        private static void ResolveCandidates(
            Document doc,
            ViewSchedule schedule,
            Params p,
            string rowKey,
            string requestedTargetField,
            List<Candidate> candidates,
            List<object> issues,
            List<object> visibleRowMatches,
            List<string> targetFieldSuggestions,
            List<ScheduleDiagnostic> scheduleDiagnostics)
        {
            var isGroupedSchedule = !schedule.Definition.IsItemized;
            var candidateCountBeforeSchedule = candidates.Count;
            var categoryId = SafeCategoryId(schedule.Definition);
            var diagnostic = new ScheduleDiagnostic
            {
                ScheduleId = ElementIdCompat.GetValue(schedule.Id),
                ScheduleName = schedule.Name ?? "",
                RawCategoryId = ElementIdCompat.GetValue(categoryId),
                InferredMultiCategory = categoryId == ElementId.InvalidElementId,
                IsItemized = schedule.Definition.IsItemized,
                IsKeySchedule = SafeBool(() => schedule.Definition.IsKeySchedule),
                IsMaterialTakeoff = SafeBool(() => schedule.Definition.IsMaterialTakeoff),
                HasEmbeddedSchedule = SafeBool(() => schedule.Definition.HasEmbeddedSchedule),
                IsEmbedded = SafeBool(() => schedule.Definition.IsEmbedded),
                IncludeLinkedFiles = SafeBool(() => schedule.Definition.IncludeLinkedFiles),
                IsFilteredBySheet = SafeBool(() => schedule.Definition.IsFilteredBySheet)
            };
            scheduleDiagnostics.Add(diagnostic);

            var fields = ScheduleSelectionHelper.GetFields(schedule).Select(field => new FieldRef
            {
                Field = field,
                Name = ScheduleSelectionHelper.ReadFieldName(field, doc) ?? "",
                Heading = SafeHeading(field),
                ParameterId = SafeParameterId(field)
            }).ToList();
            var targetFields = fields.Where(field => ScheduleCellUpdatePolicy.FieldNameMatches(requestedTargetField, field.Name, field.Heading)).ToList();
            if (targetFields.Count != 1)
            {
                var suggestions = targetFields.Count == 0
                    ? SuggestTargetFields(requestedTargetField, fields)
                    : targetFields;
                targetFieldSuggestions.AddRange(suggestions.Select(DisplayFieldName));
                // Reading every displayed cell in every schedule is expensive in large
                // production models. Only inspect table rows when this schedule has a
                // plausible target column; unrelated schedules cannot answer the user's
                // requested field and must not consume the mutation deadline.
                if (suggestions.Count > 0)
                {
                    diagnostic.DisplayedRowMatchCount = AddVisibleRowMatches(schedule, rowKey, visibleRowMatches);
                }
                diagnostic.BackingOwnerUnproven = diagnostic.DisplayedRowMatchCount > 0;
                issues.Add(new { code = targetFields.Count == 0 ? "target_field_not_found" : "target_field_ambiguous", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, targetField = requestedTargetField, matches = targetFields.Select(FieldEvidence).ToList(), suggestions = suggestions.Select(FieldEvidence).ToList() });
                return;
            }
            var targetField = targetFields[0];
            diagnostic.DisplayedRowMatchCount = AddVisibleRowMatches(schedule, rowKey, visibleRowMatches);
            if (targetField.ParameterId == ElementId.InvalidElementId)
            {
                issues.Add(new { code = "non_parameter_target_field", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, targetField = FieldEvidence(targetField), message = "Calculated, combined, count, and other non-parameter fields cannot be edited as backing parameters." });
                return;
            }

            var requestedRowField = (p.rowField ?? "").Trim();
            var rowFields = requestedRowField.Length > 0
                ? fields.Where(field => ScheduleCellUpdatePolicy.FieldNameMatches(requestedRowField, field.Name, field.Heading)).ToList()
                : fields.Where(field => ScheduleCellUpdatePolicy.IsLikelyIdentifierField(field.Name, field.Heading)).ToList();
            rowFields = rowFields.Where(field => field.ParameterId != ElementId.InvalidElementId).ToList();
            if (rowFields.Count == 0)
            {
                issues.Add(new { code = "row_identifier_field_not_found", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, rowField = requestedRowField.Length == 0 ? null : requestedRowField });
                return;
            }

            ICollection<Element> visibleElements;
            try
            {
                visibleElements = new FilteredElementCollector(doc, schedule.Id).WhereElementIsNotElementType().ToElements();
            }
            catch (Exception ex)
            {
                issues.Add(new { code = "schedule_elements_unavailable", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, message = ex.Message });
                return;
            }
            diagnostic.ScheduleFilteredElementCount = visibleElements.Count;

            var observedRowValues = new List<object>();
            foreach (var element in visibleElements)
            {
                foreach (var rowField in rowFields)
                {
                    var rowParameter = ResolveParameter(doc, element, rowField.ParameterId);
                    if (rowParameter == null) continue;
                    diagnostic.RowParameterResolvedCount++;
                    var rowRaw = ReadRawValue(rowParameter.Parameter);
                    var rowDisplay = ReadDisplayValue(rowParameter.Parameter);
                    if (observedRowValues.Count < 25)
                    {
                        observedRowValues.Add(new
                        {
                            elementId = ElementIdCompat.GetValue(element.Id),
                            field = DisplayFieldName(rowField),
                            raw = rowRaw,
                            display = rowDisplay,
                            ownerElementId = ElementIdCompat.GetValue(rowParameter.Owner.Id),
                            ownerKind = rowParameter.OwnerKind
                        });
                    }
                    if (!ScheduleCellUpdatePolicy.ValueMatches(rowKey, rowRaw, rowDisplay)) continue;
                    diagnostic.RowValueMatchCount++;
                    var targetParameter = ResolveParameter(doc, element, targetField.ParameterId);
                    if (targetParameter == null)
                    {
                        diagnostic.TargetParameterMissingCount++;
                        issues.Add(new { code = "target_parameter_missing", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, elementId = ElementIdCompat.GetValue(element.Id), targetField = FieldEvidence(targetField) });
                        continue;
                    }
                    diagnostic.TargetParameterResolvedCount++;
                    candidates.Add(new Candidate
                    {
                        Schedule = schedule,
                        SourceElement = element,
                        RowField = rowField,
                        RowParameter = rowParameter,
                        TargetField = targetField,
                        TargetParameter = targetParameter
                    });
                }
            }

            if (candidates.Count == candidateCountBeforeSchedule)
            {
                diagnostic.BackingOwnerUnproven = diagnostic.DisplayedRowMatchCount > 0;
                issues.Add(new
                {
                    code = "backing_row_key_not_found",
                    scheduleId = ElementIdCompat.GetValue(schedule.Id),
                    scheduleName = schedule.Name,
                    rowKey,
                    visibleElementCount = visibleElements.Count,
                    rowFields = rowFields.Select(FieldEvidence).ToList(),
                    observedRowValues
                });
            }

            if (isGroupedSchedule)
            {
                var resolvedCount = candidates.Count - candidateCountBeforeSchedule;
                issues.Add(new
                {
                    code = "grouped_schedule_backing_elements_evaluated",
                    scheduleId = ElementIdCompat.GetValue(schedule.Id),
                    scheduleName = schedule.Name,
                    resolvedCandidateCount = resolvedCount,
                    message = "The schedule is non-itemized, so the visible row may combine elements. The update remains allowed only if the requested row key resolves to one unique editable backing parameter; otherwise the handler fails closed."
                });
            }
        }

        private static ParameterRef? ResolveParameter(Document doc, Element source, ElementId parameterId)
        {
            var instance = FindParameter(source, parameterId);
            if (instance != null) return new ParameterRef { Owner = source, Parameter = instance, OwnerKind = "instance" };
            Element? type = null;
            try { type = doc.GetElement(source.GetTypeId()); } catch { }
            var typeParameter = type == null ? null : FindParameter(type, parameterId);
            return typeParameter == null ? null : new ParameterRef { Owner = type!, Parameter = typeParameter, OwnerKind = "type" };
        }

        private static Parameter? ResolveParameter(Document doc, ElementId ownerId, ElementId parameterId)
        {
            var owner = doc.GetElement(ownerId);
            return owner == null ? null : FindParameter(owner, parameterId);
        }

        private static Parameter? FindParameter(Element element, ElementId parameterId)
        {
            try
            {
                return element.Parameters.Cast<Parameter>().FirstOrDefault(parameter => parameter.Id == parameterId);
            }
            catch
            {
                return null;
            }
        }

        private static int CountInstancesOfType(Document doc, ElementId typeId, int limit)
        {
            var count = 0;
            try
            {
                foreach (var element in new FilteredElementCollector(doc).WhereElementIsNotElementType())
                {
                    ElementId? candidateType = null;
                    try { candidateType = element.GetTypeId(); } catch { }
                    if (candidateType != null && candidateType == typeId)
                    {
                        count++;
                        if (count >= limit) break;
                    }
                }
            }
            catch { return limit; }
            return count;
        }

        private static ElementId SafeParameterId(ScheduleField field)
        {
            try { return field.ParameterId ?? ElementId.InvalidElementId; }
            catch { return ElementId.InvalidElementId; }
        }

        private static ElementId SafeCategoryId(ScheduleDefinition definition)
        {
            try { return definition.CategoryId ?? ElementId.InvalidElementId; }
            catch { return ElementId.InvalidElementId; }
        }

        private static bool SafeBool(Func<bool> read)
        {
            try { return read(); }
            catch { return false; }
        }

        private static int AddVisibleRowMatches(ViewSchedule schedule, string rowKey, List<object> matches)
        {
            var beforeCount = matches.Count;
            try
            {
                var body = schedule.GetTableData().GetSectionData(SectionType.Body);
                var maxRows = Math.Min(body.LastRowNumber, body.FirstRowNumber + 499);
                var maxColumns = Math.Min(body.LastColumnNumber, body.FirstColumnNumber + 199);
                for (var row = body.FirstRowNumber; row <= maxRows && matches.Count < 25; row++)
                {
                    for (var column = body.FirstColumnNumber; column <= maxColumns && matches.Count < 25; column++)
                    {
                        string text;
                        try { text = body.GetCellText(row, column) ?? ""; }
                        catch { continue; }
                        if (!ScheduleCellUpdatePolicy.ValueMatches(rowKey, null, text)) continue;
                        matches.Add(new
                        {
                            scheduleId = ElementIdCompat.GetValue(schedule.Id),
                            scheduleName = schedule.Name,
                            rowIndex = row,
                            columnIndex = column,
                            displayedValue = text
                        });
                    }
                }
            }
            catch
            {
                // Visible-cell evidence is diagnostic only. Failure to read table data
                // must never broaden resolution or make a write look safe.
            }
            return matches.Count - beforeCount;
        }

        private static List<FieldRef> SuggestTargetFields(string requested, List<FieldRef> fields)
        {
            var normalized = ScheduleCellUpdatePolicy.NormalizeFieldName(requested);
            var airflowRequested = normalized.IndexOf("airflow", StringComparison.Ordinal) >= 0 ||
                                   normalized.IndexOf("cfm", StringComparison.Ordinal) >= 0;
            var suggestions = fields
                .Where(field =>
                {
                    var candidate = ScheduleCellUpdatePolicy.NormalizeFieldName(field.Name + " " + field.Heading);
                    if (candidate.Length == 0) return false;
                    if (airflowRequested && (candidate.IndexOf("airflow", StringComparison.Ordinal) >= 0 || candidate.IndexOf("cfm", StringComparison.Ordinal) >= 0)) return true;
                    return normalized.Length >= 4 && (candidate.Contains(normalized) || normalized.Contains(candidate));
                })
                .GroupBy(DisplayFieldName, StringComparer.OrdinalIgnoreCase)
                .Select(group => group.First())
                .Take(6)
                .ToList();
            return suggestions;
        }

        private static string DisplayFieldName(FieldRef field)
        {
            if (string.IsNullOrWhiteSpace(field.Heading)) return field.Name;
            if (ScheduleCellUpdatePolicy.NormalizeFieldName(field.Heading).Length < 4 && !string.IsNullOrWhiteSpace(field.Name)) return field.Name;
            return field.Heading;
        }

        private static string FormatAlternatives(List<string> values)
        {
            var quoted = values.Select(value => $"'{value}'").ToList();
            if (quoted.Count == 0) return "one of the available schedule columns";
            if (quoted.Count == 1) return quoted[0];
            if (quoted.Count == 2) return quoted[0] + " or " + quoted[1];
            return string.Join(", ", quoted.Take(quoted.Count - 1)) + ", or " + quoted.Last();
        }

        private static string SafeHeading(ScheduleField field)
        {
            try { return field.ColumnHeading ?? ""; }
            catch { return ""; }
        }

        private static string? ReadRawValue(Parameter parameter)
        {
            try
            {
                switch (parameter.StorageType)
                {
                    case StorageType.String: return parameter.AsString();
                    case StorageType.Integer: return parameter.AsInteger().ToString(System.Globalization.CultureInfo.InvariantCulture);
                    case StorageType.Double: return parameter.AsDouble().ToString("R", System.Globalization.CultureInfo.InvariantCulture);
                    case StorageType.ElementId: return ElementIdCompat.GetValue(parameter.AsElementId()).ToString(System.Globalization.CultureInfo.InvariantCulture);
                    default: return null;
                }
            }
            catch { return null; }
        }

        private static string? ReadDisplayValue(Parameter parameter)
        {
            try
            {
                var value = parameter.AsValueString();
                return string.IsNullOrWhiteSpace(value) ? ReadRawValue(parameter) : value;
            }
            catch { return ReadRawValue(parameter); }
        }

        private static bool TrySetDisplayValue(Parameter parameter, string value, out bool changed, out string? error)
        {
            changed = false;
            error = null;
            if (parameter.IsReadOnly)
            {
                error = "The resolved parameter is read-only.";
                return false;
            }
            var beforeRaw = ReadRawValue(parameter);
            var beforeDisplay = ReadDisplayValue(parameter);
            if (ScheduleCellUpdatePolicy.ValueMatches(value, beforeRaw, beforeDisplay)) return true;
            try
            {
                bool ok;
                if (parameter.StorageType == StorageType.String)
                {
                    ok = parameter.Set(value);
                }
                else if (parameter.StorageType == StorageType.Double || parameter.StorageType == StorageType.Integer)
                {
                    ok = parameter.SetValueString(value);
                    if (!ok && value.Contains(",")) ok = parameter.SetValueString(ScheduleCellUpdatePolicy.RemoveNumericGroupSeparators(value));
                }
                else
                {
                    error = $"Schedule field storage type '{parameter.StorageType}' is not supported for text-directed cell updates.";
                    return false;
                }
                if (!ok)
                {
                    error = "Revit rejected the requested display value. Include the schedule unit suffix if the field is unit-formatted.";
                    return false;
                }
                changed = !string.Equals(beforeRaw, ReadRawValue(parameter), StringComparison.Ordinal) ||
                          !string.Equals(beforeDisplay, ReadDisplayValue(parameter), StringComparison.Ordinal);
                return true;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
        }

        private static object FieldEvidence(FieldRef field)
        {
            return new
            {
                name = field.Name,
                heading = field.Heading,
                parameterId = ElementIdCompat.GetValue(field.ParameterId)
            };
        }

        private static object BuildCandidateEvidence(Candidate candidate)
        {
            return new
            {
                schedule = new { id = ElementIdCompat.GetValue(candidate.Schedule.Id), name = candidate.Schedule.Name },
                sourceElementId = ElementIdCompat.GetValue(candidate.SourceElement.Id),
                row = new
                {
                    field = FieldEvidence(candidate.RowField),
                    value = ReadDisplayValue(candidate.RowParameter.Parameter),
                    ownerElementId = ElementIdCompat.GetValue(candidate.RowParameter.Owner.Id),
                    ownerKind = candidate.RowParameter.OwnerKind
                },
                target = new
                {
                    field = FieldEvidence(candidate.TargetField),
                    parameterName = candidate.TargetParameter.Parameter.Definition?.Name,
                    value = ReadDisplayValue(candidate.TargetParameter.Parameter),
                    rawValue = ReadRawValue(candidate.TargetParameter.Parameter),
                    storageType = candidate.TargetParameter.Parameter.StorageType.ToString(),
                    readOnly = candidate.TargetParameter.Parameter.IsReadOnly,
                    ownerElementId = ElementIdCompat.GetValue(candidate.TargetParameter.Owner.Id),
                    ownerKind = candidate.TargetParameter.OwnerKind
                }
            };
        }
    }
}
