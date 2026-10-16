using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Handlers
{
    internal static class ProjectParameterBindingPreservation
    {
        internal static object Capture(Document doc, IEnumerable<long> requestedCategoryIds, long? excludedParameterId)
        {
            var timer = Stopwatch.StartNew();
            var categoryIds = requestedCategoryIds.Distinct().OrderBy(id => id).ToArray();
            var elements = new Dictionary<long, Element>();
            foreach (var categoryId in categoryIds)
            {
                // Include all category types, even unused ones, and all instances.
                using var collector = new FilteredElementCollector(doc).OfCategoryId(ElementIdCompat.Create(categoryId));
                foreach (var element in collector)
                {
                    elements[ElementIdCompat.GetValue(element.Id)] = element;
                    if (elements.Count > 10000) throw new InvalidOperationException("Binding preservation exceeds 10000 category instances/types.");
                }
            }
            var totalParameters = 0;
            var rows = new List<object>();
            foreach (var element in elements.OrderBy(row => row.Key).Select(row => row.Value))
            {
                if (timer.ElapsedMilliseconds > 10000) throw new InvalidOperationException("Binding preservation exceeded its 10-second bound.");
                var digest = ParameterValuePreservationDigest.Compute(element.Parameters.Cast<Parameter>().Select(Value), excludedParameterId, out var parameterCount);
                totalParameters += parameterCount;
                if (totalParameters > 300000) throw new InvalidOperationException("Binding preservation exceeds 300000 raw parameter values.");
                rows.Add(new { id = ElementIdCompat.GetValue(element.Id), uniqueId = element.UniqueId,
                    categoryId = ElementIdCompat.GetValue(element.Category.Id), typeId = ElementIdCompat.GetValue(element.GetTypeId()),
                    isType = element is ElementType, parameterCount, parametersHash = digest });
            }
            if (timer.ElapsedMilliseconds > 10000) throw new InvalidOperationException("Binding preservation exceeded its 10-second bound.");
            return new { schema = "operator.project_binding_preservation.v1", complete = true,
                coverage = "category_instances_and_types_raw_parameters_v1", categoryIds, excludedParameterId,
                elementCount = rows.Count, totalParameters, elements = rows };
        }

        private static PreservedParameterValue Value(Parameter p)
        {
            if (p.Definition == null) throw new InvalidOperationException("Native parameter definition unavailable for preservation.");
            object? raw = null;
            if (p.HasValue)
            {
                switch (p.StorageType)
                {
                    case StorageType.String: raw = p.AsString(); break;
                    case StorageType.Integer: raw = p.AsInteger(); break;
                    case StorageType.Double: raw = p.AsDouble(); break;
                    case StorageType.ElementId: raw = ElementIdCompat.GetValue(p.AsElementId()); break;
                }
            }
            return new PreservedParameterValue { Id = ElementIdCompat.GetValue(p.Id), Name = p.Definition.Name,
                Storage = p.StorageType.ToString(), HasValue = p.HasValue, Value = raw,
                IsReadOnly = p.IsReadOnly, UserModifiable = p.UserModifiable,
                SharedGuid = p.IsShared ? p.GUID.ToString("D") : null };
        }
    }
}
