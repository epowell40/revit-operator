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

            using (var recorder = new TransactionDiffRecorder(app, doc, diffOptions))
            using (var tg = new TransactionGroup(doc, $"Transaction Apply ({transactionId})"))
            {
                recorder.StartRecording(
                    scopeId: sessionScopeId,
                    scopeKind: "session",
                    watchElementIds: TransactionActionRunner.CollectWatchElementIds(actions, Math.Min(diffOptions.limits.MaxWatchElementsPerScope * 2, diffOptions.limits.MaxTrackedElementIds)));

                tg.Start();
                try
                {
                    for (int i = 0; i < actions.Count; i++)
                    {
                        var action = actions[i];
                        var actionKind = TransactionActionRunner.GetActionKind(action);
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
                                t.Start();
                                TransactionActionRunner.ExecuteAction(doc, action, impact, warnings, i);
                                t.Commit();
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
                    tg.Assimilate();

                    artifact = TryWriteDiffArtifact(
                        transactionId: transactionId,
                        success: true,
                        rolledBack: false,
                        options: diffOptions,
                        sessionDiff: sessionDiff,
                        stepDiffs: stepDiffs,
                        warnings: warnings,
                        error: null);

                    return Task.FromResult<object>(new
                    {
                        success = true,
                        transactionId = transactionId,
                        impact = impact.ToWireObject(),
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

                    try { tg.RollBack(); } catch { }
                    warnings.Add(ex.Message);

                    artifact = TryWriteDiffArtifact(
                        transactionId: transactionId,
                        success: false,
                        rolledBack: true,
                        options: diffOptions,
                        sessionDiff: sessionDiff,
                        stepDiffs: stepDiffs,
                        warnings: warnings,
                        error: ex.Message);

                    return Task.FromResult<object>(new
                    {
                        success = false,
                        transactionId = transactionId,
                        impact = impact.ToWireObject(),
                        diff = new
                        {
                            rolledBack = true,
                            options = diffOptions.ToWireObject(),
                            session = sessionDiff,
                            steps = stepDiffs,
                            artifact
                        },
                        warnings = warnings,
                        artifacts = artifact == null ? Array.Empty<object>() : new object[] { artifact },
                        error = ex.Message
                    });
                }
            }
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
                    error,
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
