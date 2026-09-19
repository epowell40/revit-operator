using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    internal static class DuctVerificationParameterReadback
    {
        internal const string Schema = "revit-operator.duct-verification-parameters/v1";
        private static readonly KeyValuePair<string, BuiltInParameter>[] Fields =
        {
            new KeyValuePair<string, BuiltInParameter>("System Classification", BuiltInParameter.RBS_SYSTEM_CLASSIFICATION_PARAM),
            new KeyValuePair<string, BuiltInParameter>("Reference Level", BuiltInParameter.RBS_START_LEVEL_PARAM),
            new KeyValuePair<string, BuiltInParameter>("Width", BuiltInParameter.RBS_CURVE_WIDTH_PARAM),
            new KeyValuePair<string, BuiltInParameter>("Height", BuiltInParameter.RBS_CURVE_HEIGHT_PARAM),
            new KeyValuePair<string, BuiltInParameter>("Diameter", BuiltInParameter.RBS_CURVE_DIAMETER_PARAM)
        };

        // Called synchronously inside the same native read callback as the
        // connector graph. Built-in identities avoid duplicate named parameters.
        public static object Read(Document document, IReadOnlyList<long> ids)
        {
            if (ids.Count < 1 || ids.Count > 500 || ids.Any(id => id <= 0) || ids.Distinct().Count() != ids.Count)
                throw new ArgumentException("Combined duct verification requires 1 through 500 unique positive element IDs.");
            var items = new List<object>();
            foreach (var id in ids)
            {
                try
                {
                    var element = document.GetElement(ElementIdCompat.Create(id));
                    if (element == null) { items.Add(new { id, error = "Element not found." }); continue; }
                    var values = new Dictionary<string, string>(StringComparer.Ordinal);
                    var details = new List<object>();
                    var missing = new List<string>();
                    foreach (var field in Fields)
                    {
                        var parameter = element.get_Parameter(field.Value);
                        if (parameter == null) { missing.Add(field.Key); continue; }
                        var value = Value(parameter);
                        string display;
                        if (parameter.StorageType == StorageType.ElementId)
                            display = document.GetElement(parameter.AsElementId())?.Name ?? value;
                        else
                            display = parameter.AsValueString() ?? value;
                        values.Add(field.Key, value);
                        details.Add(new { name = field.Key, value, valueString = display,
                            nativeName = parameter.Definition?.Name, storageType = parameter.StorageType.ToString(),
                            isReadOnly = parameter.IsReadOnly, parameterId = ElementIdCompat.GetValue(parameter.Id) });
                    }
                    items.Add(new { id, parameters = values, parameterDetails = details, missingFields = missing });
                }
                catch (Exception error) { items.Add(new { id, error = error.Message }); }
            }
            return new { schema = Schema, fields = Fields.Select(field => field.Key).ToArray(), items };
        }

        private static string Value(Parameter parameter)
        {
            switch (parameter.StorageType)
            {
                case StorageType.String: return parameter.AsString() ?? "";
                case StorageType.Integer: return parameter.AsInteger().ToString(CultureInfo.InvariantCulture);
                case StorageType.Double: return parameter.AsDouble().ToString("R", CultureInfo.InvariantCulture);
                case StorageType.ElementId: return ElementIdCompat.GetValue(parameter.AsElementId()).ToString(CultureInfo.InvariantCulture);
                default: return "";
            }
        }
    }
}
