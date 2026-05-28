using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    public class TransactionValidateHandler : IRequestHandler
    {
        public class Params
        {
            public string transactionId { get; set; }
            public List<Check> checks { get; set; }
        }

        public class Check
        {
            public string kind { get; set; }
            public long elementId { get; set; }
            public string parameterName { get; set; }
            public string expectedValue { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active document.");

            var failures = new List<object>();
            var checks = p?.checks ?? new List<Check>();

            foreach (var check in checks)
            {
                if (check == null || string.IsNullOrWhiteSpace(check.kind))
                {
                    failures.Add(new { kind = check?.kind, elementId = check?.elementId, message = "Invalid check: missing kind." });
                    continue;
                }

                switch (check.kind)
                {
                    case "exists":
                    {
                        var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(check.elementId));
                        if (elem == null)
                        {
                            failures.Add(new { kind = check.kind, elementId = check.elementId, message = "Element does not exist." });
                        }
                        break;
                    }
                    case "notExists":
                    {
                        var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(check.elementId));
                        if (elem != null)
                        {
                            failures.Add(new { kind = check.kind, elementId = check.elementId, message = "Element exists but should not." });
                        }
                        break;
                    }
                    case "parameterEquals":
                    {
                        var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(check.elementId));
                        if (elem == null)
                        {
                            failures.Add(new { kind = check.kind, elementId = check.elementId, parameterName = check.parameterName, message = "Element not found." });
                            break;
                        }

                        if (string.IsNullOrWhiteSpace(check.parameterName))
                        {
                            failures.Add(new { kind = check.kind, elementId = check.elementId, message = "Missing parameterName." });
                            break;
                        }

                        var param = elem.LookupParameter(check.parameterName);
                        if (param == null)
                        {
                            failures.Add(new { kind = check.kind, elementId = check.elementId, parameterName = check.parameterName, message = "Parameter not found." });
                            break;
                        }

                        if (!ParameterEquals(param, check.expectedValue))
                        {
                            failures.Add(new
                            {
                                kind = check.kind,
                                elementId = check.elementId,
                                parameterName = check.parameterName,
                                expectedValue = check.expectedValue,
                                message = "Parameter value mismatch."
                            });
                        }
                        break;
                    }
                    default:
                        failures.Add(new { kind = check.kind, elementId = check.elementId, message = "Unknown check kind." });
                        break;
                }
            }

            return Task.FromResult<object>(new
            {
                passed = failures.Count == 0,
                transactionId = p?.transactionId,
                failures = failures
            });
        }

        private static bool ParameterEquals(Parameter param, string expected)
        {
            expected = expected ?? "";

            switch (param.StorageType)
            {
                case StorageType.String:
                    return string.Equals(param.AsString() ?? "", expected, StringComparison.Ordinal);
                case StorageType.Integer:
                {
                    if (int.TryParse(expected, NumberStyles.Integer, CultureInfo.InvariantCulture, out var expInt) ||
                        int.TryParse(expected, NumberStyles.Integer, CultureInfo.CurrentCulture, out expInt))
                    {
                        return param.AsInteger() == expInt;
                    }
                    return string.Equals(param.AsInteger().ToString(CultureInfo.InvariantCulture), expected, StringComparison.Ordinal);
                }
                case StorageType.Double:
                {
                    if (double.TryParse(expected, NumberStyles.Float, CultureInfo.InvariantCulture, out var expDbl) ||
                        double.TryParse(expected, NumberStyles.Float, CultureInfo.CurrentCulture, out expDbl))
                    {
                        return Math.Abs(param.AsDouble() - expDbl) < 1e-6;
                    }
                    return string.Equals(param.AsDouble().ToString("R", CultureInfo.InvariantCulture), expected, StringComparison.Ordinal);
                }
                case StorageType.ElementId:
                {
                    if (long.TryParse(expected, NumberStyles.Integer, CultureInfo.InvariantCulture, out var expId) ||
                        long.TryParse(expected, NumberStyles.Integer, CultureInfo.CurrentCulture, out expId))
                    {
                        return RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()) == expId;
                    }
                    return string.Equals(RevitBridge.Common.ElementIdCompat.GetValue(param.AsElementId()).ToString(CultureInfo.InvariantCulture), expected, StringComparison.Ordinal);
                }
                default:
                    return false;
            }
        }
    }
}
