using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    /// <summary>
    /// Plans and applies literal replacements to host-model instance string parameters
    /// that back exact fields in schedules selected by explicit sheets or schedule ids.
    /// Apply is bound to the complete preflight plan hash and rolls back if any planned
    /// readback fails.
    /// </summary>
    public sealed class ReplaceScheduleValuesHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<string>? sheetNumbers { get; set; }
            public List<long>? scheduleIds { get; set; }
            public List<string>? fieldNames { get; set; }
            public string? valueContains { get; set; }
            public string? expectedValue { get; set; }
            public string? replaceFrom { get; set; }
            public string? replaceTo { get; set; }
            public string? expectedPlanHash { get; set; }
            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public int? maxSchedules { get; set; }
            public int? maxCandidates { get; set; }
            public int? maxChanges { get; set; }
        }

        private sealed class ScheduleRef
        {
            public long ScheduleId { get; set; }
            public string ScheduleName { get; set; } = "";
            public string? SheetNumber { get; set; }
            public string? SheetName { get; set; }
            public long? InstanceId { get; set; }
        }

        private sealed class Candidate
        {
            public Element SourceElement { get; set; } = null!;
            public Element Owner { get; set; } = null!;
            public Parameter Parameter { get; set; } = null!;
            public string OwnerKind { get; set; } = "instance";
            public string ParameterName { get; set; } = "";
            public string FieldName { get; set; } = "";
            public string FieldHeading { get; set; } = "";
            public string Before { get; set; } = "";
            public string After { get; set; } = "";
            public bool Writable { get; set; }
            public string? BlockedReason { get; set; }
            public List<ScheduleRef> Schedules { get; } = new List<ScheduleRef>();
        }

        private sealed class Discovery
        {
            public List<ScheduleRef> Schedules { get; } = new List<ScheduleRef>();
            public List<Candidate> Candidates { get; } = new List<Candidate>();
            public List<object> Issues { get; } = new List<object>();
            public bool Truncated { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active Revit document.");

            var sheetNumbers = NormalizeStrings(p.sheetNumbers, 50);
            var scheduleIds = (p.scheduleIds ?? new List<long>()).Where(id => id > 0).Distinct().Take(200).ToList();
            var fieldNames = NormalizeStrings(p.fieldNames, 20);
            if (fieldNames.Count == 0) fieldNames.AddRange(new[] { "DESIG.", "DESIG", "Designation" });
            var find = (p.replaceFrom ?? p.valueContains ?? "").Trim();
            var contains = (p.valueContains ?? find).Trim();
            var expectedValue = string.IsNullOrWhiteSpace(p.expectedValue) ? null : p.expectedValue;
            var replace = p.replaceTo ?? "";
            if (sheetNumbers.Count == 0 && scheduleIds.Count == 0)
                throw new InvalidOperationException("replace-schedule-values requires sheetNumbers or scheduleIds.");
            if (find.Length == 0 || contains.Length == 0)
                throw new InvalidOperationException("replace-schedule-values.valueContains and replaceFrom must be non-empty strings.");
            if (string.Equals(find, replace, StringComparison.Ordinal))
                throw new InvalidOperationException("replace-schedule-values.replaceFrom and replaceTo must differ.");

            var maxSchedules = Math.Max(1, Math.Min(500, p.maxSchedules ?? 200));
            var maxCandidates = Math.Max(1, Math.Min(10000, p.maxCandidates ?? 5000));
            var maxChanges = Math.Max(1, Math.Min(10000, p.maxChanges ?? maxCandidates));
            var discovery = Discover(doc, sheetNumbers, scheduleIds, fieldNames, contains, expectedValue, find, replace, maxSchedules, maxCandidates);
            var planHash = BuildPlanHash(sheetNumbers, scheduleIds, fieldNames, contains, expectedValue, find, replace, discovery.Candidates);
            var writable = discovery.Candidates.Where(candidate => candidate.Writable).ToList();
            var blocked = discovery.Candidates.Where(candidate => !candidate.Writable).ToList();

            if (writable.Count > maxChanges)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    verified = false,
                    blockedReason = $"The bounded request permits at most {maxChanges} writable change(s), but {writable.Count} were resolved; no write was attempted.",
                    planHash,
                    candidateCount = discovery.Candidates.Count,
                    writableCandidateCount = writable.Count,
                    blockedCandidateCount = blocked.Count,
                    candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }

            if (discovery.Truncated)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    verified = false,
                    blockedReason = $"More than {maxCandidates} matching schedule-backed values were found; no write was attempted.",
                    planHash,
                    schedulesScanned = discovery.Schedules.Count,
                    candidateCount = discovery.Candidates.Count,
                    writableCandidateCount = writable.Count,
                    blockedCandidateCount = blocked.Count,
                    candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }

            if (discovery.Candidates.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "No Matches",
                    dryRun = p.apply != true,
                    applied = false,
                    verified = true,
                    planHash,
                    schedulesScanned = discovery.Schedules.Count,
                    schedules = BuildScheduleEvidence(discovery.Schedules),
                    candidateCount = 0,
                    writableCandidateCount = 0,
                    blockedCandidateCount = 0,
                    remainingMatchCount = 0,
                    candidates = Array.Empty<object>(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }

            var dryRun = p.apply != true || p.dryRun == true;
            if (dryRun)
            {
                return Task.FromResult<object>(new
                {
                    status = "Dry Run",
                    dryRun = true,
                    applied = false,
                    verified = false,
                    planHash,
                    sheets = sheetNumbers,
                    fields = fieldNames,
                    valueContains = contains,
                    expectedValue,
                    replaceFrom = find,
                    replaceTo = replace,
                    schedulesScanned = discovery.Schedules.Count,
                    schedules = BuildScheduleEvidence(discovery.Schedules),
                    candidateCount = discovery.Candidates.Count,
                    writableCandidateCount = writable.Count,
                    blockedCandidateCount = blocked.Count,
                    candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }

            var expectedPlanHash = (p.expectedPlanHash ?? "").Trim();
            if (expectedPlanHash.Length == 0 || !string.Equals(expectedPlanHash, planHash, StringComparison.OrdinalIgnoreCase))
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    verified = false,
                    blockedReason = expectedPlanHash.Length == 0
                        ? "Apply requires expectedPlanHash from the exact dry-run plan."
                        : "The schedule-backed replacement plan changed after dry-run; no write was attempted.",
                    expectedPlanHash = expectedPlanHash.Length == 0 ? null : expectedPlanHash,
                    observedPlanHash = planHash,
                    candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }
            if (writable.Count == 0)
            {
                return Task.FromResult<object>(new
                {
                    status = "Blocked",
                    applied = false,
                    verified = false,
                    blockedReason = "Every matching schedule-backed value is read-only, type-owned, or otherwise outside the instance-write boundary.",
                    planHash,
                    candidateCount = discovery.Candidates.Count,
                    blockedCandidateCount = blocked.Count,
                    candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                    issues = discovery.Issues,
                    saveOrSyncPerformed = false
                });
            }

            var setErrors = new List<object>();
            var directVerificationFailures = new List<object>();
            Discovery? remaining = null;
            using (var group = new TransactionGroup(doc, "Replace Schedule Values"))
            {
                group.Start();
                using (var transaction = new Transaction(doc, "Replace Schedule Values"))
                {
                    transaction.Start();
                    foreach (var candidate in writable)
                    {
                        try
                        {
                            var current = candidate.Parameter.AsString() ?? "";
                            if (!string.Equals(current, candidate.Before, StringComparison.Ordinal))
                            {
                                setErrors.Add(new { elementId = ElementIdCompat.GetValue(candidate.SourceElement.Id), parameterName = candidate.ParameterName, error = "Current value changed after preflight." });
                                continue;
                            }
                            if (!candidate.Parameter.Set(candidate.After))
                                setErrors.Add(new { elementId = ElementIdCompat.GetValue(candidate.SourceElement.Id), parameterName = candidate.ParameterName, error = "Revit rejected the replacement value." });
                        }
                        catch (Exception ex)
                        {
                            setErrors.Add(new { elementId = ElementIdCompat.GetValue(candidate.SourceElement.Id), parameterName = candidate.ParameterName, error = ex.Message });
                        }
                    }
                    if (setErrors.Count > 0)
                    {
                        transaction.RollBack();
                        group.RollBack();
                        return Task.FromResult<object>(new
                        {
                            status = "Rolled Back",
                            applied = false,
                            verified = false,
                            blockedReason = "At least one planned schedule-backed parameter could not be set; the entire replacement transaction was rolled back.",
                            planHash,
                            errors = setErrors,
                            candidates = discovery.Candidates.Select(BuildEvidence).ToList(),
                            saveOrSyncPerformed = false
                        });
                    }
                    try { doc.Regenerate(); } catch { }
                    transaction.Commit();
                }

                foreach (var candidate in writable)
                {
                    var owner = doc.GetElement(candidate.Owner.Id);
                    var parameter = owner == null ? null : FindParameter(owner, candidate.Parameter.Id);
                    var after = parameter?.AsString() ?? "";
                    if (!string.Equals(after, candidate.After, StringComparison.Ordinal))
                        directVerificationFailures.Add(new { elementId = ElementIdCompat.GetValue(candidate.SourceElement.Id), ownerElementId = ElementIdCompat.GetValue(candidate.Owner.Id), parameterName = candidate.ParameterName, expected = candidate.After, observed = after });
                }
                remaining = Discover(doc, sheetNumbers, scheduleIds, fieldNames, contains, expectedValue, find, replace, maxSchedules, maxCandidates);
                if (directVerificationFailures.Count > 0 || remaining.Truncated || remaining.Candidates.Any(candidate => candidate.Writable))
                {
                    group.RollBack();
                    return Task.FromResult<object>(new
                    {
                        status = "Rolled Back",
                        applied = false,
                        verified = false,
                        blockedReason = "Committed readback did not verify every planned writable replacement; the transaction group was rolled back.",
                        planHash,
                        verificationFailures = directVerificationFailures,
                        remainingWritableMatchCount = remaining.Candidates.Count(candidate => candidate.Writable),
                        remainingMatches = remaining.Candidates.Select(BuildEvidence).ToList(),
                        saveOrSyncPerformed = false
                    });
                }
                group.Assimilate();
            }

            try { app.ActiveUIDocument?.RefreshActiveView(); } catch { }
            var unresolved = remaining?.Candidates ?? new List<Candidate>();
            var complete = unresolved.Count == 0;
            return Task.FromResult<object>(new
            {
                status = complete ? "Applied and Verified" : "Applied and Verified With Unresolved Matches",
                dryRun = false,
                applied = true,
                verified = true,
                complete,
                planHash,
                sheets = sheetNumbers,
                fields = fieldNames,
                valueContains = contains,
                expectedValue,
                replaceFrom = find,
                replaceTo = replace,
                schedulesScanned = discovery.Schedules.Count,
                schedules = BuildScheduleEvidence(discovery.Schedules),
                candidateCount = discovery.Candidates.Count,
                changedCount = writable.Count,
                blockedCandidateCount = blocked.Count,
                remainingMatchCount = unresolved.Count,
                verificationFailedCount = 0,
                changed = writable.Select(BuildChangedEvidence).ToList(),
                unresolvedMatches = unresolved.Select(BuildEvidence).ToList(),
                issues = discovery.Issues,
                saveOrSyncPerformed = false
            });
        }

        private static Discovery Discover(
            Document doc,
            IReadOnlyCollection<string> sheetNumbers,
            IReadOnlyCollection<long> explicitScheduleIds,
            IReadOnlyCollection<string> fieldNames,
            string contains,
            string? expectedValue,
            string find,
            string replace,
            int maxSchedules,
            int maxCandidates)
        {
            var output = new Discovery();
            var schedules = new Dictionary<long, ViewSchedule>();
            var refsBySchedule = new Dictionary<long, List<ScheduleRef>>();
            var sheets = new FilteredElementCollector(doc).OfClass(typeof(ViewSheet)).Cast<ViewSheet>()
                .Where(sheet => !sheet.IsTemplate)
                .ToList();
            foreach (var requested in sheetNumbers)
            {
                var matchingSheets = sheets.Where(sheet => string.Equals((sheet.SheetNumber ?? "").Trim(), requested, StringComparison.OrdinalIgnoreCase)).ToList();
                if (matchingSheets.Count == 0)
                {
                    output.Issues.Add(new { code = "sheet_not_found", sheetNumber = requested });
                    continue;
                }
                foreach (var sheet in matchingSheets)
                {
                    foreach (var instance in new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
                    {
                        var schedule = doc.GetElement(instance.ScheduleId) as ViewSchedule;
                        if (schedule == null || schedule.IsTemplate || ScheduleSelectionHelper.IsTitleblockRevisionSchedule(schedule)) continue;
                        var scheduleId = ElementIdCompat.GetValue(schedule.Id);
                        schedules[scheduleId] = schedule;
                        if (!refsBySchedule.TryGetValue(scheduleId, out var refs)) refsBySchedule[scheduleId] = refs = new List<ScheduleRef>();
                        AddScheduleRef(refs, schedule, sheet, instance);
                    }
                }
            }
            foreach (var id in explicitScheduleIds)
            {
                var schedule = doc.GetElement(ElementIdCompat.Create(id)) as ViewSchedule;
                if (schedule == null || schedule.IsTemplate || ScheduleSelectionHelper.IsTitleblockRevisionSchedule(schedule))
                {
                    output.Issues.Add(new { code = "schedule_not_found", scheduleId = id });
                    continue;
                }
                schedules[id] = schedule;
                if (!refsBySchedule.TryGetValue(id, out var refs)) refsBySchedule[id] = refs = new List<ScheduleRef>();
                AddPlacementRefs(doc, sheets, schedule, refs);
                if (refs.Count == 0) refs.Add(new ScheduleRef { ScheduleId = id, ScheduleName = schedule.Name ?? "" });
            }

            var selectedSchedules = schedules.Values.OrderBy(schedule => schedule.Name, StringComparer.OrdinalIgnoreCase).ThenBy(schedule => ElementIdCompat.GetValue(schedule.Id)).Take(maxSchedules).ToList();
            if (schedules.Count > maxSchedules) output.Issues.Add(new { code = "schedule_limit_exceeded", requested = schedules.Count, maxSchedules });
            foreach (var schedule in selectedSchedules)
            {
                var scheduleId = ElementIdCompat.GetValue(schedule.Id);
                if (!refsBySchedule.TryGetValue(scheduleId, out var refs)) refs = new List<ScheduleRef> { new ScheduleRef { ScheduleId = scheduleId, ScheduleName = schedule.Name ?? "" } };
                output.Schedules.AddRange(refs);
            }

            var candidates = new Dictionary<string, Candidate>(StringComparer.Ordinal);
            foreach (var schedule in selectedSchedules)
            {
                var availableFields = ScheduleSelectionHelper.GetFields(schedule)
                    .Where(field => !SafeIsHidden(field))
                    .Select(field => new
                    {
                        Field = field,
                        Name = ScheduleSelectionHelper.ReadFieldName(field, doc) ?? "",
                        Heading = SafeHeading(field),
                        ParameterId = SafeParameterId(field)
                    })
                    .Where(field => field.ParameterId != ElementId.InvalidElementId)
                    .ToList();
                var selectedFieldName = ScheduleValueReplacementPolicy.FirstMatchingRequestedName(
                    fieldNames,
                    availableFields.Select(field => ((string?)field.Name, (string?)field.Heading)));
                var fields = selectedFieldName == null
                    ? availableFields.Take(0).ToList()
                    : availableFields
                        .Where(field => ScheduleValueReplacementPolicy.FieldNameMatchesAny(field.Name, field.Heading, new[] { selectedFieldName }))
                        .ToList();
                if (fields.Count == 0) continue;

                ICollection<Element> visibleElements;
                try { visibleElements = new FilteredElementCollector(doc, schedule.Id).WhereElementIsNotElementType().ToElements(); }
                catch (Exception ex)
                {
                    output.Issues.Add(new { code = "schedule_elements_unavailable", scheduleId = ElementIdCompat.GetValue(schedule.Id), scheduleName = schedule.Name, message = ex.Message });
                    continue;
                }
                foreach (var element in visibleElements)
                {
                    foreach (var field in fields)
                    {
                        var owner = element;
                        var ownerKind = "instance";
                        var parameter = FindParameter(element, field.ParameterId);
                        if (parameter == null)
                        {
                            Element? type = null;
                            try { type = doc.GetElement(element.GetTypeId()); } catch { }
                            var typeParameter = type == null ? null : FindParameter(type, field.ParameterId);
                            if (typeParameter == null) continue;
                            owner = type!;
                            ownerKind = "type";
                            parameter = typeParameter;
                        }
                        if (parameter.StorageType != StorageType.String) continue;
                        var before = parameter.AsString() ?? "";
                        if (before.IndexOf(contains, StringComparison.Ordinal) < 0) continue;
                        if (expectedValue != null && !string.Equals(before, expectedValue, StringComparison.Ordinal)) continue;
                        if (!ScheduleValueReplacementPolicy.TryBuildLiteralReplacement(before, find, replace, out var after)) continue;
                        var ownerId = ElementIdCompat.GetValue(owner.Id);
                        var key = ownerId + ":" + ElementIdCompat.GetValue(parameter.Id);
                        if (!candidates.TryGetValue(key, out var candidate))
                        {
                            candidate = new Candidate
                            {
                                SourceElement = element,
                                Owner = owner,
                                Parameter = parameter,
                                OwnerKind = ownerKind,
                                ParameterName = parameter.Definition?.Name ?? field.Name,
                                FieldName = field.Name,
                                FieldHeading = field.Heading,
                                Before = before,
                                After = after,
                                Writable = ownerKind == "instance" && !parameter.IsReadOnly,
                                BlockedReason = ownerKind == "type" ? "Type-owned schedule values are outside the instance-write boundary." : parameter.IsReadOnly ? "The backing instance parameter is read-only." : null
                            };
                            candidates[key] = candidate;
                        }
                        var scheduleId = ElementIdCompat.GetValue(schedule.Id);
                        if (!refsBySchedule.TryGetValue(scheduleId, out var scheduleRefs)) scheduleRefs = new List<ScheduleRef> { new ScheduleRef { ScheduleId = scheduleId, ScheduleName = schedule.Name ?? "" } };
                        foreach (var scheduleRef in scheduleRefs)
                        {
                            if (!candidate.Schedules.Any(existing => existing.ScheduleId == scheduleRef.ScheduleId && existing.InstanceId == scheduleRef.InstanceId && string.Equals(existing.SheetNumber, scheduleRef.SheetNumber, StringComparison.OrdinalIgnoreCase)))
                                candidate.Schedules.Add(scheduleRef);
                        }
                        if (candidates.Count > maxCandidates)
                        {
                            output.Truncated = true;
                            break;
                        }
                    }
                    if (output.Truncated) break;
                }
                if (output.Truncated) break;
            }
            output.Candidates.AddRange(candidates.Values.OrderBy(candidate => ElementIdCompat.GetValue(candidate.Owner.Id)).ThenBy(candidate => ElementIdCompat.GetValue(candidate.Parameter.Id)));
            return output;
        }

        private static string BuildPlanHash(
            IReadOnlyCollection<string> sheets,
            IReadOnlyCollection<long> scheduleIds,
            IReadOnlyCollection<string> fields,
            string contains,
            string? expectedValue,
            string find,
            string replace,
            IReadOnlyCollection<Candidate> candidates)
        {
            var lines = new List<string>
            {
                "sheets=" + string.Join(",", sheets.OrderBy(value => value, StringComparer.OrdinalIgnoreCase)),
                "scheduleIds=" + string.Join(",", scheduleIds.OrderBy(value => value)),
                "fields=" + string.Join(",", fields.Select(ScheduleCellUpdatePolicy.NormalizeFieldName).OrderBy(value => value, StringComparer.Ordinal)),
                "contains=" + contains,
                "expected=" + (expectedValue ?? ""),
                "find=" + find,
                "replace=" + replace
            };
            lines.AddRange(candidates.OrderBy(candidate => ElementIdCompat.GetValue(candidate.Owner.Id)).ThenBy(candidate => ElementIdCompat.GetValue(candidate.Parameter.Id)).Select(candidate => string.Join("|", new[]
            {
                ElementIdCompat.GetValue(candidate.SourceElement.Id).ToString(),
                ElementIdCompat.GetValue(candidate.Owner.Id).ToString(),
                ElementIdCompat.GetValue(candidate.Parameter.Id).ToString(),
                candidate.OwnerKind,
                candidate.ParameterName,
                candidate.Before,
                candidate.After,
                candidate.Writable ? "writable" : "blocked",
                string.Join(",", candidate.Schedules.OrderBy(reference => reference.ScheduleId).ThenBy(reference => reference.InstanceId ?? 0).Select(reference => $"{reference.SheetNumber}:{reference.ScheduleId}:{reference.InstanceId}"))
            })));
            using (var sha = SHA256.Create())
            {
                var bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(string.Join("\n", lines)));
                return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant();
            }
        }

        private static object BuildEvidence(Candidate candidate)
        {
            return new
            {
                sourceElementId = ElementIdCompat.GetValue(candidate.SourceElement.Id),
                ownerElementId = ElementIdCompat.GetValue(candidate.Owner.Id),
                ownerKind = candidate.OwnerKind,
                category = candidate.SourceElement.Category?.Name,
                familyName = ReadFamilyName(candidate.SourceElement),
                typeName = ReadTypeName(candidate.SourceElement),
                parameterId = ElementIdCompat.GetValue(candidate.Parameter.Id),
                parameterName = candidate.ParameterName,
                fieldName = candidate.FieldName,
                fieldHeading = candidate.FieldHeading,
                before = candidate.Before,
                after = candidate.After,
                writable = candidate.Writable,
                blockedReason = candidate.BlockedReason,
                schedules = BuildScheduleEvidence(candidate.Schedules)
            };
        }

        private static object BuildChangedEvidence(Candidate candidate)
        {
            return new
            {
                elementId = ElementIdCompat.GetValue(candidate.SourceElement.Id),
                category = candidate.SourceElement.Category?.Name,
                familyName = ReadFamilyName(candidate.SourceElement),
                typeName = ReadTypeName(candidate.SourceElement),
                parameterName = candidate.ParameterName,
                before = candidate.Before,
                after = candidate.After,
                schedules = BuildScheduleEvidence(candidate.Schedules)
            };
        }

        private static List<object> BuildScheduleEvidence(IEnumerable<ScheduleRef> schedules)
        {
            return schedules
                .OrderBy(reference => reference.SheetNumber, StringComparer.OrdinalIgnoreCase)
                .ThenBy(reference => reference.ScheduleName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(reference => reference.InstanceId ?? 0)
                .Select(reference => (object)new { sheetNumber = reference.SheetNumber, sheetName = reference.SheetName, scheduleId = reference.ScheduleId, scheduleName = reference.ScheduleName, instanceId = reference.InstanceId })
                .ToList();
        }

        private static void AddPlacementRefs(Document doc, IEnumerable<ViewSheet> sheets, ViewSchedule schedule, List<ScheduleRef> refs)
        {
            foreach (var sheet in sheets)
            {
                foreach (var instance in new FilteredElementCollector(doc, sheet.Id).OfClass(typeof(ScheduleSheetInstance)).Cast<ScheduleSheetInstance>())
                {
                    if (instance.ScheduleId != schedule.Id) continue;
                    AddScheduleRef(refs, schedule, sheet, instance);
                }
            }
        }

        private static void AddScheduleRef(List<ScheduleRef> refs, ViewSchedule schedule, ViewSheet sheet, ScheduleSheetInstance instance)
        {
            var scheduleId = ElementIdCompat.GetValue(schedule.Id);
            var instanceId = ElementIdCompat.GetValue(instance.Id);
            if (refs.Any(existing => existing.ScheduleId == scheduleId && existing.InstanceId == instanceId)) return;
            refs.Add(new ScheduleRef
            {
                ScheduleId = scheduleId,
                ScheduleName = schedule.Name ?? "",
                SheetNumber = sheet.SheetNumber,
                SheetName = sheet.Name,
                InstanceId = instanceId
            });
        }

        private static string? ReadFamilyName(Element element)
        {
            try
            {
                if (element is FamilyInstance familyInstance) return familyInstance.Symbol?.Family?.Name;
                return (element.Document.GetElement(element.GetTypeId()) as ElementType)?.FamilyName;
            }
            catch { return null; }
        }

        private static string? ReadTypeName(Element element)
        {
            try { return (element.Document.GetElement(element.GetTypeId()) as ElementType)?.Name; }
            catch { return null; }
        }

        private static List<string> NormalizeStrings(IEnumerable<string>? values, int max)
        {
            return (values ?? Array.Empty<string>())
                .Select(value => (value ?? "").Trim())
                .Where(value => value.Length > 0)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Take(max)
                .ToList();
        }

        private static Parameter? FindParameter(Element element, ElementId parameterId)
        {
            try { return element.Parameters.Cast<Parameter>().FirstOrDefault(parameter => parameter.Id == parameterId); }
            catch { return null; }
        }

        private static ElementId SafeParameterId(ScheduleField field)
        {
            try { return field.ParameterId ?? ElementId.InvalidElementId; }
            catch { return ElementId.InvalidElementId; }
        }

        private static string SafeHeading(ScheduleField field)
        {
            try { return field.ColumnHeading ?? ""; }
            catch { return ""; }
        }

        private static bool SafeIsHidden(ScheduleField field)
        {
            try { return field.IsHidden; }
            catch { return false; }
        }
    }
}
