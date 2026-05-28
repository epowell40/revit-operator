using System;
using System.Collections.Generic;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    internal static class BuiltInCategoryTokenUtil
    {
        private static readonly Dictionary<string, BuiltInCategory> Aliases = new Dictionary<string, BuiltInCategory>(StringComparer.OrdinalIgnoreCase)
        {
            // Duct-related (common ask)
            { "duct", BuiltInCategory.OST_DuctCurves },
            { "ducts", BuiltInCategory.OST_DuctCurves },
            { "duct_curves", BuiltInCategory.OST_DuctCurves },
            { "duct_fitting", BuiltInCategory.OST_DuctFitting },
            { "duct_fittings", BuiltInCategory.OST_DuctFitting },
            { "duct_accessory", BuiltInCategory.OST_DuctAccessory },
            { "duct_accessories", BuiltInCategory.OST_DuctAccessory },
            { "duct_terminal", BuiltInCategory.OST_DuctTerminal },
            { "duct_terminals", BuiltInCategory.OST_DuctTerminal },
            { "air_terminal", BuiltInCategory.OST_DuctTerminal },
            { "air_terminals", BuiltInCategory.OST_DuctTerminal },
            { "mechanical_equipment", BuiltInCategory.OST_MechanicalEquipment },
            { "mech_equipment", BuiltInCategory.OST_MechanicalEquipment },
            { "electrical_fixture", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical_fixtures", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical fixture", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical fixtures", BuiltInCategory.OST_ElectricalFixtures },
            { "receptacle", BuiltInCategory.OST_ElectricalFixtures },
            { "receptacles", BuiltInCategory.OST_ElectricalFixtures },
            { "outlet", BuiltInCategory.OST_ElectricalFixtures },
            { "outlets", BuiltInCategory.OST_ElectricalFixtures },
            { "power_outlet", BuiltInCategory.OST_ElectricalFixtures },
            { "power_outlets", BuiltInCategory.OST_ElectricalFixtures },
            { "power outlet", BuiltInCategory.OST_ElectricalFixtures },
            { "power outlets", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical_device", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical_devices", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical device", BuiltInCategory.OST_ElectricalFixtures },
            { "electrical devices", BuiltInCategory.OST_ElectricalFixtures },
            { "lighting fixture", BuiltInCategory.OST_LightingFixtures },
            { "lighting fixtures", BuiltInCategory.OST_LightingFixtures },
            { "light fixture", BuiltInCategory.OST_LightingFixtures },
            { "light fixtures", BuiltInCategory.OST_LightingFixtures },
            { "electrical equipment", BuiltInCategory.OST_ElectricalEquipment },
        };

        public static bool TryParse(string token, out BuiltInCategory category)
        {
            category = default;
            var raw = (token ?? "").Trim();
            if (raw.Length == 0) return false;

            if (Aliases.TryGetValue(raw, out var alias))
            {
                category = alias;
                return true;
            }

            // Accept BuiltInCategory enum names (OST_...)
            if (Enum.TryParse<BuiltInCategory>(raw, ignoreCase: true, out var bic))
            {
                category = bic;
                return true;
            }

            // Accept "Walls" -> OST_Walls, etc.
            if (ElementTypeResolver.TryResolveBuiltInCategory(raw, out var resolved, out _, out _))
            {
                category = resolved;
                return true;
            }

            return false;
        }

        public static void ParseMany(IEnumerable<string>? tokens, List<BuiltInCategory> into, List<string> unknown)
        {
            if (tokens == null) return;
            foreach (var t in tokens)
            {
                if (string.IsNullOrWhiteSpace(t)) continue;
                if (TryParse(t.Trim(), out var bic)) into.Add(bic);
                else unknown.Add(t.Trim());
            }
        }
    }
}
