using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic;

namespace RevitBridge.Handlers
{
    public sealed class InspectDrawingSpecHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = DrawingSpecInspectionRequest.Parse(jsonData);
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var state = DrawingSpecNativeImportState.ReadById(document, p.manifestElementId);
            var path = WorkspacePaths.ResolveExistingFileUnderWorkspace(p.sourcePath.Trim());
            if (new FileInfo(path).Length > 64 * 1024 * 1024) throw new InvalidOperationException("Source exceeds64MiB; no text was clipped.");
            var source = ImportDrawingSpecHandler.ReadSource(path);
            var fallback = document.GetElement(document.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)) as TextNoteType
                ?? throw new InvalidOperationException("No native fallback text type for legacy source projection.");
            string font = state.SourceFallbackFont ?? fallback.get_Parameter(BuiltInParameter.TEXT_FONT).AsString();
            double points = state.SourceFallbackPoints ?? DrawingSpecNativeFontProfile.Capture(font).SourcePoints(fallback.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble());
            var paragraphs = source.Blocks.Where(b => b.Kind == "paragraph").Select(b => DrawingSpecRichParagraph.Build(b, font, points)).ToArray();
            var expected = paragraphs.ToDictionary(item => item.SourceId);
            bool projectionMatches;
            using (var stored = JsonDocument.Parse(state.SourceBlocksJson))
            {
                var rows = stored.RootElement.EnumerateArray().ToArray();
                projectionMatches = rows.Length == paragraphs.Length && rows.Select(r => r.GetProperty("sourceId").GetString()).Distinct().Count() == rows.Length && rows.All(row =>
                    expected.TryGetValue(row.GetProperty("sourceId").GetString() ?? "", out var paragraph) &&
                    row.GetProperty("nativeTextSha256").GetString() == DrawingSpecNativeImportState.Hash(paragraph.NativeText) &&
                    row.GetProperty("sourceFormattingSha256").GetString() == DrawingSpecNativeImportState.Hash(JsonSerializer.Serialize(paragraph)));
            }
            var inspection = DrawingSpecNativeInspection.Read(document, state, paragraphs);
            string? currentNativeHash = null, snapshotError = null;
            try { currentNativeHash = DrawingSpecNativeImportState.CurrentSnapshotHash(document, state); }
            catch (InvalidOperationException ex) { snapshotError = ex.Message; }
            string snapshot = DrawingSpecNativeImportState.Hash(JsonSerializer.Serialize(new { source.SourceSha256, state,
                notes = inspection.Notes, checks = inspection.Checks }));
            bool stale = p.expectedSnapshotSha256 != null && p.expectedSnapshotSha256 != snapshot;
            int offset = p.pageOffset ?? 0, limit = p.pageSize ?? 20, bytes = 0, next = offset;
            if (offset > state.Notes.Count) throw new ArgumentException("Inspection page starts beyond the retained note list.");
            var byId = inspection.Notes.ToDictionary(n => n.Id);
            var page = new List<object>();
            if (!stale) foreach (var record in state.Notes.Skip(offset).Take(limit))
            {
                var paragraph = expected.TryGetValue(record.SourceId, out var value) ? value : null;
                var text = paragraph != null && record.Start >= 0 && record.Length > 0 && record.Start <= paragraph.NativeText.Length - record.Length
                    ? paragraph.NativeText.Substring(record.Start, record.Length) : null;
                var row = new { sourceId = record.SourceId, start = record.Start, length = record.Length, expectedText = text,
                    expectedSourceRanges = text == null ? null : paragraph!.Slice(record.Start, record.Length),
                    observed = byId.TryGetValue(record.Id, out var note) ? note : null, missing = !byId.ContainsKey(record.Id) };
                int size = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(row));
                if (size > 256 * 1024) throw new InvalidOperationException("One native fragment exceeds the explicit inspection-page bound; no field was clipped.");
                if (bytes + size > 256 * 1024) break;
                page.Add(row); bytes += size; next++;
            }
            return Task.FromResult<object>(new { schema = "operator.drawing_spec_inspection.v1", status = stale ? "StaleInspection" : "Ok", read_only = true,
                manifestElementId = state.StorageId, manifestUniqueId = document.GetElement(ElementIdCompat.Create(state.StorageId)).UniqueId,
                sourcePath = p.sourcePath, sourceSha256 = source.SourceSha256, retainedSourceSha256 = state.SourceSha256,
                sourceFileMatchesImport = source.SourceSha256 == state.SourceSha256, sourceProjectionMatchesImport = projectionMatches,
                sourceBodyComplete = source.BodyTextComplete && source.Blocks.All(b => b.Kind == "paragraph" || b.Kind == "section_properties"),
                sourceWarnings = source.Warnings, checks = inspection.Checks, currentNativeSnapshotSha256 = currentNativeHash,
                nativeSnapshotMatchesImport = currentNativeHash != null && currentNativeHash == state.NativeStateSha256, snapshotError,
                inspectionSnapshotSha256 = snapshot, completeNativeRead = true,
                viewIds = state.ViewIds, observedNoteIds = inspection.Notes.Select(n => n.Id).ToArray(),
                notesPage = page, offset, nextOffset = stale || next >= state.Notes.Count ? (int?)null : next,
                hasMore = !stale && next < state.Notes.Count, totalNotes = state.Notes.Count,
                limits = new[] { "Source text/run-format/ownership checks and allocated-column geometry screens only.",
                    "Legacy manifests without column geometry report bounds/order unavailable, never passed.",
                    "Paragraph/tab positioning, overlaps with unrelated annotations, visual fidelity, engineering suitability, sheet placement and whole-task completion remain separate checks." } });
        }
    }
}
