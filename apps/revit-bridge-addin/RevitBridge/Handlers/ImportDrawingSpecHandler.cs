using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Xml.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Logic;
using RevitBridge.Logic.Handlers;

namespace RevitBridge.Handlers
{
    public sealed class ImportDrawingSpecHandler : IRequestHandler
    {
        public sealed class Params
        {
            public string? sourcePath { get; set; }
            public long? viewId { get; set; }
            public string? viewName { get; set; }
            public string? textTypeName { get; set; }
            public int? columns { get; set; }
            public double? columnWidthInches { get; set; }
            public double? columnHeightInches { get; set; }
            public double? gutterInches { get; set; }
            public double? marginInches { get; set; }
            public double? startXInches { get; set; }
            public double? startYInches { get; set; }
            public bool? dryRun { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData) => Task.FromResult(
            NativeMutationPreflightBoundary.Execute(enterNativeScope => Execute(app, jsonData, enterNativeScope)));

        private static object Execute(UIApplication app, string jsonData, Action enterNativeScope)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData) ?? throw new ArgumentException("Import body is required.");
            var document = app.ActiveUIDocument?.Document ?? throw new InvalidOperationException("No active Revit document.");
            var path = WorkspacePaths.ResolveExistingFileUnderWorkspace((p.sourcePath ?? "").Trim());
            if (new FileInfo(path).Length > 64 * 1024 * 1024) throw new InvalidOperationException("Specification source exceeds64MiB; no text was truncated.");
            var source = ReadSource(path);
            if (!source.BodyTextComplete || source.Blocks.Any(b => b.Kind != "paragraph" && b.Kind != "section_properties"))
                throw new InvalidOperationException("Source contains unresolved content or table layout. No partial body import was dispatched.");
            if (source.Warnings.Any(w => w.Code == "notes_require_placement_policy") || source.Parts.Any(part =>
                (part.Path.StartsWith("word/header", StringComparison.Ordinal) || part.Path.StartsWith("word/footer", StringComparison.Ordinal)) &&
                part.Xml != null && XDocument.Parse(part.Xml).Descendants(XName.Get("t", "http://schemas.openxmlformats.org/wordprocessingml/2006/main")).Any(t => t.Value.Length > 0)))
                throw new InvalidOperationException("Running matter or footnotes need explicit placement support; no content was silently omitted.");
            var baseType = ResolveType(document, p.textTypeName);
            var baseFont = DrawingSpecNativeFontProfile.Capture(baseType.get_Parameter(BuiltInParameter.TEXT_FONT).AsString());
            var paragraphs = source.Blocks.Where(b => b.Kind == "paragraph").Select(b => DrawingSpecRichParagraph.Build(b,
                baseType.get_Parameter(BuiltInParameter.TEXT_FONT).AsString(), baseFont.SourcePoints(baseType.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble()))).ToArray();
            if (!paragraphs.Any(item => !string.IsNullOrWhiteSpace(item.SourceText))) throw new InvalidOperationException("Specification has no body content.");
            var fonts = DrawingSpecNativeFontProfile.CaptureAll(paragraphs);
            if (paragraphs.Any(item => item.NativeText.Length > 1000000)) throw new InvalidOperationException("An individual source paragraph exceeds the bounded native layout limit; split it explicitly before import. No content was truncated.");
            var blockById = source.Blocks.ToDictionary(b => b.SourcePath);
            var sourceBlockManifest = JsonSerializer.Serialize(paragraphs.Select(item => new
            {
                sourceId = item.SourceId, blockById[item.SourceId].ContentSha256,
                nativeTextSha256 = DrawingSpecNativeImportState.Hash(item.NativeText), characters = item.NativeText.Length,
                sourceFormattingSha256 = DrawingSpecNativeImportState.Hash(JsonSerializer.Serialize(item))
            }));
            double margin = p.marginInches ?? .25;
            var geometry = new DrawingSpecFlowGeometry { Columns = p.columns ?? 4, ColumnWidthInches = (p.columnWidthInches ?? 8.5) - margin * 2,
                ColumnHeightInches = (p.columnHeightInches ?? 27) - margin * 2, GutterInches = (p.gutterInches ?? .25) + margin * 2 };
            DrawingSpecColumnFlow.Plan(Array.Empty<DrawingSpecFlowItem>(), geometry, (_, __, ___, ____) => throw new InvalidOperationException("Validation must not measure text."));
            double x = (p.startXInches ?? 0) + margin, y = (p.startYInches ?? 0) - margin;
            if (double.IsNaN(margin) || double.IsInfinity(margin) || margin < 0 || margin > 12 || !Finite(x) || !Finite(y)) throw new ArgumentException("Invalid printed margins/origin.");
            var target = p.viewId.HasValue ? document.GetElement(ElementIdCompat.Create(p.viewId.Value)) as View : null;
            if (p.viewId.HasValue && (target == null || target.IsTemplate || target.ViewType != ViewType.DraftingView)) throw new ArgumentException("viewId must identify a non-template drafting view.");
            string name = !string.IsNullOrWhiteSpace(p.viewName) ? p.viewName!.Trim() : target?.Name ?? "Drawing Spec " + Path.GetFileNameWithoutExtension(path);
            if (name.Length > 110) throw new ArgumentException("Specification view name exceeds110characters; no name was silently truncated.");
            string importKey = JsonSerializer.Serialize(new { filename = Path.GetFileName(path), viewId = p.viewId, name });
            string inputHash = DrawingSpecNativeImportState.Hash(JsonSerializer.Serialize(new { source.SourceSha256, renderer = DrawingSpecNativeLayout.RendererVersion, fonts = fonts.Values.Select(f => f.Signature).ToArray(), geometry, x, y, p.textTypeName }));
            var prior = DrawingSpecNativeImportState.Find(document, importKey);
            if (prior != null && (prior.InputSha256 != inputHash || prior.SourceSha256 != source.SourceSha256))
                throw new InvalidOperationException("Imported source/settings changed. Retain the prior result for managed-update reconciliation; do not duplicate or overwrite it.");
            if (prior != null && DrawingSpecNativeImportState.CurrentSnapshotHash(document, prior) != prior.NativeStateSha256)
                throw new InvalidOperationException("Imported native content changed since its saved manifest. Reconcile those edits before repeating the import.");
            var plan = new { sourcePath = p.sourcePath, sourceSha256 = source.SourceSha256, renderer = DrawingSpecNativeLayout.RendererVersion, paragraphs = paragraphs.Length,
                geometry, fontProfiles = fonts.Values.ToArray(), startXInches = x, startYInches = y, viewName = name,
                sourceWarnings = source.Warnings, sheetsPlaced = false, independentVerificationComplete = false };
            if (p.dryRun == true || prior != null)
                return new { status = p.dryRun == true ? "Dry Run" : "Success", dryRun = p.dryRun == true,
                    previewExecuted = false, applied = false, alreadyImported = prior != null,
                    transaction = OperatorNativeTransactionReceipt.NotStarted(), plan,
                    viewIds = prior?.ViewIds.ToArray() ?? Array.Empty<long>(), manifestElementId = prior?.StorageId };
            var family = new FilteredElementCollector(document).OfClass(typeof(ViewFamilyType)).Cast<ViewFamilyType>().FirstOrDefault(t => t.ViewFamily == ViewFamily.Drafting)
                ?? throw new InvalidOperationException("No drafting view family type.");
            if (target == null && ViewNameExists(document, name)) throw new InvalidOperationException("Target view name already exists without this import's ownership record. Select its viewId or use a new name.");
            DrawingSpecStoredImport? stored = null;
            enterNativeScope();
            var result = NativeSingleTransaction.Execute(app, document, "Import complete drawing specification", created =>
            {
                View Page(int page)
                {
                    if (page == 0 && target != null) return target;
                    string pageName = page == 0 ? name : name + " - " + (page + 1).ToString("D2");
                    if (ViewNameExists(document, pageName)) throw new InvalidOperationException("Continuation view name collides with unrelated work: " + pageName);
                    var view = ViewDrafting.Create(document, family.Id); view.Name = pageName; view.Scale = 1;
                    created.Add(ElementIdCompat.GetValue(view.Id)); return view;
                }
                var layout = DrawingSpecNativeLayout.Render(document, paragraphs, geometry, baseType, Page, created, x, y, fonts);
                stored = new DrawingSpecStoredImport { ImportKey = importKey, SourceSha256 = source.SourceSha256, InputSha256 = inputHash,
                    SourceFallbackFont = baseFont.FontFamily, SourceFallbackPoints = baseFont.SourcePoints(baseType.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble()),
                    FlowGeometry = geometry, StartXInches = x, StartYInches = y,
                    ViewIds = layout.ViewIds, Notes = layout.Notes, LayoutSpansJson = JsonSerializer.Serialize(layout.LayoutSpans),
                    SourceBlocksJson = sourceBlockManifest, SourceWarnings = source.Warnings.Select(w => w.Code + ":" + w.SourcePath).ToList() };
                stored.NativeStateSha256 = DrawingSpecNativeImportState.CurrentSnapshotHash(document, stored);
                DrawingSpecNativeImportState.Store(document, stored, created);
                return new Dictionary<string, object?> { ["viewId"] = layout.ViewIds[0], ["viewIds"] = layout.ViewIds,
                    ["createdTextNoteIds"] = layout.Notes.Select(n => n.Id).ToArray(), ["sourceSha256"] = source.SourceSha256,
                    ["manifestElementId"] = stored.StorageId, ["paragraphCount"] = paragraphs.Length, ["remainingParagraphCount"] = 0,
                    ["nativeMetricProbes"] = layout.NativeProbes, ["metricCacheEntries"] = layout.MetricCacheEntries,
                    ["sourceWarnings"] = source.Warnings, ["sheetsPlaced"] = false,
                    ["remainingWork"] = new[] { "Place continuation drafting views on appropriate sheets and review source/layout visually.", "Independent integral verification is still required." } };
            });
            OperatorNativeTransactionExecution.ReadCommitted(result, () =>
            {
                if (stored == null || DrawingSpecNativeImportState.CurrentSnapshotHash(document, stored) != stored.NativeStateSha256)
                    throw new InvalidOperationException("Committed imported text differs from its retained native snapshot.");
                return new Dictionary<string, object?> { ["nativeSnapshotSha256"] = stored.NativeStateSha256,
                    ["nativeSnapshotScope"] = "imported_text_parameters_and_character_status_not_visual_or_whole_task" };
            });
            result.Remove("verified"); result.Remove("ok");
            result["status"] = OperatorNativeTransactionExecution.OutcomeStatus(result, "Success");
            return result;
        }

