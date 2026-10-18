using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class XlsxStoredImport
    {
        public long StorageId { get; set; }
        public string ImportKey { get; set; } = "";
        public string SourcePath { get; set; } = "";
        public string SourceSha256 { get; set; } = "";
        public string Worksheet { get; set; } = "";
        public string InputSha256 { get; set; } = "";
        public string PlanSha256 { get; set; } = "";
        public string PlanPacked { get; set; } = "";
        public string ViewName { get; set; } = "";
        public string Renderer { get; set; } = XlsxNativeTableLayout.RendererVersion;
        public long BaseTextTypeId { get; set; }
        public string BaseTextTypeUniqueId { get; set; } = "";
        public Dictionary<string, int> BorderWeights { get; set; } = new Dictionary<string, int>();
        public List<XlsxStoredPartReference> Parts { get; set; } = new List<XlsxStoredPartReference>();
    }
    public sealed class XlsxStoredPartReference
    {
        public int Index { get; set; }
        public long StorageId { get; set; }
        public string StorageUniqueId { get; set; } = "";
        public string NativeSnapshotSha256 { get; set; } = "";
    }
    public sealed class XlsxStoredPart
    {
        public long StorageId { get; set; }
        public string ImportKey { get; set; } = "";
        public string SourceSha256 { get; set; } = "";
        public string PlanSha256 { get; set; } = "";
        public XlsxNativeTablePart Layout { get; set; } = new XlsxNativeTablePart();
    }
    public static class XlsxNativeImportState
    {
        private static readonly Guid RootSchema = new Guid("b9d477b3-d56f-40a6-97ef-655e2d83be50");
        private static readonly Guid PartSchema = new Guid("561e9040-756e-445e-8467-6dbbeb859807");
        private static readonly JsonSerializerOptions Json = new JsonSerializerOptions { PreferredObjectCreationHandling = JsonObjectCreationHandling.Populate };
        private static Schema? SchemaFor(Guid id, string name, bool create)
        {
            var schema = Schema.Lookup(id);
            if (schema == null && create)
            {
                var builder = new SchemaBuilder(id);builder.SetSchemaName(name);builder.SetReadAccessLevel(AccessLevel.Public);builder.SetWriteAccessLevel(AccessLevel.Public);
                builder.AddSimpleField("StateJson", typeof(string));schema = builder.Finish();
            }
            if (schema != null && (schema.SchemaName != name || schema.GetField("StateJson")?.ValueType != typeof(string))) throw new InvalidOperationException("Excel import ownership schema collision.");
            return schema;
        }
        public static IReadOnlyList<XlsxStoredImport> All(Document document)
        {
            var schema = SchemaFor(RootSchema, "OperatorXlsxImportV1", false);
            var imports = new List<XlsxStoredImport>();if (schema == null) return imports;
            long bytes = 0;
            foreach (var storage in new FilteredElementCollector(document).OfClass(typeof(DataStorage)).Cast<DataStorage>())
            {
                using var entity = storage.GetEntity(schema);if (!entity.IsValid()) continue;
                var json = entity.Get<string>(schema.GetField("StateJson"));bytes += json.Length;
                if (json.Length > 8 * 1024 * 1024 || bytes > 16 * 1024 * 1024 || imports.Count >= 1000) throw new InvalidOperationException("Excel ownership index exceeds complete-read bounds.");
                var state = JsonSerializer.Deserialize<XlsxStoredImport>(json, Json) ?? throw new InvalidOperationException("Invalid Excel ownership state.");
                state.StorageId = ElementIdCompat.GetValue(storage.Id);imports.Add(state);
            }
            if (imports.Select(i => i.ImportKey).Distinct().Count() != imports.Count) throw new InvalidOperationException("Duplicate Excel import ownership keys require reconciliation.");
            return imports;
        }
        public static XlsxStoredImport Read(Document document, long id) => All(document).SingleOrDefault(s => s.StorageId == id)
            ?? throw new InvalidOperationException("Exact Excel import manifest is missing.");
        public static XlsxStoredPart ReadPart(Document document, XlsxStoredImport root, XlsxStoredPartReference reference)
        {
            var schema = SchemaFor(PartSchema, "OperatorXlsxImportPartV1", false) ?? throw new InvalidOperationException("Excel part schema is missing.");
            var storage = document.GetElement(ElementIdCompat.Create(reference.StorageId)) as DataStorage ?? throw new InvalidOperationException("Excel part manifest is missing.");
            if (storage.UniqueId != reference.StorageUniqueId) throw new InvalidOperationException("Excel part manifest identity changed.");
            using var entity = storage.GetEntity(schema);if (!entity.IsValid()) throw new InvalidOperationException("Exact Excel part ownership is missing.");
            var json = entity.Get<string>(schema.GetField("StateJson"));if (json.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Excel part exceeds complete-read bound.");
            var state = JsonSerializer.Deserialize<XlsxStoredPart>(json, Json) ?? throw new InvalidOperationException("Invalid Excel part manifest.");
            state.StorageId = reference.StorageId;
            if (state.ImportKey != root.ImportKey || state.SourceSha256 != root.SourceSha256 || state.PlanSha256 != root.PlanSha256 || state.Layout.PageIndex != reference.Index)
                throw new InvalidOperationException("Excel part is not owned by the exact source/plan/import.");
            return state;
        }
        public static void StoreRoot(Document document, XlsxStoredImport state, ISet<long> created, bool replace = false)
        {
            if (!document.IsModifiable) throw new InvalidOperationException("Missing owned native transaction.");
            var schema = SchemaFor(RootSchema, "OperatorXlsxImportV1", true)!;
            var storage = replace ? document.GetElement(ElementIdCompat.Create(state.StorageId)) as DataStorage : DataStorage.Create(document);
            if (storage == null || !replace && state.StorageId != 0) throw new InvalidOperationException("Invalid Excel root write identity.");
            if (!replace) { state.StorageId = ElementIdCompat.GetValue(storage.Id);storage.Name = "Operator Excel " + XlsxTablePlanCodec.Hash(state.ImportKey).Substring(0, 16);created.Add(state.StorageId); }
            Set(storage, schema, state);
        }
        public static XlsxStoredPartReference StorePart(Document document, XlsxStoredPart state, ISet<long> created)
        {
            if (!document.IsModifiable || state.StorageId != 0) throw new InvalidOperationException("New Excel part requires the owned transaction.");
            var schema = SchemaFor(PartSchema, "OperatorXlsxImportPartV1", true)!;var storage = DataStorage.Create(document);
            state.StorageId = ElementIdCompat.GetValue(storage.Id);storage.Name = "Operator Excel Part " + state.Layout.PageIndex;
            Set(storage, schema, state);created.Add(state.StorageId);
            return new XlsxStoredPartReference { Index = state.Layout.PageIndex, StorageId = state.StorageId, StorageUniqueId = storage.UniqueId,
                NativeSnapshotSha256 = XlsxNativeTableSnapshot.Hash(document, state.Layout) };
        }
        private static void Set<T>(DataStorage storage, Schema schema, T state)
        {
            var json = JsonSerializer.Serialize(state);if (json.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Complete Excel ownership record exceeds8MiB; no partial import should commit.");
            using var entity = new Entity(schema);entity.Set(schema.GetField("StateJson"), json);storage.SetEntity(entity);
        }
        public static string CurrentSnapshot(Document document, XlsxStoredImport state)
        {
            var plan = XlsxTablePlanCodec.Decode(state.PlanPacked, state.PlanSha256);var timer = Stopwatch.StartNew();
            if (plan.SourceSha256 != state.SourceSha256 || plan.Worksheet != state.Worksheet || state.Renderer != XlsxNativeTableLayout.RendererVersion
                || state.Parts.Count > plan.Pages.Count || !state.Parts.OrderBy(p => p.Index).Select(p => p.Index).SequenceEqual(Enumerable.Range(0, state.Parts.Count))
                || state.Parts.Select(p => p.StorageId).Distinct().Count() != state.Parts.Count)
                throw new InvalidOperationException("Excel import source/plan or ordered part ownership changed.");
            var parts = state.Parts.OrderBy(p => p.Index).Select(reference =>
            {
                if (timer.Elapsed.TotalSeconds > 30) throw new InvalidOperationException("Complete Excel import snapshot exceeded30seconds; no partial current-state proof is available.");
                var part = ReadPart(document, state, reference);var current = XlsxNativeTableSnapshot.Hash(document, part.Layout);
                if (current != reference.NativeSnapshotSha256) throw new InvalidOperationException("An imported Excel part changed. Reconcile its known current state before continuation; do not duplicate it.");
                return new { reference.Index, reference.StorageId, reference.StorageUniqueId, current };
            }).ToArray();
            return XlsxTablePlanCodec.Hash(JsonSerializer.Serialize(new { state, parts }));
        }
    }
}
