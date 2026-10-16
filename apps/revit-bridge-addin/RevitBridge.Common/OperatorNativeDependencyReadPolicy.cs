using System;
using System.Collections.Generic;
using System.Text.Json;

namespace RevitBridge.Common
{
    /// <summary>
    /// The SDK documents a null filter for a complete logical-child census.
    /// This exception grants no ElementFilter construction or deserialization.
    /// The gateway must additionally bind this metadata to the real SDK method.
    /// </summary>
    public static class OperatorNativeDependencyReadPolicy
    {
        public static bool IsUnfilteredRead(string? declaringType, string? method, bool isStatic,
            string? resultType, IReadOnlyList<string> parameterTypes)
            => declaringType == "Autodesk.Revit.DB.Element" && method == "GetDependentElements" && !isStatic
                && resultType == "System.Collections.Generic.IList`1<Autodesk.Revit.DB.ElementId>"
                && parameterTypes.Count == 1 && parameterTypes[0] == "Autodesk.Revit.DB.ElementFilter";

        public static void RequireNullFilter(IReadOnlyList<JsonElement> arguments)
        {
            if (arguments.Count != 1 || arguments[0].ValueKind != JsonValueKind.Null)
                throw new InvalidOperationException("GetDependentElements in the read graph requires args:[null]; filters and references are not supported.");
        }
    }
}
