using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    internal static class RegularSchedulePresentation
    {
        public static void Preflight(Document doc, ViewSchedule schedule, IList<int>? order, ScheduleTextStyles? styles)
        {
            if (order != null)
                SchedulePresentationContract.RequireCompleteOrder(schedule.Definition.GetFieldOrder().Select(id => id.IntegerValue).ToList(), order);
            foreach (var id in new[] { styles?.titleTextTypeId, styles?.headerTextTypeId, styles?.bodyTextTypeId })
                if (id.HasValue && (id.Value <= 0 || !(doc.GetElement(ElementIdCompat.Create(id.Value)) is TextNoteType)))
                    throw new ArgumentException("Schedule text styles must resolve to existing TextNoteType elements in the active document.");
        }

        public static void Apply(ViewSchedule schedule, IList<int>? order, ScheduleTextStyles? styles, List<object> results)
        {
            if (order != null)
            {
                // Preserve each field identity, filter, sort and value. Never ClearFields to reorder.
                schedule.Definition.SetFieldOrder(order.Select(id => new ScheduleFieldId(id)).ToList());
                results.Add(new { setting = "fieldOrder", status = "Applied", value = order });
            }
            if (styles?.titleTextTypeId is long title)
            {
                schedule.TitleTextTypeId = ElementIdCompat.Create(title);
                results.Add(new { setting = "titleTextTypeId", status = "Applied", value = title });
            }
            if (styles?.headerTextTypeId is long header)
            {
                schedule.HeaderTextTypeId = ElementIdCompat.Create(header);
                results.Add(new { setting = "headerTextTypeId", status = "Applied", value = header });
            }
            if (styles?.bodyTextTypeId is long body)
            {
                schedule.BodyTextTypeId = ElementIdCompat.Create(body);
                results.Add(new { setting = "bodyTextTypeId", status = "Applied", value = body });
            }
        }

        public static object Read(Document doc, ViewSchedule schedule)
        {
            try
            {
                return new { schema = "operator.regular_schedule_presentation.v1", complete = true,
                    showTitle = schedule.Definition.ShowTitle, showHeaders = schedule.Definition.ShowHeaders,
                    fieldOrder = schedule.Definition.GetFieldOrder().Select(id => id.IntegerValue).ToArray(),
                    title = ReadTextType(doc, schedule.TitleTextTypeId), header = ReadTextType(doc, schedule.HeaderTextTypeId),
                    body = ReadTextType(doc, schedule.BodyTextTypeId),
                    note = "Native default text styles only. Field/cell overrides and rendered legibility require separate inspection." };
            }
            catch (Exception ex)
            {
                return new { schema = "operator.regular_schedule_presentation.v1", complete = false, error = ex.Message };
            }
        }

        private static object ReadTextType(Document doc, ElementId id)
        {
            var type = doc.GetElement(id) as TextNoteType;
            if (type == null) throw new InvalidOperationException("Native schedule text type could not be resolved: " + ElementIdCompat.GetValue(id));
            return new { id = ElementIdCompat.GetValue(id), uniqueId = type.UniqueId, name = type.Name,
                font = type.get_Parameter(BuiltInParameter.TEXT_FONT)?.AsString(),
                sizeFeet = type.get_Parameter(BuiltInParameter.TEXT_SIZE)?.AsDouble(),
                bold = type.get_Parameter(BuiltInParameter.TEXT_STYLE_BOLD)?.AsInteger() == 1,
                italic = type.get_Parameter(BuiltInParameter.TEXT_STYLE_ITALIC)?.AsInteger() == 1 };
        }
    }
}
