using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Handlers
{
    /// <summary>Only native text/fills/dots from an unchanged complete PDF plan.
    /// It cannot create source strokes or re-enable the withheld stroke importer.</summary>
    public sealed class ImportVectorAnnotationsHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
            => Task.FromResult(NativeMutationPreflightBoundary.Execute(enter => Execute(app, jsonData, enter)));
        private static object Execute(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var request = VectorDraftingAnnotationRequest.Parse(jsonData);
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit project.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Source annotations require a project document.");
            var view = doc.GetElement(ElementIdCompat.Create(request.viewId)) as ViewDrafting;
            if (view == null || view.IsTemplate || view.UniqueId != request.expectedViewUniqueId)
                throw new InvalidOperationException("Exact native drafting owner view identity required.");
            string sourcePath = VectorDraftingPlanCodec.SourceFile(request.sourcePath, false), planPath = VectorDraftingPlanCodec.SourceFile(request.nativePlanPath, true);
            using (var file = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var bytes = VectorDraftingPlanCodec.ReadBounded(file, 32 * 1024 * 1024);
                if (bytes.Length < 5 || System.Text.Encoding.ASCII.GetString(bytes, 0, 5) != "%PDF-" || VectorDraftingPlanCodec.Hash(bytes) != request.expectedSourceSha256)
                    throw new InvalidOperationException("Original PDF changed; source annotations were not dispatched.");
            }
            byte[] packed;
            using (var file = new FileStream(planPath, FileMode.Open, FileAccess.Read, FileShare.Read)) packed = VectorDraftingPlanCodec.ReadBounded(file, VectorDraftingPlanCodec.MaximumBytes);
            var plan = VectorDraftingPlanCodec.Decode(packed, request.expectedNativePlanFileSha256, request.expectedNativePlanSha256, request.expectedSourceSha256);
            var expected = VectorDraftingAnnotationPolicy.Part(plan, request.partIndex);
            var count = VectorDraftingAnnotationPolicy.Entities(plan).Length; int parts = VectorDraftingAnnotationPolicy.PartCount(plan);
            if (view.Scale != plan.layout.viewScale) throw new InvalidOperationException("Native owner view scale differs from the complete source plan; no existing view scale was changed.");
            var key = VectorDraftingPlanCodec.Hash(VectorDraftingAnnotationPolicy.Renderer + ":" + view.UniqueId + ":" + plan.nativePlanSha256);
            var prior = request.manifestElementId.HasValue ? VectorDraftingImportState.Read(doc, request.manifestElementId.Value)
                : VectorDraftingImportState.All(doc).SingleOrDefault(s => s.ImportKey == key);
            string? snapshot = null;
            if (prior != null)
            {
                if (prior.ImportKey != key || prior.Renderer != VectorDraftingAnnotationPolicy.Renderer || prior.ViewId != request.viewId
                    || prior.ViewUniqueId != request.expectedViewUniqueId || prior.SourceSha256 != request.expectedSourceSha256
                    || prior.SourcePath != request.sourcePath || prior.NativePlanPath != request.nativePlanPath
                    || prior.NativePlanFileSha256 != request.expectedNativePlanFileSha256 || prior.NativePlanSha256 != request.expectedNativePlanSha256)
                    throw new InvalidOperationException("Owned annotation source/representation/owner changed; do not duplicate or overwrite it.");
                snapshot = VectorDraftingImportState.CurrentSnapshot(doc, prior);
                if (request.expectedImportSnapshotSha256 != null && snapshot != request.expectedImportSnapshotSha256)
                    throw new InvalidOperationException("Owned native annotation state changed; inspect/reconcile before continuation.");
            }
            var existing = prior?.Parts.SingleOrDefault(p => p.Index == request.partIndex);
            if (request.dryRun || existing != null)
                return new { status = request.dryRun ? "Dry Run" : "Success", applied = false, dryRun = request.dryRun, previewExecuted = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(), alreadyImported = existing != null, renderer = VectorDraftingAnnotationPolicy.Renderer,
                    manifestElementId = prior?.StorageId, viewId = request.viewId, viewUniqueId = request.expectedViewUniqueId,
                    partIndex = request.partIndex, partsTotal = parts, expectedContentCount = count, sourcePlanEntityCount = plan.entities.Count,
                    expectedPartEntityIds = expected.Select(e => e.id).ToArray(), nextPartIndex = prior?.Parts.Count ?? 0, importSnapshotSha256 = snapshot,
                    limits = new[] { "No annotation preview/model mutation ran. Existing parts are not replayed.", "This representation cannot create source strokes; whole drawing coverage and visuals are separate." } };
            if (prior != null && !request.manifestElementId.HasValue) throw new InvalidOperationException("Continue with exact owned manifest/snapshot; do not start a duplicate annotation import.");
            if (request.partIndex != (prior?.Parts.Count ?? 0)) throw new ArgumentException("Source annotation parts must continue in exact source order.");
            var fonts = VectorDraftingNativeRenderer.PreflightAnnotations(doc, plan);
            var guard = new OperatorNativeFailureGuard(); VectorDraftingStoredImport? state = prior; VectorDraftingOwnedPart? part = null;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Import source PDF annotation part", created =>
            {
                if (state == null) state = new VectorDraftingStoredImport { ImportKey = key, Renderer = VectorDraftingAnnotationPolicy.Renderer,
                    SourcePath = request.sourcePath, SourceSha256 = request.expectedSourceSha256, NativePlanPath = request.nativePlanPath,
                    NativePlanFileSha256 = request.expectedNativePlanFileSha256, NativePlanSha256 = request.expectedNativePlanSha256,
                    PlanPackedBase64 = Convert.ToBase64String(packed), ViewId = request.viewId, ViewUniqueId = view.UniqueId, ViewName = view.Name, ViewScale = view.Scale };
                part = new VectorDraftingNativeRenderer(doc, view, state, created, fonts).RenderAnnotations(plan, request.partIndex);
                VectorDraftingImportState.CurrentSnapshot(doc, state);
                VectorDraftingNativeProjection.RequireMatchBeforeCommit(doc, state, part);
                part.NativeSnapshotSha256 = VectorDraftingImportState.PartSnapshot(doc, state, part); state.Parts.Add(part);
                VectorDraftingImportState.Store(doc, state, created);
                return new Dictionary<string, object?> { ["renderer"] = VectorDraftingAnnotationPolicy.Renderer,
                    ["manifestElementId"] = state.StorageId, ["viewId"] = state.ViewId, ["viewUniqueId"] = state.ViewUniqueId, ["viewName"] = state.ViewName,
                    ["partIndex"] = request.partIndex, ["partsTotal"] = parts, ["completedParts"] = state.Parts.Count,
                    ["nextPartIndex"] = state.Parts.Count < parts ? state.Parts.Count : (int?)null,
                    ["remainingPartIndices"] = Enumerable.Range(state.Parts.Count, parts - state.Parts.Count).ToArray(),
                    ["sourceSha256"] = state.SourceSha256, ["sourcePath"] = state.SourcePath, ["nativePlanSha256"] = state.NativePlanSha256,
                    ["nativePlanFileSha256"] = state.NativePlanFileSha256, ["createdEntityIds"] = part.Entities.Select(e => e.Id).ToArray(),
                    ["createdSourceEntityIds"] = part.Entities.Select(e => e.PlanEntityId).ToArray(), ["createdContentCount"] = part.Entities.Count,
                    ["expectedContentCount"] = count, ["sourcePlanEntityCount"] = plan.entities.Count,
                    ["contentKindCounts"] = part.Entities.GroupBy(e => e.Kind).ToDictionary(g => g.Key, g => g.Count()),
                    ["nextAction"] = "Inspect the exact manifest/part against the original PDF. Continue with the fresh snapshot, inspect the actual owner view and separately verify source strokes, full drawing coverage and saved/reopened delivery." };
            }, configureTransaction: tx => NativeNonInteractiveFailureHandling.Configure(tx, guard));
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                if (state == null || part == null) throw new InvalidOperationException("Committed source annotation ownership is missing.");
                return new Dictionary<string, object?> { ["importSnapshotSha256"] = VectorDraftingImportState.CurrentSnapshot(doc, state),
                    ["partNativeSnapshotSha256"] = VectorDraftingImportState.PartSnapshot(doc, state, part),
                    ["nativeSnapshotScope"] = "source_text_fills_dots_only_not_strokes_original_pdf_reparse_or_visual_verification" };
            });
            result["nativeFailures"] = guard.Failures; result.Remove("verified"); result.Remove("ok");
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"); return result;
        }
    }
}
