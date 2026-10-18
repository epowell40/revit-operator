using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.ExtensibleStorage;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    public sealed class VectorDraftingOwnedEntity
    {
        public string SourceId { get; set; } = "";
        public string PlanEntityId { get; set; } = "";
        public string Kind { get; set; } = "";
        public long Id { get; set; }
        public string UniqueId { get; set; } = "";
    }
    public sealed class VectorDraftingOwnedPart
    {
        public int Index { get; set; }
        public List<VectorDraftingOwnedEntity> Entities { get; set; } = new List<VectorDraftingOwnedEntity>();
        public string NativeSnapshotSha256 { get; set; } = "";
    }
    public sealed class VectorDraftingStoredImport
    {
        public long StorageId { get; set; }
        public string ImportKey { get; set; } = "";
        public string SourcePath { get; set; } = "";
        public string SourceSha256 { get; set; } = "";
        public string NativePlanPath { get; set; } = "";
        public string NativePlanFileSha256 { get; set; } = "";
        public string NativePlanSha256 { get; set; } = "";
        public string PlanPackedBase64 { get; set; } = "";
        public long ViewId { get; set; }
        public string ViewUniqueId { get; set; } = "";
        public string ViewName { get; set; } = "";
        public int ViewScale { get; set; }
        public string Renderer { get; set; } = "operator.vector-drafting-native.v1";
        public Dictionary<string, long> TextTypes { get; set; } = new Dictionary<string, long>();
        public Dictionary<string, long> FillTypes { get; set; } = new Dictionary<string, long>();
        public Dictionary<string, long> LinePatterns { get; set; } = new Dictionary<string, long>();
        public List<VectorDraftingOwnedPart> Parts { get; set; } = new List<VectorDraftingOwnedPart>();
    }
    public static class VectorDraftingImportState
    {
        private static readonly Guid SchemaId = new Guid("17e80114-c670-41d1-9ab2-c52177b23a41");
        private static Schema? StorageSchema(bool create)
        {
            var schema = Schema.Lookup(SchemaId);
            if (schema == null && create)
            {
                var b = new SchemaBuilder(SchemaId); b.SetSchemaName("OperatorVectorDraftingV1");
                b.SetReadAccessLevel(AccessLevel.Public); b.SetWriteAccessLevel(AccessLevel.Public); b.AddSimpleField("StateJson", typeof(string)); schema = b.Finish();
            }
            if (schema != null && (schema.SchemaName != "OperatorVectorDraftingV1" || schema.GetField("StateJson")?.ValueType != typeof(string)))
                throw new InvalidOperationException("Vector drafting ownership schema collision.");
            return schema;
        }
        public static List<VectorDraftingStoredImport> All(Document doc)
        {
            var schema = StorageSchema(false); var results = new List<VectorDraftingStoredImport>(); if (schema == null) return results;
            long bytes = 0;
            foreach (var storage in new FilteredElementCollector(doc).OfClass(typeof(DataStorage)).Cast<DataStorage>())
            {
                using var entity = storage.GetEntity(schema); if (!entity.IsValid()) continue;
                var json = entity.Get<string>(schema.GetField("StateJson")); bytes += json.Length;
                if (json.Length > 8 * 1024 * 1024 || bytes > 32 * 1024 * 1024 || results.Count >= 1000) throw new InvalidOperationException("Complete vector ownership index exceeded bounds.");
                var state = JsonSerializer.Deserialize<VectorDraftingStoredImport>(json) ?? throw new InvalidOperationException("Vector ownership record is invalid.");
                state.StorageId = ElementIdCompat.GetValue(storage.Id); results.Add(state);
            }
            if (results.Select(s => s.ImportKey).Distinct().Count() != results.Count) throw new InvalidOperationException("Duplicate managed vector ownership requires reconciliation.");
            return results;
        }
        public static VectorDraftingStoredImport Read(Document doc, long id) => All(doc).SingleOrDefault(s => s.StorageId == id)
            ?? throw new InvalidOperationException("Exact vector import manifest is missing.");
        public static void Store(Document doc, VectorDraftingStoredImport state, ISet<long> created)
        {
            if (!doc.IsModifiable) throw new InvalidOperationException("Vector state requires the owned native transaction.");
            var schema = StorageSchema(true)!; DataStorage storage;
            if (state.StorageId == 0)
            { storage = DataStorage.Create(doc); state.StorageId = ElementIdCompat.GetValue(storage.Id); created.Add(state.StorageId); storage.Name = "Operator Vector " + VectorDraftingPlanCodec.Hash(state.ImportKey).Substring(0, 16); }
            else storage = doc.GetElement(ElementIdCompat.Create(state.StorageId)) as DataStorage ?? throw new InvalidOperationException("Managed vector manifest disappeared.");
            var json = JsonSerializer.Serialize(state); if (json.Length > 8 * 1024 * 1024) throw new InvalidOperationException("Complete vector ownership record exceeded8MiB; no partial state committed.");
            using var entity = new Entity(schema); entity.Set(schema.GetField("StateJson"), json); storage.SetEntity(entity);
        }
        public static VectorDraftingNativePlan Plan(VectorDraftingStoredImport state) => VectorDraftingPlanCodec.Decode(Convert.FromBase64String(state.PlanPackedBase64),
            state.NativePlanFileSha256, state.NativePlanSha256, state.SourceSha256);
        public static ViewDrafting View(Document doc, VectorDraftingStoredImport state)
        {
            var view = doc.GetElement(ElementIdCompat.Create(state.ViewId)) as ViewDrafting;
            if (view == null || view.UniqueId != state.ViewUniqueId || view.Name != state.ViewName || view.Scale != state.ViewScale || view.IsTemplate)
                throw new InvalidOperationException("Owned vector drafting view identity/name/scale changed; reconcile before continuation.");
            return view;
        }
        public static string PartSnapshot(Document doc, VectorDraftingStoredImport state, VectorDraftingOwnedPart part)
            => CanonicalHash(new { view = ViewIdentity(View(doc, state)), items = part.Entities.Select(e => ReadEntity(doc, state, e)).ToArray() });
        public static string CurrentSnapshot(Document doc, VectorDraftingStoredImport state)
        {
            var plan = Plan(state); View(doc, state);
            if (!state.Parts.Select(p => p.Index).SequenceEqual(Enumerable.Range(0, state.Parts.Count)) || state.Parts.Count > plan.partCount
                || state.Parts.SelectMany(p => p.Entities).Select(e => e.Id).Distinct().Count() != state.Parts.Sum(p => p.Entities.Count))
                throw new InvalidOperationException("Vector part ownership/order changed.");
            foreach (var part in state.Parts)
            {
                var expected = plan.entities.Skip(part.Index * plan.layout.partSize).Take(plan.layout.partSize).ToArray();
                if (!expected.Select(e => e.id).SequenceEqual(part.Entities.Select(e => e.PlanEntityId))
                    || expected.Where((e, i) => e.sourceId != part.Entities[i].SourceId || e.kind != part.Entities[i].Kind).Any())
                    throw new InvalidOperationException("Vector source/part entity membership changed.");
                if (PartSnapshot(doc, state, part) != part.NativeSnapshotSha256) throw new InvalidOperationException("An owned vector part changed. Inspect/reconcile that result, do not duplicate it.");
            }
            return CanonicalHash(state);
        }
        public static object ReadEntity(Document doc, VectorDraftingStoredImport state, VectorDraftingOwnedEntity owned)
        {
            var e = doc.GetElement(ElementIdCompat.Create(owned.Id)) ?? throw new InvalidOperationException("Owned vector entity is missing.");
            if (e.UniqueId != owned.UniqueId || ElementIdCompat.GetValue(e.OwnerViewId) != state.ViewId) throw new InvalidOperationException("Owned vector entity identity/view changed.");
            if (e is DetailCurve curve)
            {
                using var graphics = View(doc, state).GetElementOverrides(e.Id); var color = graphics.ProjectionLineColor;
                var pattern = doc.GetElement(graphics.ProjectionLinePatternId) as LinePatternElement;
                return new { owned.Id, owned.UniqueId, owned.SourceId, owned.PlanEntityId, owned.Kind, geometry = NativeDraftingCurveGeometry.Read(curve.GeometryCurve),
                    lineStyleId = ElementIdCompat.GetValue(curve.LineStyle.Id), weight = graphics.ProjectionLineWeight,
                    color = color.IsValid ? new[] { (int)color.Red, color.Green, color.Blue } : null,
                    patternId = ElementIdCompat.GetValue(graphics.ProjectionLinePatternId), pattern = pattern?.GetLinePattern().GetSegments().Select(s => new { type = s.Type.ToString(), s.Length }).ToArray() };
            }
            if (e is TextNote note)
            {
                var type = note.TextNoteType;
                using var formatted = note.GetFormattedText();
                return new { owned.Id, owned.UniqueId, owned.SourceId, owned.PlanEntityId, owned.Kind, text = note.Text,
                    anchor = Point(note.Coord), baseline = Point(note.BaseDirection), up = Point(note.UpDirection), note.Width, note.Height,
                    typeId = ElementIdCompat.GetValue(type.Id), typeUniqueId = type.UniqueId, font = type.get_Parameter(BuiltInParameter.TEXT_FONT).AsString(),
                    sizeFeet = type.get_Parameter(BuiltInParameter.TEXT_SIZE).AsDouble(), widthScale = type.get_Parameter(BuiltInParameter.TEXT_WIDTH_SCALE).AsDouble(),
                    bold = type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD).AsInteger(), italic = type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC).AsInteger(),
                    background = type.get_Parameter(BuiltInParameter.TEXT_BACKGROUND).AsInteger(),
                    underline = type.get_Parameter(BuiltInParameter.TEXT_STYLE_UNDERLINE).AsInteger(), color = type.get_Parameter(BuiltInParameter.LINE_COLOR).AsInteger(),
                    characterFormatting = new { bold = formatted.GetBoldStatus().ToString(), italic = formatted.GetItalicStatus().ToString(),
                        underline = formatted.GetUnderlineStatus().ToString(), allCaps = formatted.GetAllCapsStatus().ToString(),
                        superscript = formatted.GetSuperscriptStatus().ToString(), subscript = formatted.GetSubscriptStatus().ToString() } };
            }
            if (e is FilledRegion region)
            {
                var type = doc.GetElement(region.GetTypeId()) as FilledRegionType ?? throw new InvalidOperationException("Owned vector fill type missing.");
                var color = type.ForegroundPatternColor;
                return new { owned.Id, owned.UniqueId, owned.SourceId, owned.PlanEntityId, owned.Kind,
                    loops = region.GetBoundaries().Select(loop => loop.Select(NativeDraftingCurveGeometry.Read).ToArray()).ToArray(),
                    typeId = ElementIdCompat.GetValue(type.Id), typeUniqueId = type.UniqueId, type.IsMasking, foregroundPatternId = ElementIdCompat.GetValue(type.ForegroundPatternId),
                    color = new[] { (int)color.Red, color.Green, color.Blue } };
            }
            throw new InvalidOperationException("Unsupported owned vector entity kind; no incomplete snapshot was accepted.");
        }
        private static object ViewIdentity(View view) => new { id = ElementIdCompat.GetValue(view.Id), view.UniqueId, view.Name, view.Scale, origin = Point(view.Origin), right = Point(view.RightDirection), up = Point(view.UpDirection) };
        private static object Point(XYZ p) => new { x = p.X, y = p.Y, z = p.Z };
        internal static string CanonicalHash(object value)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(value)); using var stream = new System.IO.MemoryStream();
            using (var writer = new Utf8JsonWriter(stream)) Write(json.RootElement, writer);
            return VectorDraftingPlanCodec.Hash(stream.ToArray());
        }
        private static void Write(JsonElement e, Utf8JsonWriter writer)
        {
            if (e.ValueKind == JsonValueKind.Number) { if (e.TryGetInt64(out long integer)) { writer.WriteNumberValue(integer); return; } var n = e.GetDouble(); if (double.IsNaN(n) || double.IsInfinity(n)) throw new InvalidOperationException("Nonfinite native snapshot."); writer.WriteNumberValue(Math.Round(n, 9)); }
            else if (e.ValueKind == JsonValueKind.Object) { writer.WriteStartObject(); foreach (var p in e.EnumerateObject().OrderBy(p => p.Name, StringComparer.Ordinal)) { writer.WritePropertyName(p.Name); Write(p.Value, writer); } writer.WriteEndObject(); }
            else if (e.ValueKind == JsonValueKind.Array) { writer.WriteStartArray(); foreach (var v in e.EnumerateArray()) Write(v, writer); writer.WriteEndArray(); }
            else e.WriteTo(writer);
        }
    }
}
