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
        public sealed class Params
        {
            public long manifestElementId { get; set; }
            public int? partIndex { get; set; }
            public int offset { get; set; }
            public int limit { get; set; } = 20;
        }
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var r = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Vector inspection requires exact manifestElementId.");
            if (r.manifestElementId <= 0 || r.partIndex < 0 || r.offset < 0 || r.limit < 1 || r.limit > 100) throw new ArgumentException("Exact manifest and bounded whole-record page required.");
            var doc = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit project.");
            var state = VectorDraftingImportState.Read(doc, r.manifestElementId); var plan = VectorDraftingImportState.Plan(state);
            string? snapshot = null, snapshotError = null;
            try { snapshot = VectorDraftingImportState.CurrentSnapshot(doc, state); }
            catch (Exception error) { snapshotError = error.Message; }
            bool sourceCurrent = false; string? sourceError = null;
            try { using var file = new FileStream(VectorDraftingPlanCodec.SourceFile(state.SourcePath, false), FileMode.Open, FileAccess.Read, FileShare.Read); sourceCurrent = VectorDraftingPlanCodec.Hash(VectorDraftingPlanCodec.ReadBounded(file, 32 * 1024 * 1024)) == state.SourceSha256; }
            catch (Exception error) { sourceError = error.Message; }
            var part = r.partIndex.HasValue ? state.Parts.SingleOrDefault(p => p.Index == r.partIndex.Value) ?? throw new ArgumentException("Requested vector part is not imported.") : null;
            if (part != null && r.offset > part.Entities.Count) throw new ArgumentException("Vector source page offset exceeds complete part content.");
            return Task.FromResult<object>(new { schema = "operator.vector-drafting-native-inspection.v1", manifestElementId = state.StorageId,
                viewId = state.ViewId, viewName = state.ViewName, sourcePath = state.SourcePath, sourceSha256 = state.SourceSha256, nativePlanSha256 = state.NativePlanSha256,
                sourceFileCurrent = sourceCurrent, sourceFileError = sourceError, nativeSnapshotMatchesImport = snapshotError == null, snapshotError, importSnapshotSha256 = snapshot,
                sourceGeometryIndependentlyReparsed = false, visualVerified = false, sourceOmissions = plan.omissions, nativePlanLimits = plan.limits,
                expectedContentCount = plan.entities.Count, importedContentCount = state.Parts.Sum(p => p.Entities.Count), partsTotal = plan.partCount,
                completedPartIndices = state.Parts.Select(p => p.Index).ToArray(), remainingPartIndices = Enumerable.Range(0, plan.partCount).Except(state.Parts.Select(p => p.Index)).ToArray(),
                partIndex = r.partIndex, partNativeSnapshotSha256 = part?.NativeSnapshotSha256, offset = r.offset, totalPartContent = part?.Entities.Count,
                sourceProjection = part == null ? null : VectorDraftingNativeProjection.Check(doc, state, part),
                items = part?.Entities.Skip(r.offset).Take(r.limit).Select(e => ReadEntityOrError(doc, state, e)).ToArray(),
                nextOffset = part != null && r.offset + r.limit < part.Entities.Count ? r.offset + r.limit : (int?)null,
                scope = "complete_owned_native_snapshot_against_retained_import_not_independent_source_or_visual_verification" });
        }
        private static object ReadEntityOrError(Document doc, VectorDraftingStoredImport state, VectorDraftingOwnedEntity owned)
        {
            try { return VectorDraftingImportState.ReadEntity(doc, state, owned); }
            catch (Exception error) { return new { owned.Id, owned.UniqueId, owned.PlanEntityId, owned.SourceId, owned.Kind, readFailed = true, error = error.Message }; }
        }
    }
}
