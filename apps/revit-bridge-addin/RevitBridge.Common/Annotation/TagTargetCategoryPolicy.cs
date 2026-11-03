using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    /// <summary>One category contract for tag visibility and loaded/source family
    /// selection. Input is a native BuiltInCategory token, never a localized label.</summary>
    public static class TagTargetCategoryPolicy
    {
        public static string? Resolve(string? category) => category switch
        {
            "OST_DuctCurves" => "OST_DuctTags",
            "OST_DuctTerminal" => "OST_DuctTerminalTags",
            "OST_MechanicalEquipment" => "OST_MechanicalEquipmentTags",
            "OST_ElectricalEquipment" => "OST_ElectricalEquipmentTags",
            "OST_ElectricalFixtures" => "OST_ElectricalFixtureTags",
            "OST_LightingFixtures" => "OST_LightingFixtureTags",
            "OST_PlumbingFixtures" => "OST_PlumbingFixtureTags",
            _ => null
        };

        public static string? ResolveCommon(IEnumerable<string?> categories)
        {
            var tags = categories.Select(Resolve).Distinct(StringComparer.Ordinal).ToArray();
            return tags.Length == 1 ? tags[0] : null;
        }
    }
}
