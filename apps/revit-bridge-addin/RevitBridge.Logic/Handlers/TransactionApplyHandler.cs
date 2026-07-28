using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class TransactionApplyHandler : IRequestHandler
    {
        public class Params
        {
            public List<JsonElement>? actions { get; set; }
            public DiffOptions? diff { get; set; }
        }

        public class DiffOptions
        {
            public bool? includeParameterDeltas { get; set; }
            public bool? includeGeometryDeltas { get; set; }
            public bool? includeViewSheetChanges { get; set; }
            public bool? persistArtifact { get; set; }
            public string? artifactFolder { get; set; }
            public int? maxTrackedElementIds { get; set; }
            public int? maxCreated { get; set; }
            public int? maxDeleted { get; set; }
            public int? maxModified { get; set; }
            public int? maxParameterDeltas { get; set; }
            public int? maxGeometryDeltas { get; set; }
            public int? maxViewSheetChanges { get; set; }
            public int? maxWatchElementsPerScope { get; set; }
        }

        private sealed class ActionReceipt
        {
            internal ActionReceipt(int index, string kind)
            {
                Index = index;
                Kind = kind;
            }

            internal int Index { get; }
            internal string Kind { get; }
            internal TransactionActionRunner.TransactionOperationReceipt Start { get; } = new TransactionActionRunner.TransactionOperationReceipt();
            internal TransactionActionRunner.TransactionOperationReceipt Commit { get; } = new TransactionActionRunner.TransactionOperationReceipt();
            internal TransactionActionRunner.TransactionOperationReceipt Rollback { get; } = new TransactionActionRunner.TransactionOperationReceipt();
            internal TransactionActionRunner.ActionOutcome? Outcome { get; set; }
            internal string? Error { get; set; }
            internal bool Success => Start.Succeeded && (Outcome?.Success ?? false) && Commit.Succeeded && Error == null;

            internal object ToWireObject() => new
            {
                index = Index,
                kind = Kind,
                success = Success,
                start = Start.ToWireObject(),
                action = Outcome?.ToWireObject(),
                commit = Commit.ToWireObject(),
                rollback = Rollback.ToWireObject(),
                error = Error
            };
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active document.");

            var transactionId = Guid.NewGuid().ToString("N");
            var warnings = new List<string>();
            var impact = new TransactionActionRunner.Impact();
            var actions = p?.actions ?? new List<JsonElement>();
            var diffOptions = BuildDiffOptions(p?.diff);
            var sessionScopeId = $"session:{transactionId}";
            var stepDiffs = new List<TransactionDiffRecorder.TransactionDiffScopeResult>();
            TransactionDiffRecorder.TransactionDiffScopeResult? sessionDiff = null;
            object? artifact = null;
            var groupStartReceipt = new TransactionActionRunner.TransactionOperationReceipt();
            var assimilateReceipt = new TransactionActionRunner.TransactionOperationReceipt();
            var rollbackReceipt = new TransactionActionRunner.TransactionOperationReceipt();
            var actionReceipts = new List<ActionReceipt>();
            var phaseState = new TransactionApplyPhaseState();

            try
            {
                using (var recorder = new TransactionDiffRecorder(app, doc, diffOptions))
                using (var tg = new TransactionGroup(doc, $"Transaction Apply ({transactionId})"))
                {
                    recorder.StartRecording(
                        scopeId: sessionScopeId,
                        scopeKind: "session",
                        watchElementIds: TransactionActionRunner.CollectWatchElementIds(actions, Math.Min(diffOptions.limits.MaxWatchElementsPerScope * 2, diffOptions.limits.MaxTrackedElementIds)));

                    try
                    {
                        RecordStart(tg, groupStartReceipt, "transaction group");

                        if (actions.Count == 0)
                        {
                            const string noActionsError = "No actions provided.";
                            warnings.Add(noActionsError);
                            throw new InvalidOperationException(noActionsError);
                        }

                        for (int i = 0; i < actions.Count; i++)
                        {
                            var action = actions[i];
                            var actionKind = TransactionActionRunner.GetActionKind(action);
                            var actionReceipt = new ActionReceipt(i, actionKind);
                            actionReceipts.Add(actionReceipt);
                            var stepScopeId = $"step:{i + 1}";
                            recorder.StartRecording(
                                scopeId: stepScopeId,
                                scopeKind: "step",
                                watchElementIds: TransactionActionRunner.CollectWatchElementIds(action, diffOptions.limits.MaxWatchElementsPerScope),
                                actionKind: actionKind);

                            try
                            {
                                using (var t = new Transaction(doc, $"Apply Action {i + 1}: {actionKind}"))
                                {
                                    try
                                    {
                                        RecordStart(t, actionReceipt.Start, $"action[{i}] transaction");
                                        actionReceipt.Outcome = TransactionActionRunner.ExecuteAction(doc, action, impact, warnings, i);
                                        if (!actionReceipt.Outcome.Success)
                                        {
                                            throw new InvalidOperationException(
                                                actionReceipt.Outcome.Errors.Count == 0
                                                    ? $"Action[{i}] '{actionKind}' performed no successful operation."
                                                    : string.Join(" ", actionReceipt.Outcome.Errors));
                                        }

                                        RecordCommit(t, actionReceipt.Commit, $"action[{i}] transaction");
                                    }
                                    catch (Exception actionEx)
                                    {
                                        actionReceipt.Error = actionEx.Message;
                                        TryRollback(t, actionReceipt.Rollback);
                                        throw;
                                    }
                                }

                                stepDiffs.Add(recorder.StopRecording(stepScopeId));
                            }
                            catch (Exception stepEx)
                            {
                                try { stepDiffs.Add(recorder.StopRecording(stepScopeId)); } catch { }
                                throw new InvalidOperationException($"Action[{i}] '{actionKind}' failed: {stepEx.Message}", stepEx);
                            }
                        }

                        sessionDiff = recorder.StopRecording(sessionScopeId);
                        RecordAssimilate(tg, assimilateReceipt);
                        phaseState.ObserveAssimilateReceipt(assimilateReceipt);

                        return Task.FromResult(BuildCommittedResponse(
                            transactionId,
                            impact,
                            phaseState,
                            groupStartReceipt,
                            actionReceipts,
                            assimilateReceipt,
                            rollbackReceipt,
                            diffOptions,
                            sessionDiff,
                            stepDiffs,
                            warnings,
                            postCommitWarning: null));
                    }
                    catch (Exception ex)
                    {
                        try
                        {
                            if (sessionDiff == null)
                                sessionDiff = recorder.StopRecording(sessionScopeId);
                        }
                        catch
                        {
                            // ignore scope stop failures on rollback paths
                        }

                        var disposition = phaseState.ResolveFailure(
                            ex,
                            assimilateReceipt,
                            rollbackReceipt,
                            () => TryRollback(tg, rollbackReceipt));

                        if (disposition.Committed)
                        {
                            var postCommitWarning = disposition.PostCommitWarning;
                            if (postCommitWarning != null &&
                                !string.IsNullOrWhiteSpace(postCommitWarning) &&
                                !warnings.Contains(postCommitWarning))
                            {
                                warnings.Add(postCommitWarning);
                            }

                            return Task.FromResult(BuildCommittedResponse(
                                transactionId,
                                impact,
                                phaseState,
                                groupStartReceipt,
                                actionReceipts,
                                assimilateReceipt,
                                rollbackReceipt,
                                diffOptions,
                                sessionDiff,
                                stepDiffs,
                                warnings,
                                postCommitWarning));
                        }

                        var failureError = disposition.FailureError ?? ex.Message;
                        if (!warnings.Contains(ex.Message)) warnings.Add(ex.Message);
                        if (!string.Equals(failureError, ex.Message, StringComparison.Ordinal) && !warnings.Contains(failureError))
                            warnings.Add(failureError);

                        var transactionReceipt = BuildTransactionReceipt(
                            groupStartReceipt,
                            actionReceipts,
                            assimilateReceipt,
                            rollbackReceipt,
                            phaseState.WireName);

                        artifact = TryWriteDiffArtifact(
                            transactionId: transactionId,
                            success: false,
                            rolledBack: disposition.RolledBack,
                            impactState: disposition.ImpactState,
                            transactionReceipt: transactionReceipt,
                            options: diffOptions,
                            sessionDiff: sessionDiff,
                            stepDiffs: stepDiffs,
                            warnings: warnings,
                            error: failureError);

                        return Task.FromResult<object>(new
                        {
                            success = false,
                            transactionId = transactionId,
                            impactState = disposition.ImpactState,
                            impact = impact.ToWireObject(),
                            transaction = transactionReceipt,
                            diff = new
                            {
                                rolledBack = disposition.RolledBack,
                                options = diffOptions.ToWireObject(),
                                session = sessionDiff,
                                steps = stepDiffs,
                                artifact
                            },
                            warnings = warnings,
                            artifacts = artifact == null ? Array.Empty<object>() : new object[] { artifact },
                            error = failureError
                        });
                    }
                }
            }
            catch (Exception ex)
            {
                if (!phaseState.IsCommitted) throw;

                var disposition = phaseState.ResolveFailure(
                    ex,
                    assimilateReceipt,
                    rollbackReceipt,
                    () => { });
                var postCommitWarning = disposition.PostCommitWarning;
                if (postCommitWarning != null &&
                    !string.IsNullOrWhiteSpace(postCommitWarning) &&
                    !warnings.Contains(postCommitWarning))
                {
                    warnings.Add(postCommitWarning);
                }

                return Task.FromResult(BuildCommittedResponse(
                    transactionId,
                    impact,
                    phaseState,
                    groupStartReceipt,
                    actionReceipts,
                    assimilateReceipt,
                    rollbackReceipt,
                    diffOptions,
                    sessionDiff,
                    stepDiffs,
                    warnings,
                    postCommitWarning));
            }
        }

        private static object BuildCommittedResponse(
            string transactionId,
            TransactionActionRunner.Impact impact,
            TransactionApplyPhaseState phaseState,
            TransactionActionRunner.TransactionOperationReceipt groupStartReceipt,
            IReadOnlyList<ActionReceipt> actionReceipts,
            TransactionActionRunner.TransactionOperationReceipt assimilateReceipt,
            TransactionActionRunner.TransactionOperationReceipt rollbackReceipt,
            TransactionDiffRecorder.CaptureOptions diffOptions,
            TransactionDiffRecorder.TransactionDiffScopeResult? sessionDiff,
            IReadOnlyList<TransactionDiffRecorder.TransactionDiffScopeResult> stepDiffs,
            List<string> warnings,
            string? postCommitWarning)
        {
            var transactionReceipt = BuildTransactionReceipt(
                groupStartReceipt,
                actionReceipts,
                assimilateReceipt,
                rollbackReceipt,
                phaseState.WireName);

            var artifact = TryWriteDiffArtifact(
                transactionId: transactionId,
                success: true,
                rolledBack: false,
                impactState: "committed",
                transactionReceipt: transactionReceipt,
                options: diffOptions,
                sessionDiff: sessionDiff,
                stepDiffs: stepDiffs,
                warnings: warnings,
                error: null);

            return new
            {
                success = true,
                transactionId,
                impactState = "committed",
                postCommitWarning,
                impact = impact.ToWireObject(),
                transaction = transactionReceipt,
                diff = new
                {
                    rolledBack = false,
                    options = diffOptions.ToWireObject(),
                    session = sessionDiff,
                    steps = stepDiffs,
                    artifact
                },
                warnings,
                artifacts = artifact == null ? Array.Empty<object>() : new object[] { artifact }
            };
        }

        private static void RecordStart(TransactionGroup group, TransactionActionRunner.TransactionOperationReceipt receipt, string operationName)
        {
            receipt.Attempted = true;
            try
            {
                var status = group.Start();
                RecordExpectedStatus(receipt, status, TransactionStatus.Started);
                if (!receipt.Succeeded)
                    throw new InvalidOperationException($"{operationName} start returned status '{receipt.Status}', expected 'Started'.");
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(group, receipt, TransactionStatus.Started);
                throw;
            }
        }

        private static void RecordStart(Transaction transaction, TransactionActionRunner.TransactionOperationReceipt receipt, string operationName)
        {
            receipt.Attempted = true;
            try
            {
                var status = transaction.Start();
                RecordExpectedStatus(receipt, status, TransactionStatus.Started);
                if (!receipt.Succeeded)
                    throw new InvalidOperationException($"{operationName} start returned status '{receipt.Status}', expected 'Started'.");
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(transaction, receipt, TransactionStatus.Started);
                throw;
            }
        }

        private static void RecordCommit(Transaction transaction, TransactionActionRunner.TransactionOperationReceipt receipt, string operationName)
        {
            receipt.Attempted = true;
            try
            {
                var status = transaction.Commit();
                RecordExpectedStatus(receipt, status, TransactionStatus.Committed);
                if (!receipt.Succeeded)
                    throw new InvalidOperationException($"{operationName} commit returned status '{receipt.Status}', expected 'Committed'.");
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(transaction, receipt, TransactionStatus.Committed);
                throw;
            }
        }

        private static void RecordAssimilate(TransactionGroup group, TransactionActionRunner.TransactionOperationReceipt receipt)
        {
            receipt.Attempted = true;
            try
            {
                var status = group.Assimilate();
                RecordExpectedStatus(receipt, status, TransactionStatus.Committed);
                if (!receipt.Succeeded)
                    throw new InvalidOperationException($"transaction group assimilate returned status '{receipt.Status}', expected 'Committed'.");
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(group, receipt, TransactionStatus.Committed);
                throw;
            }
        }

        private static void TryRollback(TransactionGroup group, TransactionActionRunner.TransactionOperationReceipt receipt)
        {
            var currentStatus = SafeGetStatus(group, out var statusError);
            receipt.Status = currentStatus?.ToString() ?? "StatusUnavailable";
            receipt.VerifiedRolledBack = currentStatus == TransactionStatus.RolledBack;
            if (receipt.VerifiedRolledBack) return;
            if (currentStatus != TransactionStatus.Started)
            {
                receipt.Error = statusError ??
                    (currentStatus == TransactionStatus.Uninitialized
                        ? null
                        : $"transaction group rollback was not attempted because current status is '{receipt.Status}'.");
                return;
            }

            receipt.Attempted = true;
            try
            {
                var status = group.RollBack();
                RecordExpectedStatus(receipt, status, TransactionStatus.RolledBack);
                if (!receipt.Succeeded)
                {
                    RefreshExpectedStatus(group, receipt, TransactionStatus.RolledBack);
                    if (!receipt.Succeeded)
                        receipt.Error = $"transaction group rollback returned status '{receipt.Status}', expected 'RolledBack'.";
                }
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(group, receipt, TransactionStatus.RolledBack);
            }
        }

        private static void TryRollback(Transaction transaction, TransactionActionRunner.TransactionOperationReceipt receipt)
        {
            var currentStatus = SafeGetStatus(transaction, out var statusError);
            receipt.Status = currentStatus?.ToString() ?? "StatusUnavailable";
            receipt.VerifiedRolledBack = currentStatus == TransactionStatus.RolledBack;
            if (receipt.VerifiedRolledBack) return;
            if (currentStatus != TransactionStatus.Started)
            {
                receipt.Error = statusError ??
                    (currentStatus == TransactionStatus.Uninitialized
                        ? null
                        : $"action transaction rollback was not attempted because current status is '{receipt.Status}'.");
                return;
            }

            receipt.Attempted = true;
            try
            {
                var status = transaction.RollBack();
                RecordExpectedStatus(receipt, status, TransactionStatus.RolledBack);
                if (!receipt.Succeeded)
                {
                    RefreshExpectedStatus(transaction, receipt, TransactionStatus.RolledBack);
                    if (!receipt.Succeeded)
                        receipt.Error = $"action transaction rollback returned status '{receipt.Status}', expected 'RolledBack'.";
                }
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                RefreshExpectedStatus(transaction, receipt, TransactionStatus.RolledBack);
            }
        }

        private static void RecordExpectedStatus(TransactionActionRunner.TransactionOperationReceipt receipt, TransactionStatus actual, TransactionStatus expected)
        {
            TransactionOperationTruth.RecordExpectedStatus(receipt, actual.ToString(), expected.ToString());
        }

        private static void RefreshExpectedStatus(
            TransactionGroup group,
            TransactionActionRunner.TransactionOperationReceipt receipt,
            TransactionStatus expected)
        {
            var currentStatus = SafeGetStatus(group, out _);
            if (currentStatus.HasValue)
            {
                RecordExpectedStatus(receipt, currentStatus.Value, expected);
                return;
            }

            receipt.Status = "StatusUnavailable";
            receipt.Succeeded = false;
            receipt.VerifiedRolledBack = false;
        }

        private static void RefreshExpectedStatus(
            Transaction transaction,
            TransactionActionRunner.TransactionOperationReceipt receipt,
            TransactionStatus expected)
        {
            var currentStatus = SafeGetStatus(transaction, out _);
            if (currentStatus.HasValue)
            {
                RecordExpectedStatus(receipt, currentStatus.Value, expected);
                return;
            }

            receipt.Status = "StatusUnavailable";
            receipt.Succeeded = false;
            receipt.VerifiedRolledBack = false;
        }

        private static TransactionStatus? SafeGetStatus(TransactionGroup group, out string? error)
        {
            try
            {
                error = null;
                return group.GetStatus();
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        private static TransactionStatus? SafeGetStatus(Transaction transaction, out string? error)
        {
            try
            {
                error = null;
                return transaction.GetStatus();
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return null;
            }
        }

        private static object BuildTransactionReceipt(
            TransactionActionRunner.TransactionOperationReceipt groupStart,
            IReadOnlyList<ActionReceipt> actions,
            TransactionActionRunner.TransactionOperationReceipt assimilate,
            TransactionActionRunner.TransactionOperationReceipt rollback,
            string phase)
        {
            var actionWire = new List<object>(actions.Count);
            foreach (var action in actions) actionWire.Add(action.ToWireObject());

            return new
            {
                phase,
                start = groupStart.ToWireObject(),
                actions = actionWire,
                assimilate = assimilate.ToWireObject(),
                rollback = rollback.ToWireObject()
            };
        }

        private static TransactionDiffRecorder.CaptureOptions BuildDiffOptions(DiffOptions? diff)
        {
            var limits = TransactionDiffLimits.Create(
                maxTrackedElementIds: diff?.maxTrackedElementIds,
                maxCreated: diff?.maxCreated,
                maxDeleted: diff?.maxDeleted,
                maxModified: diff?.maxModified,
                maxParameterDeltas: diff?.maxParameterDeltas,
                maxGeometryDeltas: diff?.maxGeometryDeltas,
                maxViewSheetChanges: diff?.maxViewSheetChanges,
                maxWatchElementsPerScope: diff?.maxWatchElementsPerScope);

            return new TransactionDiffRecorder.CaptureOptions
            {
                limits = limits,
                includeParameterDeltas = diff?.includeParameterDeltas ?? true,
                includeGeometryDeltas = diff?.includeGeometryDeltas ?? true,
                includeViewSheetChanges = diff?.includeViewSheetChanges ?? true,
                persistArtifact = diff?.persistArtifact ?? true,
                artifactFolder = string.IsNullOrWhiteSpace(diff?.artifactFolder) ? null : diff?.artifactFolder?.Trim()
            };
        }

        private static object? TryWriteDiffArtifact(
            string transactionId,
            bool success,
            bool rolledBack,
            string impactState,
            object transactionReceipt,
            TransactionDiffRecorder.CaptureOptions options,
            TransactionDiffRecorder.TransactionDiffScopeResult? sessionDiff,
            IReadOnlyList<TransactionDiffRecorder.TransactionDiffScopeResult> stepDiffs,
            List<string> warnings,
            string? error)
        {
            if (!options.persistArtifact) return null;

            try
            {
                var folder = WorkspacePaths.ResolveDirectoryUnderWorkspace(options.artifactFolder, "artifacts", "transaction-diffs");
                var stamp = DateTime.UtcNow.ToString("yyyyMMdd_HHmmss", CultureInfo.InvariantCulture);
                var path = Path.Combine(folder, $"transaction_diff_{stamp}_{transactionId}.json");

                var payload = new
                {
                    transactionId,
                    generatedAtUtc = DateTime.UtcNow,
                    success,
                    rolledBack,
                    impactState,
                    error,
                    transaction = transactionReceipt,
                    options = options.ToWireObject(),
                    summary = new
                    {
                        stepCount = stepDiffs?.Count ?? 0,
                        warnings = warnings?.Count ?? 0
                    },
                    session = sessionDiff,
                    steps = stepDiffs,
                    warnings
                };

                var json = JsonSerializer.Serialize(payload, new JsonSerializerOptions { WriteIndented = true });
                File.WriteAllText(path, json, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));

                return new
                {
                    type = "transactionDiff",
                    path,
                    workspaceRelativePath = ToWorkspaceRelative(path)
                };
            }
            catch (Exception ex)
            {
                warnings.Add($"Failed to persist transaction diff artifact: {ex.Message}");
                return null;
            }
        }

        private static string? ToWorkspaceRelative(string fullPath)
        {
            try
            {
                var root = WorkspacePaths.GetWorkspaceRoot().TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                var full = Path.GetFullPath(fullPath).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                if (!full.StartsWith(root, StringComparison.OrdinalIgnoreCase)) return null;
                var rel = full.Substring(root.Length).TrimStart(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
                return rel.Replace('\\', '/');
            }
            catch
            {
                return null;
            }
        }
    }
}
