using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Text.Json;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic
{
    /// <summary>Readonly observations, not verification or an exemption from the
    /// native change inventory. Unsupported/large/unreadable state is explicit.</summary>
    public static class AnnotationSchedulePreservation
    {
        public const int MaximumSchedules = 32;
        private const int MaximumSnapshotBytes = 700000;

        public static Dictionary<long, object> CaptureBefore(Document doc)
        {
            var result = new Dictionary<long, object>();
            try
            {
                var schedules = new FilteredElementCollector(doc).OfClass(typeof(ViewSchedule))
                    .Cast<ViewSchedule>().Where(v => !v.IsTemplate && !v.IsTitleblockRevisionSchedule).ToArray();
                if (schedules.Length > MaximumSchedules) return result;
                var bytes = 0;
                foreach (var schedule in schedules.OrderBy(v => ElementIdCompat.GetValue(v.Id)))
                {
                    var id = ElementIdCompat.GetValue(schedule.Id);
                    var snapshot = CaptureOne(doc, id);
                    bytes += Encoding.UTF8.GetByteCount(JsonSerializer.Serialize(snapshot));
                    if (bytes > MaximumSnapshotBytes) return new Dictionary<long, object>();
                    result.Add(id, snapshot);
                }
            }
            catch { return new Dictionary<long, object>(); }
            return result;
        }

        public static void Attach(Document doc, Dictionary<string, object?> result,
            Dictionary<long, object> before, long viewId, long noteId)
            => AttachCore(doc, result, before, new HashSet<long> { viewId, noteId });

        // The legacy schema names the flat schedule observation, not mutation
        // authority. Parameter writes reuse exactly that bounded collector.
        public static object AttachParameterResult(Document doc, object payload,
            Dictionary<long, object> before, IEnumerable<long> requestedTargets)
            => AttachResult(doc, payload, before, requestedTargets);

        public static object AttachResult(Document doc, object payload,
            Dictionary<long, object> before, IEnumerable<long> requestedTargets)
        {
            var result = CopyPayload(payload);
            try { AttachCore(doc, result, before, new HashSet<long>(requestedTargets)); }
            catch (Exception error)
            {
                // A failed observation must not turn a committed write into an
                // unknown execution outcome or invite a repeat mutation.
                result["schedulePreservation"] = new { schema = "operator.annotation_schedule_preservation.v1",
                    complete = false, reason = "observation_unavailable", error = error.GetType().Name };
            }
            return result;
        }

        public static object AttachRead(Document doc, object payload, IEnumerable<long>? requested)
        {
            if (requested == null) return payload; // Preserve the legacy wire shape.
            var result = CopyPayload(payload);
            result["schedulePreservation"] = Read(doc, requested);
            return result;
        }

        private static Dictionary<string, object?> CopyPayload(object payload)
        {
            using var json = JsonDocument.Parse(JsonSerializer.Serialize(payload));
            return json.RootElement.EnumerateObject().ToDictionary(p => p.Name, p => (object?)p.Value.Clone());
        }

        private static void AttachCore(Document doc, Dictionary<string, object?> result,
            Dictionary<long, object> before, HashSet<long> requestedTargets)
        {
            using (var json = JsonDocument.Parse(JsonSerializer.Serialize(result)))
            {
                if (!json.RootElement.TryGetProperty("transaction", out var tx)
                    || !tx.TryGetProperty("committed", out var committed) || committed.ValueKind != JsonValueKind.True
                    || !tx.TryGetProperty("modified_element_ids", out var modified)) return;
                var ids = modified.EnumerateArray().Select(v => v.GetInt64())
                    .Where(id => !requestedTargets.Contains(id)).Distinct().OrderBy(id => id).ToArray();
                if (ids.Length == 0) return;
                if (ids.Length > MaximumSchedules)
                {
                    result["schedulePreservation"] = new { schema = "operator.annotation_schedule_preservation.v1",
                        complete = false, reason = "modified_scope_exceeds_bound" };
                    return;
                }
                var prior = ids.Select(id => before.TryGetValue(id, out var value) ? value : Missing(id, "baseline_unavailable")).ToArray();
                var current = ids.Select(id => CaptureOne(doc, id)).ToArray();
                result["schedulePreservation"] = new
                {
                    schema = "operator.annotation_schedule_preservation.v1",
                    complete = Complete(prior) && Complete(current),
                    scheduleIds = ids, before = prior, after = current
                };
            }
        }

        public static object Read(Document doc, IEnumerable<long> requested)
        {
            var ids = requested.ToArray();
            if (doc.IsFamilyDocument || ids.Length > MaximumSchedules || ids.Any(id => id <= 0)
                || ids.Distinct().Count() != ids.Length)
                throw new ArgumentException("Schedule preservation read requires at most32unique active-project IDs.");
            var items = ids.OrderBy(id => id).Select(id => CaptureOne(doc, id)).ToArray();
            return new { schema = "operator.annotation_schedule_read.v1", complete = Complete(items),
                requestedElementIds = ids.OrderBy(id => id).ToArray(), items };
        }

        private static bool Complete(object[] items)
        {
            var bytes = 0;
            foreach (var item in items)
            {
                var text = JsonSerializer.Serialize(item);
                bytes += Encoding.UTF8.GetByteCount(text);
                using (var parsed = JsonDocument.Parse(text))
                    if (!parsed.RootElement.TryGetProperty("complete", out var c) || c.ValueKind != JsonValueKind.True) return false;
            }
            return bytes <= MaximumSnapshotBytes;
        }

        private static object Missing(long id, string reason) => new { elementId = id, complete = false, reason };

        private static object CaptureOne(Document doc, long id)
        {
            try
            {
                var schedule = doc.GetElement(ElementIdCompat.Create(id)) as ViewSchedule;
                if (schedule == null || schedule.IsTemplate || schedule.IsTitleblockRevisionSchedule)
                    return Missing(id, "not_supported_regular_schedule");
                var definition = ScheduleDefinitionIdentitySnapshot.CaptureDefinition(schedule);
                using (var parsed = JsonDocument.Parse(JsonSerializer.Serialize(definition)))
                    if (!parsed.RootElement.TryGetProperty("complete", out var c) || c.ValueKind != JsonValueKind.True)
                        return Missing(id, "definition_incomplete");
                var parameters = new List<object>();
                foreach (Parameter p in schedule.Parameters)
                {
                    if (parameters.Count >= 2048) return Missing(id, "parameter_scope_exceeded");
                    object? value;
                    switch (p.StorageType)
                    {
                        case StorageType.None: value = null; break;
                        case StorageType.String: value = p.AsString(); break;
                        case StorageType.Integer: value = p.AsInteger(); break;
                        case StorageType.ElementId: value = ElementIdCompat.GetValue(p.AsElementId()); break;
                        case StorageType.Double:
                            var number = p.AsDouble();
                            if (double.IsNaN(number) || double.IsInfinity(number)) return Missing(id, "nonfinite_parameter");
                            value = number; break;
                        default: return Missing(id, "unsupported_parameter_storage");
                    }
                    parameters.Add(new { id = ElementIdCompat.GetValue(p.Id), name = p.Definition.Name,
                        storageType = p.StorageType.ToString(), p.HasValue, p.IsReadOnly, value });
                }
                var ordered = parameters.OrderBy(p => JsonSerializer.Serialize(p), StringComparer.Ordinal).ToArray();
                return new { elementId = id, uniqueId = schedule.UniqueId, complete = true,
                    scope = "flat_definition_table_parameters", definition, parameters = ordered };
            }
            catch (Exception error) { return Missing(id, error.GetType().Name); }
        }
    }
}
