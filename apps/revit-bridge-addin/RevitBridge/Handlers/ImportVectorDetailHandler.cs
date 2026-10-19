using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Handlers
{
    public sealed class ImportVectorDetailHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(NativeMutationPreflightBoundary.Execute(enter => Execute(app, jsonData, enter)));
        private static object Execute(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var request = VectorDraftingImportRequest.Parse(jsonData);
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit project.");
            if (doc.IsFamilyDocument) throw new InvalidOperationException("Vector detail import requires a project document.");
            string sourcePath = VectorDraftingPlanCodec.SourceFile(request.sourcePath, false), planPath = VectorDraftingPlanCodec.SourceFile(request.nativePlanPath, true);
            using (var file = new FileStream(sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read))
            {
                var bytes = VectorDraftingPlanCodec.ReadBounded(file, 32 * 1024 * 1024);
                if (bytes.Length < 5 || System.Text.Encoding.ASCII.GetString(bytes, 0, 5) != "%PDF-" || VectorDraftingPlanCodec.Hash(bytes) != request.expectedSourceSha256)
                    throw new InvalidOperationException("Original registered PDF changed or is not a PDF; no model mutation dispatched.");
            }
            byte[] packed; using (var file = new FileStream(planPath, FileMode.Open, FileAccess.Read, FileShare.Read)) packed = VectorDraftingPlanCodec.ReadBounded(file, VectorDraftingPlanCodec.MaximumBytes);
            var plan = VectorDraftingPlanCodec.Decode(packed, request.expectedNativePlanFileSha256, request.expectedNativePlanSha256, request.expectedSourceSha256);
            if (request.partIndex >= plan.partCount) throw new ArgumentException("Native vector partIndex exceeds complete source plan.");
            string key = VectorDraftingPlanCodec.Hash("operator.vector-drafting-native.v1:" + request.viewName.Trim().ToUpperInvariant());
            var prior = request.manifestElementId.HasValue ? VectorDraftingImportState.Read(doc, request.manifestElementId.Value)
                : VectorDraftingImportState.All(doc).SingleOrDefault(s => s.ImportKey == key);
            string? snapshot = null;
            if (prior != null)
            {
                if (prior.ImportKey != key || prior.SourceSha256 != request.expectedSourceSha256 || prior.NativePlanFileSha256 != request.expectedNativePlanFileSha256
                    || prior.NativePlanSha256 != request.expectedNativePlanSha256 || prior.Renderer != "operator.vector-drafting-native.v1")
                    throw new InvalidOperationException("Existing vector import source/settings differ; no owned content was overwritten or duplicated.");
                snapshot = VectorDraftingImportState.CurrentSnapshot(doc, prior);
                if (request.expectedImportSnapshotSha256 != null && snapshot != request.expectedImportSnapshotSha256)
                    throw new InvalidOperationException("Vector native state changed; inspect its current exact state before continuation.");
            }
            var existing = prior?.Parts.SingleOrDefault(p => p.Index == request.partIndex);
            if (request.dryRun || existing != null)
                return new { status = request.dryRun ? "Dry Run" : "Success", applied = false, dryRun = request.dryRun, previewExecuted = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(), alreadyImported = existing != null,
                    manifestElementId = prior?.StorageId, viewId = prior?.ViewId, partIndex = request.partIndex, partsTotal = plan.partCount,
                    nextPartIndex = prior?.Parts.Count ?? 0, importSnapshotSha256 = snapshot,
                    limits = new[] { "No native preview/model mutation ran. Inspect an already-imported part rather than repeating it.", "Native/source artifact readback is separate from source re-extraction, visual comparison and sheet placement." } };
            if (prior != null && !request.manifestElementId.HasValue) throw new InvalidOperationException("Continue exact managed manifestElementId with its current snapshot; do not start a second import.");
            if (request.partIndex != (prior?.Parts.Count ?? 0)) throw new ArgumentException("Import vector parts in source order using nextPartIndex.");
            var family = new FilteredElementCollector(doc).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().Where(t => t.ViewFamily == ViewFamily.Drafting).OrderBy(t => ElementIdCompat.GetValue(t.Id)).FirstOrDefault()
                ?? throw new InvalidOperationException("No native drafting view family type.");
            if (prior == null && new FilteredElementCollector(doc).OfClass(typeof(View)).Cast<View>().Any(v => string.Equals(v.Name, request.viewName.Trim(), StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("View name already exists without this exact managed import. Choose a new name; no unowned view changed.");
            var fonts = VectorDraftingNativeRenderer.Preflight(doc, plan);
            var guard = new OperatorNativeFailureGuard(); VectorDraftingStoredImport? stored = prior; VectorDraftingOwnedPart? part = null;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, doc, "Import editable PDF vector detail part", created =>
            {
                ViewDrafting view;
                if (stored == null)
                {
                    view = ViewDrafting.Create(doc, family.Id); view.Name = request.viewName.Trim(); view.Scale = plan.layout.viewScale; created.Add(ElementIdCompat.GetValue(view.Id));
                    stored = new VectorDraftingStoredImport { ImportKey = key, SourcePath = request.sourcePath, SourceSha256 = request.expectedSourceSha256,
                        NativePlanPath = request.nativePlanPath, NativePlanFileSha256 = request.expectedNativePlanFileSha256, NativePlanSha256 = request.expectedNativePlanSha256,
                        PlanPackedBase64 = Convert.ToBase64String(packed), ViewId = ElementIdCompat.GetValue(view.Id), ViewUniqueId = view.UniqueId, ViewName = view.Name, ViewScale = view.Scale };
                }
                else view = VectorDraftingImportState.View(doc, stored);
                part = new VectorDraftingNativeRenderer(doc, view, stored, created, fonts).Render(plan, request.partIndex);
                // New curves must not silently alter a previously committed part, and a
                // mismatching new source projection must roll back before persistence.
                VectorDraftingImportState.CurrentSnapshot(doc, stored);
                VectorDraftingNativeProjection.RequireMatchBeforeCommit(doc, stored, part);
                part.NativeSnapshotSha256 = VectorDraftingImportState.PartSnapshot(doc, stored, part); stored.Parts.Add(part);
                VectorDraftingImportState.Store(doc, stored, created);
                return new Dictionary<string, object?> { ["manifestElementId"] = stored.StorageId, ["viewId"] = stored.ViewId, ["viewName"] = stored.ViewName,
                    ["partIndex"] = request.partIndex, ["partsTotal"] = plan.partCount, ["completedParts"] = stored.Parts.Count,
                    ["nextPartIndex"] = stored.Parts.Count < plan.partCount ? stored.Parts.Count : (int?)null,
                    ["sourceSha256"] = stored.SourceSha256, ["nativePlanSha256"] = stored.NativePlanSha256,
                    ["nativePlanFileSha256"] = stored.NativePlanFileSha256, ["sourcePath"] = stored.SourcePath,
                    ["remainingPartIndices"] = Enumerable.Range(stored.Parts.Count, plan.partCount - stored.Parts.Count).ToArray(),
                    ["createdEntityIds"] = part.Entities.Select(e => e.Id).ToArray(), ["createdContentCount"] = part.Entities.Count,
                    ["contentKindCounts"] = part.Entities.GroupBy(e => e.Kind).ToDictionary(g => g.Key, g => g.Count()),
                    ["paperWidthInches"] = plan.layout.paperWidthInches, ["paperHeightInches"] = plan.paperHeightInches, ["viewScale"] = view.Scale,
                    ["sourceOmissions"] = plan.omissions, ["sourceZeroLengthCommands"] = plan.zeroLengthSourceCommands, ["limits"] = plan.limits,
                    ["nextAction"] = "Inspect the exact manifest/part with /revit/inspect-vector-detail. Continue remaining parts using the fresh importSnapshotSha256, activate the actual work view for visual review/correction, then place/save and check the delivered sheet. Never retry an uncertain write." };
            }, configureTransaction: transaction => NativeNonInteractiveFailureHandling.Configure(transaction, guard));
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                if (stored == null || part == null) throw new InvalidOperationException("Committed vector part has no retained ownership.");
                string current = VectorDraftingImportState.CurrentSnapshot(doc, stored);
                return new Dictionary<string, object?> { ["importSnapshotSha256"] = current, ["partNativeSnapshotSha256"] = VectorDraftingImportState.PartSnapshot(doc, stored, part),
                    ["nativeSnapshotScope"] = "owned_native_content_and_types_against_retained_import_state_not_independent_pdf_or_visual_verification" };
            });
            result["nativeFailures"] = guard.Failures; result.Remove("verified"); result.Remove("ok"); result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success"); return result;
        }
    }
}
