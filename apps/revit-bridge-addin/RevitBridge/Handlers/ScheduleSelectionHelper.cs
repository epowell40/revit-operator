using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using Autodesk.Revit.DB;

namespace RevitBridge.Handlers
{
    internal static class ScheduleSelectionHelper
    {
        public static List<ViewSchedule> CollectSchedules(Document doc)
        {
            return new FilteredElementCollector(doc)
                .OfClass(typeof(ViewSchedule))
                .Cast<ViewSchedule>()
                .Where(s => s != null)
                .Where(s => !IsTitleblockRevisionSchedule(s))
                .ToList();
        }

        public static ViewSchedule? ResolveSchedule(Document doc, long? scheduleId, string? query, bool exact)
        {
            if (scheduleId.HasValue && scheduleId.Value > 0)
            {
                return doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(scheduleId.Value)) as ViewSchedule;
            }

            var q = (query ?? "").Trim();
            if (string.IsNullOrWhiteSpace(q)) return null;

            return CollectSchedules(doc)
                .Where(s =>
                {
                    var n = (s.Name ?? "").Trim();
                    if (exact) return n.Equals(q, StringComparison.OrdinalIgnoreCase);
                    return n.IndexOf(q, StringComparison.OrdinalIgnoreCase) >= 0;
                })
                .OrderBy(s => s.Name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        public static List<ScheduleField> GetFields(ViewSchedule schedule)
        {
            var fields = new List<ScheduleField>();
            var definition = schedule.Definition;
            var count = SafeGetFieldCount(definition);
            for (var i = 0; i < count; i++)
            {
                try
                {
                    fields.Add(definition.GetField(i));
                }
                catch
                {
                    // ignore
                }
            }

            return fields;
        }

        public static ScheduleField? FindFieldByName(ViewSchedule schedule, Document doc, string fieldName)
        {
            var target = (fieldName ?? "").Trim();
            if (target.Length == 0) return null;

            return GetFields(schedule)
                .FirstOrDefault(f =>
                {
                    var n = (ReadFieldName(f, doc) ?? "").Trim();
                    return n.Equals(target, StringComparison.OrdinalIgnoreCase);
                });
        }

        public static int SafeGetFieldCount(ScheduleDefinition definition)
        {
            try { return definition.GetFieldCount(); }
            catch { return 0; }
        }

        public static bool IsTitleblockRevisionSchedule(ViewSchedule schedule)
        {
            var value = TryGetBoolProperty(schedule, "IsTitleblockRevisionSchedule");
            return value ?? false;
        }

        public static string? ReadFieldName(ScheduleField field, Document doc)
        {
            if (field == null) return null;
            try
            {
                var noArg = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
                if (noArg != null)
                {
                    var raw = noArg.Invoke(field, null);
                    var text = raw?.ToString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }

                var docArg = field.GetType().GetMethod("GetName", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(Document) }, null);
                if (docArg != null)
                {
                    var raw = docArg.Invoke(field, new object[] { doc });
                    var text = raw?.ToString();
                    if (!string.IsNullOrWhiteSpace(text)) return text;
                }
            }
            catch
            {
                // ignore
            }

            return null;
        }

        public static bool? TryGetBoolProperty(object obj, string propName)
        {
            try
            {
                var p = obj.GetType().GetProperty(propName, BindingFlags.Instance | BindingFlags.Public);
                var raw = p?.GetValue(obj, null);
                if (raw is bool b) return b;
            }
            catch
            {
                // ignore
            }

            return null;
        }
    }
}
