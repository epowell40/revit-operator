using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitBridge.Logic;

namespace RevitBridge.Handlers
{
    public sealed class InspectVectorDetailHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var r = VectorDraftingInspectionRequest.Parse(jsonData);
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit project.");
            if (r.action == "list")
            {
                var all = VectorDraftingImportState.All(doc); if (r.offset > all.Count) throw new ArgumentException("Vector list cursor exceeds complete inventory.");
                return Task.FromResult<object>(new { action = "list", read_only = true, total = all.Count, offset = r.offset,
                    imports = all.Skip(r.offset).Take(r.limit).Select(s => new { manifestElementId = s.StorageId, viewId = s.ViewId, viewName = s.ViewName,
                        sourcePath = s.SourcePath, sourceSha256 = s.SourceSha256, nativePlanSha256 = s.NativePlanSha256, importedParts = s.Parts.Count }).ToArray(),
                    nextOffset = r.offset + r.limit < all.Count ? r.offset + r.limit : (int?)null });
            }
            var state = VectorDraftingImportState.Read(doc, r.manifestElementId!.Value); var plan = VectorDraftingImportState.Plan(state);
            string? snapshot = null, snapshotError = null;
            try { snapshot = VectorDraftingImportState.CurrentSnapshot(doc, state); }
            catch (Exception error) { snapshotError = error.Message; }
            bool sourceCurrent = false; string? sourceError = null;
            try { using var file = new FileStream(VectorDraftingPlanCodec.SourceFile(state.SourcePath, false), FileMode.Open, FileAccess.Read, FileShare.Read); sourceCurrent = VectorDraftingPlanCodec.Hash(VectorDraftingPlanCodec.ReadBounded(file, 32 * 1024 * 1024)) == state.SourceSha256; }
            catch (Exception error) { sourceError = error.Message; }
            var part = r.partIndex.HasValue ? state.Parts.SingleOrDefault(p => p.Index == r.partIndex.Value) ?? throw new ArgumentException("Requested vector part is not imported.") : null;
            if (part != null && r.offset > part.Entities.Count) throw new ArgumentException("Vector source page offset exceeds complete part content.");
            return Task.FromResult<object>(new { schema = "operator.vector-drafting-native-inspection.v1", read_only = true, manifestElementId = state.StorageId,
                viewId = state.ViewId, viewName = state.ViewName, sourcePath = state.SourcePath, sourceSha256 = state.SourceSha256, nativePlanSha256 = state.NativePlanSha256,
                nativePlanPath = state.NativePlanPath, nativePlanFileSha256 = state.NativePlanFileSha256,
                sourceContext = new { sourcePlanSha256 = plan.sourcePlanSha256, selectionSha256 = plan.selectionSha256, sourceLabel = plan.sourceLabel,
                    sourceSheet = plan.sourceSheet, page = plan.page, region = plan.region, layout = plan.layout },
                sourceFileCurrent = sourceCurrent, sourceFileError = sourceError, nativeSnapshotMatchesImport = snapshotError == null, snapshotError, importSnapshotSha256 = snapshot,
                sourceGeometryIndependentlyReparsed = false, visualVerified = false, sourceOmissions = plan.omissions, nativePlanLimits = plan.limits,
                expectedContentCount = plan.entities.Count, importedContentCount = state.Parts.Sum(p => p.Entities.Count), partsTotal = plan.partCount,
                completedPartIndices = state.Parts.Select(p => p.Index).ToArray(), remainingPartIndices = Enumerable.Range(0, plan.partCount).Except(state.Parts.Select(p => p.Index)).ToArray(),
                partIndex = r.partIndex, partNativeSnapshotSha256 = part?.NativeSnapshotSha256, offset = r.offset, totalPartContent = part?.Entities.Count,
                sourceProjection = part == null ? null : VectorDraftingNativeProjection.Check(doc, state, part),
                observedEntityIds = part?.Entities.Select(e => e.Id).ToArray(),
                items = part != null && r.includeItems ? part.Entities.Skip(r.offset).Take(r.limit).Select(e => ReadEntityOrError(doc, state, e)).ToArray() : null,
                nextOffset = part != null && r.includeItems && r.offset + r.limit < part.Entities.Count ? r.offset + r.limit : (int?)null,
                scope = "complete_owned_native_snapshot_against_retained_import_not_independent_source_or_visual_verification" });
        }
        private static object ReadEntityOrError(Document doc, VectorDraftingStoredImport state, VectorDraftingOwnedEntity owned)
        {
            try { return VectorDraftingImportState.ReadEntity(doc, state, owned); }
            catch (Exception error) { return new { owned.Id, owned.UniqueId, owned.PlanEntityId, owned.SourceId, owned.Kind, readFailed = true, error = error.Message }; }
        }
    }
}
