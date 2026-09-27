using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class FamilyPlacementContract
    {
        public static string ResolveCoordinateMode(string? requestedMode, bool generatedWorkPlane)
        {
            var mode = (requestedMode ?? "").Trim().ToLowerInvariant();
            if (mode.Length == 0) return generatedWorkPlane ? "absolute_model" : "legacy_level_offset";
            if (mode != "absolute_model" && mode != "legacy_level_offset")
                throw new ArgumentException("coordinateMode must be absolute_model or legacy_level_offset.");
            if (generatedWorkPlane && mode != "absolute_model")
                throw new ArgumentException("Provisional work-plane placement uses absolute model feet; legacy_level_offset is not supported.");
            return mode;
        }

        public static void VerifySupportedPlacement(double[] requested, double[] actual,
            long requestedLevelId, long? actualLevelId, long expectedHostId, long? actualHostId)
        {
            if (!AbsolutePlacementCorrection.Matches(requested, actual))
                throw new InvalidOperationException("Work-plane placement did not retain the requested model-space point.");
            if (requestedLevelId <= 0 || actualLevelId != requestedLevelId)
                throw new InvalidOperationException("Work-plane placement did not retain the requested effective level.");
            if (expectedHostId <= 0 || actualHostId != expectedHostId)
                throw new InvalidOperationException("Work-plane placement did not retain its exact native support plane.");
        }

        // Used by native reflection so callers receive the same coordinate contract.
        public static void ApplyRequestSchema(Dictionary<string, object> schema)
        {
            var properties = (Dictionary<string, object>)schema["properties"];
            var instances = (Dictionary<string, object>)properties["instances"];
            var item = (Dictionary<string, object>)instances["items"];
            var fields = (Dictionary<string, object>)item["properties"];
            fields["coordinateMode"] = new Dictionary<string, object>
            {
                ["oneOf"] = new object[] { new Dictionary<string, object> { ["type"] = "null" },
                    new Dictionary<string, object> { ["type"] = "string", ["enum"] = new[] { "absolute_model", "legacy_level_offset" } } },
                ["description"] = "Feet. absolute_model uses world XYZ. Omitted mode preserves legacy_level_offset for ordinary families; provisional unhosted WorkPlaneBased placement defaults to absolute_model and rejects legacy mode."
            };
            foreach (var axis in new[] { "x", "y", "z" })
                ((Dictionary<string, object>)fields[axis])["description"] = axis == "z"
                    ? "Feet; absolute model elevation in absolute_model mode, native level offset in ordinary legacy mode."
                    : "Absolute model feet.";
            ((Dictionary<string, object>)properties["allowUnhostedWorkPlanePlacement"])["description"] =
                "Explicitly allows provisional WorkPlaneBased placement on a generated horizontal reference plane at the requested absolute XYZ. Retains and reports one support plane per created instance (maximum 200); this is not an architectural ceiling host. Preview and failed placement roll both back.";
        }
    }
}
