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
    public sealed class ImportExcelOutputHandler : IRequestHandler
    {
        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(
            NativeMutationPreflightBoundary.Execute(enter => Execute(app, jsonData, enter)));
        private static object Execute(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var request = XlsxTableImportRequest.Parse(jsonData);
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var source = ReadSource(request.sourcePath, request.sheetName);
            if (source.SourceSha256 != request.expectedSourceSha256) throw new InvalidOperationException("Original workbook changed; inspect its exact current source before import. No mutation dispatched.");
            var sheet = source.SelectedSheet!;string key = request.viewName.Trim().ToUpperInvariant() + "\u001f" + sheet.Identity.Name.ToUpperInvariant();
            var prior = request.manifestElementId.HasValue ? XlsxNativeImportState.Read(document, request.manifestElementId.Value)
                : XlsxNativeImportState.All(document).SingleOrDefault(s => s.ImportKey == key);
            if (prior != null && (prior.ImportKey != key || prior.SourceSha256 != source.SourceSha256 || prior.Renderer != XlsxNativeTableLayout.RendererVersion))
                throw new InvalidOperationException("An existing Excel import has a different source/settings identity. Reconcile it or explicitly use a new viewName; do not duplicate or overwrite.");
            var retainedPlan = prior == null ? null : XlsxTablePlanCodec.Decode(prior.PlanPacked, prior.PlanSha256);
            string? currentSnapshot = prior == null ? null : XlsxNativeImportState.CurrentSnapshot(document, prior);
            if (request.expectedImportSnapshotSha256 != null && request.expectedImportSnapshotSha256 != currentSnapshot) throw new InvalidOperationException("Excel import snapshot changed; inspect before continuation.");
            var options = request.layout ?? retainedPlan?.Options ?? new XlsxTableLayoutOptions();
            options.Range ??= sheet.Bounds;options.MaximumDigitWidthPixels = XlsxNativeTableLayout.MaximumDigitWidth(source);
            var textType = prior == null ? ResolveType(document, request.textTypeName) : document.GetElement(ElementIdCompat.Create(prior.BaseTextTypeId)) as TextNoteType;
            if (textType == null || prior != null && textType.UniqueId != prior.BaseTextTypeUniqueId || request.textTypeName != null && textType.Name != request.textTypeName)
                throw new InvalidOperationException("Exact retained native base text type changed or was redirected.");
            var weights = request.borderWeights ?? prior?.BorderWeights ?? new Dictionary<string, int> { ["hair"] = 1, ["thin"] = 1, ["medium"] = 3, ["thick"] = 5 };
            string InputHash(XlsxTableLayoutOptions value) => XlsxTablePlanCodec.Hash(JsonSerializer.Serialize(new { source.SourceSha256, sheet.Identity.Name,
                renderer = XlsxNativeTableLayout.RendererVersion, viewName = request.viewName.Trim().ToUpperInvariant(), baseType = textType.UniqueId,
                range = new { value.Range!.FirstRow, value.Range.LastRow, value.Range.FirstColumn, value.Range.LastColumn }, value.PageWidthInches, value.PageHeightInches,
                value.PaddingPoints, value.MinimumTextPoints, value.MaximumDigitWidthPixels, value.RepeatHeaderRows, value.WrapOverflow,
                borderWeights = weights.OrderBy(p => p.Key).ToArray() }));
            string inputHash = InputHash(options);
            if (prior != null && prior.InputSha256 != inputHash) throw new InvalidOperationException("Imported source layout/font/border settings changed. Reconcile before continuing.");
            if (prior != null && request.partIndex >= retainedPlan!.Pages.Count) throw new ArgumentException("Requested part is outside the retained complete plan.");
            var existing = prior?.Parts.SingleOrDefault(p => p.Index == request.partIndex);
            if (request.dryRun || existing != null)
                return new { status = request.dryRun ? "Dry Run" : "Success", applied = false, dryRun = request.dryRun, previewExecuted = false,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(), sourceSha256 = source.SourceSha256, manifestElementId = prior?.StorageId,
                    partManifestElementId = existing?.StorageId, partIndex = request.partIndex, alreadyImported = existing != null, importSnapshotSha256 = currentSnapshot,
                    partsTotal = retainedPlan?.Pages.Count, nextPartIndex = retainedPlan?.Pages.FirstOrDefault(p => !prior!.Parts.Any(r => r.Index == p.Index))?.Index,
                    limits = new[] { "No native preview ran. A new source requires actual owned native text measurement before its readable part count is known.", "Inspect every created part, then place its view on a sheet and review visually; source errors are not engineering-ready values." } };
            if (prior != null && !request.manifestElementId.HasValue) throw new InvalidOperationException("Existing import continuation requires its exact manifestElementId and fresh snapshot.");
            int next = prior?.Parts.Count ?? 0;
            if (request.partIndex != next) throw new ArgumentException("Import parts in source order using the returned nextPartIndex.");
            string viewName = request.viewName.Trim() + " - " + (request.partIndex + 1).ToString("D3", System.Globalization.CultureInfo.InvariantCulture);
            if (new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Any(v => string.Equals(v.Name, viewName, StringComparison.OrdinalIgnoreCase)))
                throw new InvalidOperationException("Part view name already exists without this exact owned part; no unowned view was modified.");
            var family = new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().Where(t => t.ViewFamily == ViewFamily.Drafting).OrderBy(t => ElementIdCompat.GetValue(t.Id)).FirstOrDefault()
                ?? throw new InvalidOperationException("No native drafting view family type.");
            XlsxStoredImport? stored = null;XlsxStoredPartReference? reference = null;XlsxNativeTablePart? content = null;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, document, "Import editable Excel output part", created =>
            {
                var view = ViewDrafting.Create(document, family.Id);view.Name = viewName;view.Scale = 1;created.Add(ElementIdCompat.GetValue(view.Id));
                var renderer = new XlsxNativeTableLayout(document, view, textType, created);
                var plan = retainedPlan ?? renderer.Plan(source, options);
                if (request.partIndex >= plan.Pages.Count) throw new ArgumentException("Requested part is outside the measured native plan.");
                if (prior == null)
                {
                    var packed = XlsxTablePlanCodec.Encode(plan);
                    stored = new XlsxStoredImport { ImportKey = key, SourcePath = request.sourcePath, SourceSha256 = source.SourceSha256, Worksheet = sheet.Identity.Name,
                        InputSha256 = InputHash(plan.Options), PlanSha256 = packed.Sha256, PlanPacked = packed.Packed, ViewName = request.viewName.Trim(),
                        BaseTextTypeId = ElementIdCompat.GetValue(textType.Id), BaseTextTypeUniqueId = textType.UniqueId, BorderWeights = weights };
                    XlsxNativeImportState.StoreRoot(document, stored, created);
                }
                else stored = prior;
                content = renderer.Render(plan, request.partIndex, view, 0, 0, weights);
                reference = XlsxNativeImportState.StorePart(document, new XlsxStoredPart { ImportKey = key, SourceSha256 = source.SourceSha256,
                    PlanSha256 = stored.PlanSha256, Layout = content }, created);
                stored.Parts.Add(reference);XlsxNativeImportState.StoreRoot(document, stored, created, replace: true);
                if (created.Count + (prior == null ? 0 : 1) > 4096) throw new InvalidOperationException("Native affected inventory exceeded its complete settlement bound; part rolled back.");
                return new Dictionary<string, object?> { ["sourceSha256"] = source.SourceSha256, ["worksheet"] = sheet.Identity.Name,
                    ["manifestElementId"] = stored.StorageId, ["partManifestElementId"] = reference.StorageId, ["partIndex"] = request.partIndex,
                    ["planSha256"] = stored.PlanSha256, ["partsTotal"] = plan.Pages.Count, ["partsImported"] = stored.Parts.Count,
                    ["remainingPartIndices"] = plan.Pages.Where(p => !stored.Parts.Any(r => r.Index == p.Index)).Select(p => p.Index).ToArray(),
                    ["nextPartIndex"] = plan.Pages.FirstOrDefault(p => !stored.Parts.Any(r => r.Index == p.Index))?.Index,
                    ["viewId"] = content.ViewId, ["createdTextNoteIds"] = content.Notes.Select(n => n.Id).ToArray(), ["createdBorderIds"] = content.Borders.Select(b => b.Id).ToArray(),
                    ["nativeMetricProbes"] = content.NativeMetricProbes, ["sourceCellCount"] = sheet.Cells.Count, ["sourceCachedErrorCount"] = sheet.CachedErrorCount,
                    ["sourceMissingCacheCount"] = sheet.MissingFormulaCacheCount, ["calculationPerformed"] = false, ["sheetsPlaced"] = false,
                    ["remainingWork"] = new[] { "Inspect this exact part with inspect-excel-import; continue remaining parts using its fresh root snapshot.", "Place all continuation views on sheets and visually review the actual work. Cached source errors remain unresolved; no engineering completion is implied." } };
            }, nativeModifiedElements: () => prior == null ? Array.Empty<long>() : new[] { prior.StorageId });
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                if (stored == null || reference == null || content == null || XlsxNativeTableSnapshot.Hash(document, content) != reference.NativeSnapshotSha256) throw new InvalidOperationException("Committed Excel part differs from its retained native snapshot.");
                return new Dictionary<string, object?> { ["partNativeSnapshotSha256"] = reference.NativeSnapshotSha256, ["importSnapshotSha256"] = XlsxNativeImportState.CurrentSnapshot(document, stored),
                    ["nativeSnapshotScope"] = "owned_part_native_parameters_geometry_and_borders_not_independent_source_or_visual_verification" };
            });
            result.Remove("verified");result.Remove("ok");result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success");return result;
        }
        internal static XlsxOutputSourceManifest ReadSource(string sourcePath, string sheetName)
        {
            var path = WorkspacePaths.ResolveExistingFileUnderWorkspace(sourcePath.Trim());
            if (!string.Equals(Path.GetExtension(path), ".xlsx", StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("Excel output requires an .xlsx source under the workspace.");
            using var input = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);using var output = new MemoryStream();
            var buffer = new byte[8192];int count;
            while ((count = input.Read(buffer, 0, buffer.Length)) > 0)
            { if (output.Length + count > XlsxSourcePackage.MaxPackageBytes) throw new InvalidOperationException("Source exceeds64MiB; no source truncated.");output.Write(buffer, 0, count); }
            return XlsxOutputSourceReader.Read(output.ToArray(), sheetName);
        }
        private static TextNoteType ResolveType(Document document, string? name)
        {
            if (name != null) return new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().SingleOrDefault(t => t.Name == name)
                ?? throw new InvalidOperationException("Requested native text type is missing.");
            return document.GetElement(document.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)) as TextNoteType ?? throw new InvalidOperationException("No native default text type.");
        }
    }
}
