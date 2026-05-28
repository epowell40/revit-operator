using System;
using System.Collections.Generic;
using System.Linq;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Common.LowVoltage.Core.Normalization
{
    public class NormalizationProfile
    {
        public Dictionary<string, List<string>> RoomMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, List<string>> EquipmentMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, List<string>> FixtureMappings { get; set; } = new Dictionary<string, List<string>>(StringComparer.OrdinalIgnoreCase);
    }

    public static class NormalizationEngine
    {
        public static ModelState Normalize(ModelState state, NormalizationProfile profile, IList<string>? unknownClassifications = null)
        {
            foreach (var room in state.Rooms)
            {
                room.SemanticType = MapValue(room.Name, profile.RoomMappings, unknownClassifications, $"room:{room.Name}");
            }

            foreach (var eq in state.Equipment)
            {
                eq.SemanticType = MapValue($"{eq.FamilyName} {eq.TypeName}", profile.EquipmentMappings, unknownClassifications, $"equipment:{eq.FamilyName}/{eq.TypeName}");
            }

            foreach (var fx in state.Fixtures)
            {
                fx.SemanticType = MapValue($"{fx.FamilyName} {fx.TypeName}", profile.FixtureMappings, unknownClassifications, $"fixture:{fx.FamilyName}/{fx.TypeName}");
            }

            return state;
        }

        private static string MapValue(string? source, Dictionary<string, List<string>> map, IList<string>? unknownClassifications, string unknownTag)
        {
            var normalized = (source ?? string.Empty).Trim();
            foreach (var kvp in map)
            {
                if (kvp.Value.Any(v => normalized.IndexOf(v, StringComparison.OrdinalIgnoreCase) >= 0))
                {
                    return kvp.Key;
                }
            }

            unknownClassifications?.Add(unknownTag);
            return "unknown";
        }
    }
}
