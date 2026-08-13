using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Electrical;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public sealed class UpdatePanelParameterHandler : IRequestHandler
    {
        private sealed class MatchedPanelSchedule
        {
            public PanelScheduleView Schedule { get; set; } = null!;
            public Element? PanelElement { get; set; }
            public string ScheduleName { get; set; } = "";
            public string PanelLabel { get; set; } = "";
            public string MatchSource { get; set; } = "";
        }

        public sealed class Params
        {
            public string? scheduleQuery { get; set; }
            public string? matchStartsWith { get; set; }
            public string? matchContains { get; set; }
            public string? panelName { get; set; }
            public string? panelNamePattern { get; set; }
            public string? matchExact { get; set; }
            public bool? exact { get; set; }
            public int? max { get; set; }

            public string? parameterName { get; set; }
            public string? requestedParameterName { get; set; }
            public string? parameterSemantic { get; set; }
            public string? value { get; set; }
            public bool? onlyWhenBlank { get; set; }
            public string? targetScope { get; set; } // auto | panel | schedule
            public string? samplePanelName { get; set; }
            public bool? includeWritableFields { get; set; }

            public bool? apply { get; set; }
            public bool? dryRun { get; set; }
            public bool? preflightOnly { get; set; }
            public string? confirm { get; set; }
        }

        private sealed class ResolvedTarget
        {
            public Element Owner { get; set; } = null!;
            public Parameter Parameter { get; set; } = null!;
            public string Scope { get; set; } = "";
            public string ParameterName { get; set; } = "";
            public string RequestedParameterName { get; set; } = "";
            public string MatchKind { get; set; } = "";
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            NormalizeAliases(p);

            var parameterName = $"{p.parameterName ?? ""}".Trim();
            if (parameterName.Length == 0) throw new InvalidOperationException("update-panel-parameter.parameterName is required.");
            var parameterCandidates = BuildParameterCandidateNames(parameterName);

            var requestedValue = p.value;
            if (requestedValue == null) throw new InvalidOperationException("update-panel-parameter.value is required.");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var isDryRun = (p.dryRun ?? false) || (p.preflightOnly ?? false) || (p.apply.HasValue && p.apply.Value == false);
            var apply = !isDryRun;
            var onlyWhenBlank = p.onlyWhenBlank ?? true;
            var exact = p.exact ?? false;
            var max = p.max.HasValue && p.max.Value > 0 ? Math.Min(p.max.Value, 2000) : 500;
            var targetScope = NormalizeTargetScope(p.targetScope);
            var warnings = new List<string>();
            if (!string.Equals(parameterCandidates[0], parameterName, StringComparison.OrdinalIgnoreCase))
            {
                warnings.Add($"Parameter alias resolved '{parameterName}' to primary candidate '{parameterCandidates[0]}'.");
            }

            var matched = CollectMatches(doc, p, exact, max, warnings);
            var sample = SelectSampleMatch(matched, p.samplePanelName);
            var rows = new List<object>(matched.Count);
            var updateTargets = new List<(MatchedPanelSchedule match, ResolvedTarget target)>();
            var failedCount = 0;
            var skippedCount = 0;
            var alreadyCorrectCount = 0;

            foreach (var match in matched)
            {
                var resolved = ResolveTarget(match, parameterCandidates, targetScope, parameterName);
                if (resolved == null)
                {
                    failedCount++;
                    rows.Add(new
                    {
                        scheduleId = ElementIdCompat.GetValue(match.Schedule.Id),
                        scheduleName = match.ScheduleName,
                        panelElementId = match.PanelElement != null ? ElementIdCompat.GetValue(match.PanelElement.Id) : 0,
                        panelLabel = match.PanelLabel,
                        matchSource = match.MatchSource,
                        requestedParameterName = parameterName,
                        parameterName,
                        resolvedParameterName = (string?)null,
                        parameterCandidates,
                        resolvedTargetScope = (string?)null,
                        status = "failed",
                        reason = BuildMissingTargetReason(targetScope, parameterName, parameterCandidates, match.PanelElement == null),
                        before = (object?)null,
                        after = (object?)null
                    });
                    continue;
                }

                var before = ParameterValueUtil.SnapshotForWire(resolved.Parameter);
                var isBlank = IsBlankParameter(resolved.Parameter, before);
                if (onlyWhenBlank && !isBlank)
                {
                    skippedCount++;
                    rows.Add(new
                    {
                        scheduleId = ElementIdCompat.GetValue(match.Schedule.Id),
                        scheduleName = match.ScheduleName,
                        panelElementId = match.PanelElement != null ? ElementIdCompat.GetValue(match.PanelElement.Id) : 0,
                        panelLabel = match.PanelLabel,
                        matchSource = match.MatchSource,
                        requestedParameterName = parameterName,
                        parameterName = resolved.ParameterName,
                        resolvedParameterName = resolved.ParameterName,
                        parameterCandidates,
                        resolvedTargetScope = resolved.Scope,
                        status = ParameterValueUtil.SnapshotMatchesRequestedValue(before, requestedValue)
                            ? (apply ? "already_correct" : "would_already_correct")
                            : (apply ? "skipped" : "would_skip"),
                        reason = ParameterValueUtil.SnapshotMatchesRequestedValue(before, requestedValue)
                            ? "Parameter already has the requested value."
                            : "Parameter already has a nonblank value.",
                        before,
                        after = before
                    });
                    if (ParameterValueUtil.SnapshotMatchesRequestedValue(before, requestedValue)) alreadyCorrectCount++;
                    continue;
                }

                updateTargets.Add((match, resolved));
                rows.Add(new
                {
                    scheduleId = ElementIdCompat.GetValue(match.Schedule.Id),
                    scheduleName = match.ScheduleName,
                    panelElementId = match.PanelElement != null ? ElementIdCompat.GetValue(match.PanelElement.Id) : 0,
                    panelLabel = match.PanelLabel,
                    matchSource = match.MatchSource,
                    requestedParameterName = parameterName,
                    parameterName = resolved.ParameterName,
                    resolvedParameterName = resolved.ParameterName,
                    parameterCandidates,
                    resolvedTargetScope = resolved.Scope,
                    status = apply ? "pending_apply" : "would_update",
                    reason = isBlank ? "Parameter is blank or missing a value." : "Parameter matched update criteria.",
                    before,
                    after = apply ? null : before
                });
            }

            var requestedUpdateCount = updateTargets.Count;
            var confirmReceived = BulkConfirmUtil.Normalize(p.confirm);
            string? requiredConfirm = null;

            var updatedCount = 0;
            var verifiedCount = 0;
            var verificationFailedCount = 0;
            if (apply && updateTargets.Count > 0)
            {
                using (var trans = new Transaction(doc, "Update Panel Parameters"))
                {
                    trans.Start();
                    for (var index = 0; index < rows.Count; index++)
                    {
                        var row = rows[index];
                        var status = GetAnonymousString(row, "status");
                        if (!string.Equals(status, "pending_apply", StringComparison.OrdinalIgnoreCase)) continue;

                        var scheduleId = GetAnonymousLong(row, "scheduleId");
                        var target = updateTargets.FirstOrDefault(x => ElementIdCompat.GetValue(x.match.Schedule.Id) == scheduleId);
                        if (target.match == null || target.target == null || target.target.Parameter == null)
                        {
                            failedCount++;
                            rows[index] = BuildFailureRow(row, parameterName, "Matched panel schedule target could not be re-resolved.");
                            continue;
                        }

                        var rowRequestedParameterName = GetAnonymousString(row, "requestedParameterName");
                        var rowResolvedParameterName = GetAnonymousString(row, "resolvedParameterName");
                        var before = ParameterValueUtil.SnapshotForWire(target.target.Parameter);
                        if (!ParameterValueUtil.TrySetFromString(target.target.Parameter, requestedValue, out var changed, out var message))
                        {
                            failedCount++;
                            rows[index] = BuildFailureRow(row, rowResolvedParameterName, message ?? "Parameter write failed.", before);
                            continue;
                        }

                        var after = ParameterValueUtil.SnapshotForWire(target.target.Parameter);
                        rows[index] = new
                        {
                            scheduleId,
                            scheduleName = GetAnonymousString(row, "scheduleName"),
                            panelElementId = GetAnonymousLong(row, "panelElementId"),
                            panelLabel = GetAnonymousString(row, "panelLabel"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            requestedParameterName = rowRequestedParameterName,
                            parameterName = rowResolvedParameterName,
                            resolvedParameterName = rowResolvedParameterName,
                            parameterCandidates,
                            resolvedTargetScope = GetAnonymousString(row, "resolvedTargetScope"),
                            status = changed ? "updated_pending_verify" : "already_correct",
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

                    var resolvedTargetScope = GetAnonymousString(row, "resolvedTargetScope");
                    var verifyRequestedParameterName = GetAnonymousString(row, "requestedParameterName");
                    var verifyResolvedParameterName = GetAnonymousString(row, "resolvedParameterName");
                    var currentParameter = ResolveParameter(doc,
                        GetAnonymousLong(row, "scheduleId"),
                        GetAnonymousLong(row, "panelElementId"),
                        verifyResolvedParameterName,
                        resolvedTargetScope);

                    if (currentParameter == null)
                    {
                        rows[index] = BuildFailureRow(row, verifyResolvedParameterName, "Parameter could not be re-read after apply.");
                        continue;
                    }

                    var verifiedSnapshot = ParameterValueUtil.SnapshotForWire(currentParameter);
                    if (ParameterValueUtil.SnapshotMatchesRequestedValue(verifiedSnapshot, requestedValue))
                    {
                        rows[index] = new
                        {
                            scheduleId = GetAnonymousLong(row, "scheduleId"),
                            scheduleName = GetAnonymousString(row, "scheduleName"),
                            panelElementId = GetAnonymousLong(row, "panelElementId"),
                            panelLabel = GetAnonymousString(row, "panelLabel"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            requestedParameterName = verifyRequestedParameterName,
                            parameterName = verifyResolvedParameterName,
                            resolvedParameterName = verifyResolvedParameterName,
                            parameterCandidates,
                            resolvedTargetScope,
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
                            scheduleId = GetAnonymousLong(row, "scheduleId"),
                            scheduleName = GetAnonymousString(row, "scheduleName"),
                            panelElementId = GetAnonymousLong(row, "panelElementId"),
                            panelLabel = GetAnonymousString(row, "panelLabel"),
                            matchSource = GetAnonymousString(row, "matchSource"),
                            requestedParameterName = verifyRequestedParameterName,
                            parameterName = verifyResolvedParameterName,
                            resolvedParameterName = verifyResolvedParameterName,
                            parameterCandidates,
                            resolvedTargetScope,
                            status = "verify_failed",
                            reason = $"Parameter write did not persist expected value '{requestedValue}'.",
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

            alreadyCorrectCount = rows.Count(r =>
                string.Equals(GetAnonymousString(r, "status"), "already_correct", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(GetAnonymousString(r, "status"), "would_already_correct", StringComparison.OrdinalIgnoreCase));
            skippedCount = rows.Count(r =>
                string.Equals(GetAnonymousString(r, "status"), "skipped", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(GetAnonymousString(r, "status"), "would_skip", StringComparison.OrdinalIgnoreCase));
            failedCount = rows.Count(r =>
                string.Equals(GetAnonymousString(r, "status"), "failed", StringComparison.OrdinalIgnoreCase) ||
                string.Equals(GetAnonymousString(r, "status"), "verify_failed", StringComparison.OrdinalIgnoreCase));

            var noChangeAlert = apply && matched.Count > 0 && updatedCount == 0 && alreadyCorrectCount == 0;
            var blockedReason = BuildBlockedReason(noChangeAlert, rows);
            var writePreflight = BuildWritePreflight(doc, sample, parameterName, parameterCandidates, targetScope, p.includeWritableFields ?? false);
            var panelBuckets = BuildPanelBuckets(rows);
            var resolvedParameterName = rows
                .Select(r => GetAnonymousString(r, "resolvedParameterName"))
                .FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
            var resultStatus = !apply
                ? (p.preflightOnly ?? false ? "Preflight" : "Dry Run")
                : verificationFailedCount > 0 ? "Verification Failed"
                : noChangeAlert ? "No Changes"
                : updatedCount == 0 && alreadyCorrectCount > 0 && failedCount == 0 ? "Already Correct"
                : "Applied";

            return Task.FromResult<object>(new
            {
                status = resultStatus,
                dryRun = !apply,
                requestedParameterName = parameterName,
                parameterName = resolvedParameterName ?? parameterName,
                resolvedParameterName,
                parameterCandidates,
                requestedValue,
                onlyWhenBlank,
                exact,
                scheduleQuery = $"{p.scheduleQuery ?? ""}".Trim(),
                matchStartsWith = $"{p.matchStartsWith ?? ""}".Trim(),
                matchContains = $"{p.matchContains ?? ""}".Trim(),
                targetScope,
                matchedCount = matched.Count,
                updateCandidateCount = updateTargets.Count,
                wouldUpdateCount = updateTargets.Count,
                updatedCount,
                verifiedCount,
                alreadyCorrectCount,
                skippedCount,
                failedCount,
                noChangeAlert,
                blockedReason,
                verificationPerformed = apply && updateTargets.Count > 0,
                verificationFailedCount,
                requiredConfirm,
                confirmReceived,
                writePreflight,
                panelBuckets,
                rows,
                warnings
            });
        }

        private static List<MatchedPanelSchedule> CollectMatches(Document doc, Params p, bool exact, int max, List<string> warnings)
        {
            var results = new List<MatchedPanelSchedule>();
            var query = $"{p.scheduleQuery ?? ""}".Trim();
            var startsWith = $"{p.matchStartsWith ?? ""}".Trim();
            var contains = $"{p.matchContains ?? ""}".Trim();

            foreach (var schedule in new FilteredElementCollector(doc).OfClass(typeof(PanelScheduleView)).Cast<PanelScheduleView>())
            {
                if (schedule == null) continue;
                var panelElement = TryGetPanelElement(doc, schedule);
                if (!TryMatchSchedule(schedule, panelElement, query, startsWith, contains, exact, out var panelLabel, out var matchSource))
                {
                    continue;
                }

                results.Add(new MatchedPanelSchedule
                {
                    Schedule = schedule,
                    PanelElement = panelElement,
                    ScheduleName = (schedule.Name ?? "").Trim(),
                    PanelLabel = panelLabel,
                    MatchSource = matchSource
                });

                if (results.Count >= max)
                {
                    warnings.Add($"Results truncated to max={max}.");
                    break;
                }
            }

            return results
                .OrderBy(x => x.ScheduleName, StringComparer.OrdinalIgnoreCase)
                .ThenBy(x => x.PanelLabel, StringComparer.OrdinalIgnoreCase)
                .ToList();
        }

        private static void NormalizeAliases(Params p)
        {
            if (p == null) return;

            if (string.IsNullOrWhiteSpace(p.parameterName))
            {
                if (!string.IsNullOrWhiteSpace(p.requestedParameterName)) p.parameterName = p.requestedParameterName;
                else if (!string.IsNullOrWhiteSpace(p.parameterSemantic)) p.parameterName = p.parameterSemantic;
            }

            if (!string.IsNullOrWhiteSpace(p.matchExact))
            {
                p.scheduleQuery = p.matchExact;
                p.exact = true;
            }
            else if (string.IsNullOrWhiteSpace(p.scheduleQuery) && !string.IsNullOrWhiteSpace(p.panelName))
            {
                p.scheduleQuery = p.panelName;
                p.exact = true;
            }
            else if (string.IsNullOrWhiteSpace(p.scheduleQuery) && !string.IsNullOrWhiteSpace(p.panelNamePattern))
            {
                p.scheduleQuery = p.panelNamePattern;
            }

            if (string.IsNullOrWhiteSpace(p.samplePanelName))
            {
                p.samplePanelName = p.scheduleQuery ?? p.panelName ?? p.panelNamePattern ?? p.matchExact;
            }
        }

        private static bool TryMatchSchedule(
            PanelScheduleView schedule,
            Element? panelElement,
            string query,
            string startsWith,
            string contains,
            bool exact,
            out string panelLabel,
            out string matchSource)
        {
            panelLabel = BuildPanelLabel(panelElement) ?? "";
            matchSource = "Schedule.Name";

            var candidates = BuildMatchCandidates(schedule, panelElement);
            if (query.Length == 0 && startsWith.Length == 0 && contains.Length == 0)
            {
                var first = candidates.FirstOrDefault();
                if (!string.IsNullOrWhiteSpace(first.text))
                {
                    panelLabel = first.text;
                    matchSource = first.source;
                }
                return true;
            }

            foreach (var candidate in candidates)
            {
                if (query.Length > 0)
                {
                    if (exact)
                    {
                        if (!candidate.text.Equals(query, StringComparison.OrdinalIgnoreCase)) continue;
                    }
                    else if (candidate.text.IndexOf(query, StringComparison.OrdinalIgnoreCase) < 0)
                    {
                        continue;
                    }
                }

                if (startsWith.Length > 0 && !candidate.text.StartsWith(startsWith, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }
                if (contains.Length > 0 && candidate.text.IndexOf(contains, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    continue;
                }

                panelLabel = candidate.text;
                matchSource = candidate.source;
                return true;
            }

            return false;
        }

        private static List<(string text, string source)> BuildMatchCandidates(PanelScheduleView schedule, Element? panelElement)
        {
            var results = new List<(string text, string source)>();
            void Add(string? text, string source)
            {
                var normalized = $"{text ?? ""}".Trim();
                if (normalized.Length == 0) return;
                if (results.Any(x => string.Equals(x.text, normalized, StringComparison.OrdinalIgnoreCase))) return;
                results.Add((normalized, source));
            }

            Add(schedule?.Name, "Schedule.Name");
            Add(BuildPanelLabel(panelElement), "Panel.Label");
            Add(panelElement?.Name, "Panel.Element.Name");
            Add(TryGetPanelNameParameter(panelElement), "Panel.Parameter:Panel Name");
            Add(TryGetMark(panelElement), "Panel.Mark");
            return results;
        }

        private static List<string> BuildParameterCandidateNames(string requestedParameterName)
        {
            var requested = $"{requestedParameterName ?? ""}".Trim();
            var candidates = new List<string>();
            void Add(string value)
            {
                var text = $"{value ?? ""}".Trim();
                if (text.Length == 0) return;
                if (candidates.Any(x => string.Equals(x, text, StringComparison.OrdinalIgnoreCase))) return;
                candidates.Add(text);
            }

            var normalized = NormalizeParameterKey(requested);
            var isAicLike =
                normalized.Contains("aic") ||
                normalized.Contains("interruptingcurrent") ||
                normalized.Contains("interruptingrating") ||
                normalized.Contains("availablefaultcurrent");
            var isShortCircuitLike =
                normalized.Contains("shortcircuit") ||
                normalized.Contains("sccr");

            if (isAicLike || isShortCircuitLike)
            {
                Add("Short Circuit Rating");
                Add(requested);
                Add("A.I.C. Rating");
                Add("AIC Rating");
                Add("AIC");
                Add("Interrupting Rating");
                Add("Available Interrupting Current");
                Add("SCCR");
                return candidates;
            }

            Add(requested);
            return candidates;
        }

        private static string NormalizeParameterKey(string? value)
        {
            var chars = $"{value ?? ""}".Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray();
            return new string(chars);
        }

        private static MatchedPanelSchedule? SelectSampleMatch(IReadOnlyList<MatchedPanelSchedule> matches, string? samplePanelName)
        {
            if (matches.Count == 0) return null;
            var requested = $"{samplePanelName ?? ""}".Trim();
            if (requested.Length == 0) return matches[0];

            return matches.FirstOrDefault(m =>
                    string.Equals(m.PanelLabel, requested, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(m.ScheduleName, requested, StringComparison.OrdinalIgnoreCase) ||
                    string.Equals(m.PanelElement?.Name, requested, StringComparison.OrdinalIgnoreCase)) ??
                matches.FirstOrDefault(m =>
                    m.PanelLabel.IndexOf(requested, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    m.ScheduleName.IndexOf(requested, StringComparison.OrdinalIgnoreCase) >= 0 ||
                    (m.PanelElement?.Name ?? "").IndexOf(requested, StringComparison.OrdinalIgnoreCase) >= 0) ??
                matches[0];
        }

        private static ResolvedTarget? ResolveTarget(MatchedPanelSchedule match, IReadOnlyList<string> parameterCandidates, string targetScope, string requestedParameterName)
        {
            if ((targetScope == "auto" || targetScope == "panel") && match.PanelElement != null)
            {
                foreach (var candidate in parameterCandidates)
                {
                    var panelParameter = TryLookupParameter(match.PanelElement, candidate);
                    if (panelParameter != null)
                    {
                        var resolvedName = panelParameter.Definition?.Name ?? candidate;
                        return new ResolvedTarget
                        {
                            Owner = match.PanelElement,
                            Parameter = panelParameter,
                            Scope = "panel",
                            ParameterName = resolvedName,
                            RequestedParameterName = requestedParameterName,
                            MatchKind = string.Equals(resolvedName, requestedParameterName, StringComparison.OrdinalIgnoreCase) ? "exact" : "alias"
                        };
                    }
                }
            }

            if (targetScope == "auto" || targetScope == "schedule")
            {
                foreach (var candidate in parameterCandidates)
                {
                    var scheduleParameter = TryLookupParameter(match.Schedule, candidate);
                    if (scheduleParameter != null)
                    {
                        var resolvedName = scheduleParameter.Definition?.Name ?? candidate;
                        return new ResolvedTarget
                        {
                            Owner = match.Schedule,
                            Parameter = scheduleParameter,
                            Scope = "schedule",
                            ParameterName = resolvedName,
                            RequestedParameterName = requestedParameterName,
                            MatchKind = string.Equals(resolvedName, requestedParameterName, StringComparison.OrdinalIgnoreCase) ? "exact" : "alias"
                        };
                    }
                }
            }

            return null;
        }

        private static Parameter? TryLookupParameter(Element owner, string parameterName)
        {
            try
            {
                var exact = owner.LookupParameter(parameterName);
                if (exact != null) return exact;

                foreach (Parameter parameter in owner.Parameters)
                {
                    var name = parameter?.Definition?.Name;
                    if (string.Equals(name, parameterName, StringComparison.OrdinalIgnoreCase))
                    {
                        return parameter;
                    }
                }
            }
            catch
            {
                // best effort
            }
            return null;
        }

        private static string NormalizeTargetScope(string? raw)
        {
            var text = $"{raw ?? ""}".Trim().ToLowerInvariant();
            return text switch
            {
                "panel" => "panel",
                "schedule" => "schedule",
                _ => "auto"
            };
        }

        private static Element? TryGetPanelElement(Document doc, PanelScheduleView schedule)
        {
            try
            {
                var panelId = schedule.GetPanel();
                if (panelId == null || panelId == ElementId.InvalidElementId) return null;
                return doc.GetElement(panelId);
            }
            catch
            {
                return null;
            }
        }

        private static string? BuildPanelLabel(Element? panelElement)
        {
            return TryGetPanelNameParameter(panelElement)
                ?? panelElement?.Name
                ?? TryGetMark(panelElement);
        }

        private static string? TryGetPanelNameParameter(Element? panelElement)
        {
            if (panelElement == null) return null;
            try
            {
                return panelElement.LookupParameter("Panel Name")?.AsString()
                    ?? panelElement.LookupParameter("Panel")?.AsString()
                    ?? panelElement.LookupParameter("Name")?.AsString();
            }
            catch
            {
                return null;
            }
        }

        private static string? TryGetMark(Element? element)
        {
            if (element == null) return null;
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

        private static string BuildMissingTargetReason(string targetScope, string parameterName, IReadOnlyList<string> parameterCandidates, bool missingPanel)
        {
            var candidateText = parameterCandidates.Count > 1
                ? $" Tried candidates: {string.Join(", ", parameterCandidates)}."
                : "";
            if (targetScope == "panel")
            {
                return missingPanel
                    ? "Panel schedule did not resolve to a panel element."
                    : $"Parameter '{parameterName}' was not found on the panel element.{candidateText}";
            }
            if (targetScope == "schedule")
            {
                return $"Parameter '{parameterName}' was not found on the panel schedule view.{candidateText}";
            }

            return missingPanel
                ? $"Panel schedule did not resolve to a panel element, and parameter '{parameterName}' was not found on the schedule view.{candidateText}"
                : $"Parameter '{parameterName}' was not found on either the panel element or the panel schedule view.{candidateText}";
        }

        private static object BuildFailureRow(object row, string parameterName, string reason, object? before = null)
        {
            var previousBefore = before ?? GetAnonymousValue(row, "before");
            var requestedParameterName = GetAnonymousString(row, "requestedParameterName");
            var resolvedParameterName = GetAnonymousString(row, "resolvedParameterName");
            return new
            {
                scheduleId = GetAnonymousLong(row, "scheduleId"),
                scheduleName = GetAnonymousString(row, "scheduleName"),
                panelElementId = GetAnonymousLong(row, "panelElementId"),
                panelLabel = GetAnonymousString(row, "panelLabel"),
                matchSource = GetAnonymousString(row, "matchSource"),
                requestedParameterName = string.IsNullOrWhiteSpace(requestedParameterName) ? parameterName : requestedParameterName,
                parameterName = string.IsNullOrWhiteSpace(resolvedParameterName) ? parameterName : resolvedParameterName,
                resolvedParameterName = string.IsNullOrWhiteSpace(resolvedParameterName) ? parameterName : resolvedParameterName,
                parameterCandidates = GetAnonymousValue(row, "parameterCandidates"),
                resolvedTargetScope = GetAnonymousString(row, "resolvedTargetScope"),
                status = "failed",
                reason,
                before = previousBefore,
                after = previousBefore
            };
        }

        private static string? BuildBlockedReason(bool noChangeAlert, IReadOnlyList<object> rows)
        {
            if (!noChangeAlert) return null;
            var firstFailure = rows.Select(r => GetAnonymousString(r, "reason")).FirstOrDefault(x => !string.IsNullOrWhiteSpace(x));
            return string.IsNullOrWhiteSpace(firstFailure)
                ? "No panel values changed. Check write access, target parameter resolution, and sample preflight details."
                : firstFailure;
        }

        private static object BuildWritePreflight(
            Document doc,
            MatchedPanelSchedule? sample,
            string requestedParameterName,
            IReadOnlyList<string> parameterCandidates,
            string targetScope,
            bool includeWritableFields)
        {
            object? sampleResult = null;
            if (sample != null)
            {
                var resolved = ResolveTarget(sample, parameterCandidates, targetScope, requestedParameterName);
                sampleResult = new
                {
                    scheduleId = ElementIdCompat.GetValue(sample.Schedule.Id),
                    scheduleName = sample.ScheduleName,
                    panelElementId = sample.PanelElement != null ? ElementIdCompat.GetValue(sample.PanelElement.Id) : 0,
                    panelLabel = sample.PanelLabel,
                    requestedParameterName,
                    resolvedParameterName = resolved?.ParameterName,
                    resolvedTargetScope = resolved?.Scope,
                    parameterMatchKind = resolved?.MatchKind,
                    writable = resolved?.Parameter != null && !resolved.Parameter.IsReadOnly,
                    readOnly = resolved?.Parameter?.IsReadOnly,
                    storageType = resolved?.Parameter?.StorageType.ToString(),
                    before = resolved?.Parameter != null ? ParameterValueUtil.SnapshotForWire(resolved.Parameter) : null,
                    status = resolved == null
                        ? "unresolved"
                        : resolved.Parameter.IsReadOnly ? "blocked_read_only" : "writable",
                    writableFields = includeWritableFields
                        ? BuildWritableFieldList(resolved?.Owner ?? sample.PanelElement ?? sample.Schedule, limit: 80)
                        : null
                };
            }

            return new
            {
                bridgeConnected = true,
                handlerReached = true,
                documentTitle = doc.Title,
                documentPath = SafeDocumentPath(doc),
                documentReadOnly = SafeDocumentIsReadOnly(doc),
                writeGrant = "validated_by_bridge_for_this_request",
                requestedParameterName,
                parameterCandidates,
                targetScope,
                sample = sampleResult
            };
        }

        private static object BuildPanelBuckets(IReadOnlyList<object> rows)
        {
            string[] Labels(params string[] statuses)
            {
                return rows
                    .Where(r => statuses.Any(s => string.Equals(GetAnonymousString(r, "status"), s, StringComparison.OrdinalIgnoreCase)))
                    .Select(r => GetAnonymousString(r, "panelLabel"))
                    .Where(x => !string.IsNullOrWhiteSpace(x))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .OrderBy(x => x, StringComparer.OrdinalIgnoreCase)
                    .ToArray();
            }

            return new
            {
                changed = Labels("updated_verified"),
                alreadyCorrect = Labels("already_correct", "would_already_correct"),
                wouldUpdate = Labels("would_update"),
                skipped = Labels("skipped", "would_skip"),
                failed = Labels("failed", "verify_failed")
            };
        }

        private static object[] BuildWritableFieldList(Element? owner, int limit)
        {
            var fields = new List<object>();
            if (owner == null) return fields.ToArray();
            try
            {
                foreach (Parameter parameter in owner.Parameters)
                {
                    if (parameter == null || parameter.IsReadOnly) continue;
                    var name = $"{parameter.Definition?.Name ?? ""}".Trim();
                    if (name.Length == 0) continue;
                    fields.Add(new
                    {
                        name,
                        storageType = parameter.StorageType.ToString(),
                        hasValue = SafeHasValue(parameter)
                    });
                    if (fields.Count >= limit) break;
                }
            }
            catch
            {
                // best effort
            }
            return fields.ToArray();
        }

        private static bool? SafeHasValue(Parameter parameter)
        {
            try { return parameter.HasValue; }
            catch { return null; }
        }

        private static bool? SafeDocumentIsReadOnly(Document doc)
        {
            try
            {
                var value = doc.GetType().GetProperty("IsReadOnly")?.GetValue(doc);
                return value is bool b ? b : null;
            }
            catch
            {
                return null;
            }
        }

        private static string SafeDocumentPath(Document doc)
        {
            try { return doc.PathName ?? ""; }
            catch { return ""; }
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

        private static Parameter? ResolveParameter(Document doc, long scheduleId, long panelElementId, string parameterName, string resolvedTargetScope)
        {
            try
            {
                if (string.Equals(resolvedTargetScope, "panel", StringComparison.OrdinalIgnoreCase))
                {
                    var panel = doc.GetElement(ElementIdCompat.Create(panelElementId));
                    return panel == null ? null : TryLookupParameter(panel, parameterName);
                }

                var schedule = doc.GetElement(ElementIdCompat.Create(scheduleId));
                return schedule == null ? null : TryLookupParameter(schedule, parameterName);
            }
            catch
            {
                return null;
            }
        }
    }
}
