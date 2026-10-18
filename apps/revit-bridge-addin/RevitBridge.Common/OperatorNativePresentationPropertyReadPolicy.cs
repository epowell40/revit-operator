using System;

namespace RevitBridge.Common
{
    /// <summary>
    /// Documented cached presentation flags whose names contain "load" but whose
    /// getters neither load a document nor start a rendering/export operation.
    /// The native caller must additionally verify the declaring SDK assembly.
    /// This class grants no method, setter, constructor or mutation authority.
    /// </summary>
    public static class OperatorNativePresentationPropertyReadPolicy
    {
        public static bool IsPassiveRead(string? declaringType, string? property, string? resultType)
        {
            if (!string.Equals(resultType, "System.Boolean", StringComparison.Ordinal)) return false;
            return (string.Equals(declaringType, "Autodesk.Revit.DB.TableCellStyle", StringComparison.Ordinal)
                    && string.Equals(property, "IsInactivePhaseload", StringComparison.Ordinal))
                || (string.Equals(declaringType, "Autodesk.Revit.DB.Electrical.PanelScheduleData", StringComparison.Ordinal)
                    && string.Equals(property, "IsAutoShadingForLoadDisplay", StringComparison.Ordinal));
        }
    }
}
