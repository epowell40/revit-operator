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

                    var transactionReceipt = BuildTransactionReceipt(
                        groupStartReceipt,
                        actionReceipts,
                        assimilateReceipt,
                        rollbackReceipt);

                    artifact = TryWriteDiffArtifact(
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

                    return Task.FromResult<object>(new
                    {
                        success = true,
                        transactionId = transactionId,
                        impactState = "committed",
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
                        warnings = warnings,
                        artifacts = artifact == null ? Array.Empty<object>() : new object[] { artifact }
                    });
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

                    TryRollback(tg, rollbackReceipt);
                    var failureError = TransactionActionRunner.BuildFailureError(ex.Message, rollbackReceipt);
                    if (!warnings.Contains(ex.Message)) warnings.Add(ex.Message);
                    if (!string.Equals(failureError, ex.Message, StringComparison.Ordinal) && !warnings.Contains(failureError))
                        warnings.Add(failureError);

                    var transactionReceipt = BuildTransactionReceipt(
                        groupStartReceipt,
                        actionReceipts,
                        assimilateReceipt,
                        rollbackReceipt);
                    var impactState = rollbackReceipt.VerifiedRolledBack ? "rolledBack" : "notCommittedOrUnknown";

                    artifact = TryWriteDiffArtifact(
                        transactionId: transactionId,
                        success: false,
                        rolledBack: rollbackReceipt.VerifiedRolledBack,
                        impactState: impactState,
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
                        impactState = impactState,
                        impact = impact.ToWireObject(),
                        transaction = transactionReceipt,
                        diff = new
                        {
                            rolledBack = rollbackReceipt.VerifiedRolledBack,
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
                receipt.Status = SafeStatus(group, receipt.Status);
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
                receipt.Status = SafeStatus(transaction, receipt.Status);
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
                receipt.Status = SafeStatus(transaction, receipt.Status);
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
                receipt.Status = SafeStatus(group, receipt.Status);
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
                receipt.VerifiedRolledBack = status == TransactionStatus.RolledBack;
                if (!receipt.Succeeded)
                    receipt.Error = $"transaction group rollback returned status '{receipt.Status}', expected 'RolledBack'.";
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                receipt.Status = SafeStatus(group, receipt.Status);
                receipt.VerifiedRolledBack = string.Equals(receipt.Status, TransactionStatus.RolledBack.ToString(), StringComparison.Ordinal);
                receipt.Succeeded = receipt.VerifiedRolledBack;
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
                receipt.VerifiedRolledBack = status == TransactionStatus.RolledBack;
                if (!receipt.Succeeded)
                    receipt.Error = $"action transaction rollback returned status '{receipt.Status}', expected 'RolledBack'.";
            }
            catch (Exception ex)
            {
                receipt.Error = ex.Message;
                receipt.Status = SafeStatus(transaction, receipt.Status);
                receipt.VerifiedRolledBack = string.Equals(receipt.Status, TransactionStatus.RolledBack.ToString(), StringComparison.Ordinal);
                receipt.Succeeded = receipt.VerifiedRolledBack;
            }
        }

        private static void RecordExpectedStatus(TransactionActionRunner.TransactionOperationReceipt receipt, TransactionStatus actual, TransactionStatus expected)
        {
            receipt.Status = actual.ToString();
            receipt.Succeeded = actual == expected;
            receipt.VerifiedRolledBack = actual == TransactionStatus.RolledBack;
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

        private static string SafeStatus(TransactionGroup group, string fallback)
        {
            var status = SafeGetStatus(group, out _);
            return status?.ToString() ?? fallback;
        }

        private static string SafeStatus(Transaction transaction, string fallback)
        {
            var status = SafeGetStatus(transaction, out _);
            return status?.ToString() ?? fallback;
        }

        private static object BuildTransactionReceipt(
            TransactionActionRunner.TransactionOperationReceipt groupStart,
            IReadOnlyList<ActionReceipt> actions,
            TransactionActionRunner.TransactionOperationReceipt assimilate,
            TransactionActionRunner.TransactionOperationReceipt rollback)
        {
            var actionWire = new List<object>(actions.Count);
            foreach (var action in actions) actionWire.Add(action.ToWireObject());

            return new
            {
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