        private static TextNoteType ResolveType(Document document, string? name)
        {
            var types = new FilteredElementCollector(document).OfClass(typeof(TextNoteType)).Cast<TextNoteType>().ToArray();
            if (!string.IsNullOrWhiteSpace(name)) return types.SingleOrDefault(t => string.Equals(t.Name, name.Trim(), StringComparison.OrdinalIgnoreCase))
                ?? throw new InvalidOperationException("Requested base text type was not found.");
            return document.GetElement(document.GetDefaultElementTypeId(ElementTypeGroup.TextNoteType)) as TextNoteType ?? types.FirstOrDefault()
                ?? throw new InvalidOperationException("No base text type.");
        }
        private static bool ViewNameExists(Document document, string name) => new FilteredElementCollector(document).OfClass(typeof(View)).Cast<View>().Any(v => string.Equals(v.Name, name, StringComparison.OrdinalIgnoreCase));
        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        internal static DrawingSpecSourceManifest ReadSource(string path)
        {
            var extension = Path.GetExtension(path);
            if (!string.Equals(extension, ".docx", StringComparison.OrdinalIgnoreCase) && !string.Equals(extension, ".txt", StringComparison.OrdinalIgnoreCase))
                throw new ArgumentException("Supported specification sources are .docx and .txt; legacy .doc must be converted explicitly.");
            var bytes = File.ReadAllBytes(path);
            if (string.Equals(extension, ".docx", StringComparison.OrdinalIgnoreCase)) return DocxDrawingSpecSourceReader.Read(bytes);
            string digest;
            using (var hash = SHA256.Create()) digest = BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            var manifest = new DrawingSpecSourceManifest { SourceSha256 = digest };
            var text = new UTF8Encoding(false, true).GetString(bytes).Replace("\r\n", "\n").Replace('\r', '\n');
            XNamespace w = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
            var block = new DrawingSpecBlock { SourcePath = "text/0", Kind = "paragraph", Text = text,
                PropertiesXml = new XElement(w + "pPr").ToString(), ContentSha256 = digest };
            block.Runs.Add(new DrawingSpecRun { Text = text, PropertiesXml = new XElement(w + "rPr").ToString() });
            manifest.Blocks.Add(block); return manifest;
        }
    }
}
