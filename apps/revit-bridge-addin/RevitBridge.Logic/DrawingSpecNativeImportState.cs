using System;
using System.Collections.Generic;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class DrawingSpecStoredImport
    {
        public string ImportKey { get; set; } = "";
        public string SourceSha256 { get; set; } = "";
        public string InputSha256 { get; set; } = "";
        public string NativeStateSha256 { get; set; } = "";
        public List<long> ViewIds { get; set; } = new List<long>();
        public List<DrawingSpecNativeNoteRecord> Notes { get; set; } = new List<DrawingSpecNativeNoteRecord>();
        public List<string> SourceWarnings { get; set; } = new List<string>();
        public string LayoutSpansJson { get; set; } = "";
        public string SourceBlocksJson { get; set; } = "";
        public string? SourceFallbackFont { get; set; }
        public double? SourceFallbackPoints { get; set; }
        public DrawingSpecFlowGeometry? FlowGeometry { get; set; }
        public double StartXInches { get; set; }
        public double StartYInches { get; set; }
        public long StorageId { get; set; }
        public DrawingSpecUpdateRevision? LastUpdate { get; set; }
        public DrawingSpecNativeLayoutResult Layout()
        {
            var result = new DrawingSpecNativeLayoutResult(); result.ViewIds.AddRange(ViewIds); result.Notes.AddRange(Notes); return result;
        }
    }

    public static class DrawingSpecNativeImportState
    {
        private static readonly Guid SchemaId = new Guid("15153d5f-2f23-4f2e-9ba6-5cde8c857178");
        public static IReadOnlyList<DrawingSpecStoredImport> All(Document document)
        {
            var schema = Schema.Lookup(SchemaId);
            if (schema == null) return Array.Empty<DrawingSpecStoredImport>();
            if (schema.SchemaName != "OperatorDrawingSpecImportV1" || schema.GetField("StateJson")?.ValueType != typeof(string))
                throw new InvalidOperationException("Drawing-spec storage schema collision.");
            var matches = new List<DrawingSpecStoredImport>();
            long total = 0;
            foreach (var storage in new FilteredElementCollector(document).OfClass(typeof(DataStorage)).Cast<DataStorage>())
            {
                using var entity = storage.GetEntity(schema);
                if (!entity.IsValid()) continue;
                var value = entity.Get<string>(schema.GetField("StateJson"));
                total += value.Length;
                if (value.Length > 8 * 1024 * 1024 || total > 16 * 1024 * 1024 || matches.Count >= 1000)
                    throw new InvalidOperationException("Drawing-spec ownership index exceeds its complete-read bound.");
                var state = JsonSerializer.Deserialize<DrawingSpecStoredImport>(value)
                    ?? throw new InvalidOperationException("Invalid stored drawing-spec manifest.");
                state.StorageId = ElementIdCompat.GetValue(storage.Id); matches.Add(state);
            }
            return matches;
        }

        public static DrawingSpecStoredImport? Find(Document document, string importKey) =>
            All(document).Where(state => state.ImportKey == importKey).SingleOrDefault(); // Never select duplicate ownership silently.

        public static DrawingSpecStoredImport ReadById(Document document, long storageId)
        {
            var schema = Schema.Lookup(SchemaId) ?? throw new InvalidOperationException("No drawing-spec import schema in this model.");
            if (schema.SchemaName != "OperatorDrawingSpecImportV1" || schema.GetField("StateJson")?.ValueType != typeof(string))
                throw new InvalidOperationException("Drawing-spec storage schema collision.");
            var storage = document.GetElement(ElementIdCompat.Create(storageId)) as DataStorage
                ?? throw new InvalidOperationException("Manifest ID is not a current native DataStorage.");
            using (var entity = storage.GetEntity(schema))
            {
                if (!entity.IsValid()) throw new InvalidOperationException("This storage does not own a drawing-spec import.");
                var value = entity.Get<string>(schema.GetField("StateJson"));
                if (value.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Drawing-spec manifest exceeds inspection bound.");
                var state = JsonSerializer.Deserialize<DrawingSpecStoredImport>(value) ?? throw new InvalidOperationException("Invalid import manifest.");
                state.StorageId = storageId;
                return state;
            }
        }

        public static void Store(Document document, DrawingSpecStoredImport state, ISet<long> created)
        {
            if (!document.IsModifiable) throw new InvalidOperationException("Missing owned native transaction.");
            if (state.StorageId != 0 || Find(document, state.ImportKey) != null) throw new InvalidOperationException("Existing source import must be reconciled, not overwritten or duplicated.");
            var json = JsonSerializer.Serialize(state);
            if (json.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Drawing-spec manifest limit exceeded; no partial import should commit.");
            var schema = Schema.Lookup(SchemaId);
            if (schema == null)
            {
                var builder = new SchemaBuilder(SchemaId);
                builder.SetSchemaName("OperatorDrawingSpecImportV1");
                builder.SetReadAccessLevel(AccessLevel.Public); builder.SetWriteAccessLevel(AccessLevel.Public);
                builder.AddSimpleField("StateJson", typeof(string)); schema = builder.Finish();
            }
            var storage = DataStorage.Create(document);
            storage.Name = "Operator Drawing Specifications " + Hash(state.ImportKey).Substring(0, 16);
            var entity = new Entity(schema); entity.Set(schema.GetField("StateJson"), json); storage.SetEntity(entity);
            state.StorageId = ElementIdCompat.GetValue(storage.Id); created.Add(state.StorageId);
        }

        public static string CurrentSnapshotHash(Document document, DrawingSpecStoredImport state) =>
            Hash(JsonSerializer.Serialize(DrawingSpecNativeLayout.ReadSnapshot(document, state.Layout())));

        public static void Replace(Document document, DrawingSpecStoredImport expected, DrawingSpecStoredImport next)
        {
            if (!document.IsModifiable || expected.StorageId <= 0 || next.StorageId != expected.StorageId || next.ImportKey != expected.ImportKey)
                throw new InvalidOperationException("Managed update requires the existing exact owned manifest and transaction.");
            var current = ReadById(document, expected.StorageId);
            if (JsonSerializer.Serialize(current) != JsonSerializer.Serialize(expected))
                throw new InvalidOperationException("Stored drawing-spec revision changed before replacement.");
            var json = JsonSerializer.Serialize(next);
            if (json.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Updated drawing-spec manifest exceeds its complete-storage bound.");
            var schema = Schema.Lookup(SchemaId) ?? throw new InvalidOperationException("Missing owned import schema.");
            var storage = (DataStorage)document.GetElement(ElementIdCompat.Create(expected.StorageId));
            using (var entity = new Entity(schema)) { entity.Set(schema.GetField("StateJson"), json); storage.SetEntity(entity); }
        }
        public static string Hash(string value)
        {
            using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant();
        }
    }
}
