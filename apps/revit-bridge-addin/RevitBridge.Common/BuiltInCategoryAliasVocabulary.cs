using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class BuiltInCategoryAliasVocabulary
    {
        private static readonly Dictionary<string, string> Aliases =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "duct", "OST_DuctCurves" },
                { "ducts", "OST_DuctCurves" },
                { "duct_curves", "OST_DuctCurves" },
                { "duct_fitting", "OST_DuctFitting" },
                { "duct_fittings", "OST_DuctFitting" },
                { "duct_accessory", "OST_DuctAccessory" },
                { "duct_accessories", "OST_DuctAccessory" },
                { "duct_terminal", "OST_DuctTerminal" },
                { "duct_terminals", "OST_DuctTerminal" },
                { "air_terminal", "OST_DuctTerminal" },
                { "air_terminals", "OST_DuctTerminal" },
                { "air terminal", "OST_DuctTerminal" },
                { "air terminals", "OST_DuctTerminal" },
                { "mechanical_equipment", "OST_MechanicalEquipment" },
                { "mech_equipment", "OST_MechanicalEquipment" },
                { "electrical_fixture", "OST_ElectricalFixtures" },
                { "electrical_fixtures", "OST_ElectricalFixtures" },
                { "electrical fixture", "OST_ElectricalFixtures" },
                { "electrical fixtures", "OST_ElectricalFixtures" },
                { "receptacle", "OST_ElectricalFixtures" },
                { "receptacles", "OST_ElectricalFixtures" },
                { "outlet", "OST_ElectricalFixtures" },
                { "outlets", "OST_ElectricalFixtures" },
                { "power_outlet", "OST_ElectricalFixtures" },
                { "power_outlets", "OST_ElectricalFixtures" },
                { "power outlet", "OST_ElectricalFixtures" },
                { "power outlets", "OST_ElectricalFixtures" },
                { "electrical_device", "OST_ElectricalFixtures" },
                { "electrical_devices", "OST_ElectricalFixtures" },
                { "electrical device", "OST_ElectricalFixtures" },
                { "electrical devices", "OST_ElectricalFixtures" },
                { "lighting fixture", "OST_LightingFixtures" },
                { "lighting fixtures", "OST_LightingFixtures" },
                { "light fixture", "OST_LightingFixtures" },
                { "light fixtures", "OST_LightingFixtures" },
                { "electrical equipment", "OST_ElectricalEquipment" },
            };

        public static bool TryResolve(string? token, out string canonical)
        {
            canonical = "";
            var raw = (token ?? "").Trim();
            return raw.Length > 0 && Aliases.TryGetValue(raw, out canonical);
        }
    }
}
