using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic;

namespace RevitBridge.Handlers
{
    public sealed class InspectExcelImportHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var request = XlsxTableInspectionRequest.Parse(jsonData);var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            int offset = request.pageOffset ?? 0, size = request.pageSize ?? 50;
            if (request.action == "list")
            {
                var all = XlsxNativeImportState.All(document).OrderBy(s => s.StorageId).ToArray();if (offset > all.Length) throw new ArgumentException("Import index offset exceeds its current total.");
                var rows = all.Skip(offset).Take(size).Select(s => new { manifestElementId = s.StorageId, s.SourcePath, sourceSha256 = s.SourceSha256,
                    worksheet = s.Worksheet, viewName = s.ViewName, partsImported = s.Parts.Count, planSha256 = s.PlanSha256 }).ToArray();
                return Task.FromResult<object>(new { schema = "operator.xlsx_import_index.v1", status = "Ok", read_only = true, totalImports = all.Length,
                    imports = rows, offset, hasMore = offset + rows.Length < all.Length, nextOffset = offset + rows.Length < all.Length ? (int?)(offset + rows.Length) : null,
                    limits = new[] { "Ownership discovery only; inspect exact source and manifest for current state before continuation." } });
            }
            var root = XlsxNativeImportState.Read(document, request.manifestElementId!.Value);var plan = XlsxTablePlanCodec.Decode(root.PlanPacked, root.PlanSha256);
            var source = ImportExcelOutputHandler.ReadSource(request.sourcePath!, root.Worksheet);var projection = XlsxTableSourceProjection.Check(source, plan);
            string? importSnapshot = null, snapshotError = null;
            try { importSnapshot = XlsxNativeImportState.CurrentSnapshot(document, root); } catch (InvalidOperationException error) { snapshotError = error.Message; }
            XlsxStoredPart? part = null;XlsxNativeTableChecks? checks = null;List<DrawingSpecObservedNote>? notes = null;string? partSnapshot = null;
            var reference = request.partIndex.HasValue ? root.Parts.SingleOrDefault(p => p.Index == request.partIndex.Value) ?? throw new ArgumentException("Requested part has not been imported.") : null;
            if (reference != null)
            {
                part = XlsxNativeImportState.ReadPart(document, root, reference);var inspection = XlsxNativeTableInspection.Read(document, part.Layout, plan);checks = inspection.Checks;notes = inspection.Notes;
                try { partSnapshot = XlsxNativeTableSnapshot.Hash(document, part.Layout); } catch (InvalidOperationException error) { snapshotError ??= error.Message; }
            }
            string snapshot = XlsxTablePlanCodec.Hash(JsonSerializer.Serialize(new { source.SourceSha256, root, projection, importSnapshot, snapshotError, partSnapshot, checks, notes }));
            bool stale = request.expectedInspectionSnapshotSha256 != null && request.expectedInspectionSnapshotSha256 != snapshot;
            string section = request.section ?? "summary";IReadOnlyList<object> records = Array.Empty<object>();
            if (part != null && section != "summary")
                records = section == "notes" ? notes!.Cast<object>().ToArray() : section == "cells" ? plan.Pages.Single(p => p.Index == part.Layout.PageIndex).Cells.Cast<object>().ToArray()
                    : section == "borders" ? part.Layout.Borders.Cast<object>().ToArray() : checks!.Issues.Concat(projection.Issues).Cast<object>().ToArray();
            if (offset > records.Count && section != "summary") throw new ArgumentException("Part detail offset exceeds its current total.");
            var page = new List<object>();int bytes = 0, next = offset;
            if (!stale) foreach (var record in records.Skip(offset).Take(size))
            {
                int length = Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(record));
                if (length > 64 * 1024) throw new InvalidOperationException("One complete Excel inspection record exceeds64KiB; no field clipped.");
                if (bytes + length > 64 * 1024) break;page.Add(record);bytes += length;next++;
            }
            var response = new { schema = "operator.xlsx_import_inspection.v1", status = stale ? "StaleInspection" : "Ok", read_only = true,
                manifestElementId = root.StorageId, manifestUniqueId = document.GetElement(ElementIdCompat.Create(root.StorageId)).UniqueId,
                sourcePath = request.sourcePath, sourceSha256 = source.SourceSha256, retainedSourceSha256 = root.SourceSha256, worksheet = root.Worksheet,
                sourceFileMatchesImport = source.SourceSha256 == root.SourceSha256, sourceProjection = projection, planSha256 = root.PlanSha256,
                importSnapshotSha256 = importSnapshot, snapshotError, partsTotal = plan.Pages.Count, partsImported = root.Parts.Count,
                parts = root.Parts, remainingPartIndices = plan.Pages.Where(p => !root.Parts.Any(r => r.Index == p.Index)).Select(p => p.Index).ToArray(),
                nextPartIndex = plan.Pages.FirstOrDefault(p => !root.Parts.Any(r => r.Index == p.Index))?.Index,
                partIndex = reference?.Index, partManifestElementId = reference?.StorageId, partNativeSnapshotSha256 = partSnapshot,
                retainedPartNativeSnapshotSha256 = reference?.NativeSnapshotSha256, nativeSnapshotMatchesImport = partSnapshot != null && partSnapshot == reference?.NativeSnapshotSha256,
                completeNativePartRead = part != null && !stale, checks, observedNoteIds = notes?.Select(n => n.Id).ToArray(),
                observedBorderIds = part?.Layout.Borders.Where(b => document.GetElement(ElementIdCompat.Create(b.Id)) is Autodesk.Revit.DB.DetailCurve curve && curve.UniqueId == b.UniqueId).Select(b => b.Id).ToArray(),
                viewId = part?.Layout.ViewId, section, records = page, offset, totalRecords = records.Count, hasMore = !stale && next < records.Count,
                nextOffset = !stale && next < records.Count ? (int?)next : null, inspectionSnapshotSha256 = snapshot,
                sourceCachedErrorCount = source.SelectedSheet!.CachedErrorCount, calculationPerformed = false,
                limits = new[] { "Part-scoped source/native text, character formatting, cell bounds/order and border checks only; visual fidelity, sheet placement and engineering readiness require their own checks.", "Source cached errors remain explicit. A complete native part check is not whole-workbook completion." } };
            if (Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(response)) > 256 * 1024) throw new InvalidOperationException("Complete Excel inspection summary plus page exceeds256KiB; no fields clipped or partial verification returned.");
            return Task.FromResult<object>(response);
        }
    }
}
