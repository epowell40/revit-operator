using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class HostedPlacementPreflight
    {
        // Call only before creating or starting any transaction. A missing host
        // is a correctable input/capability mismatch, not an uncertain write.
        public static Dictionary<string, object?>? CheckHost(
            bool hostResolved, string placementType, long exemplarId, long? requestedHostId)
        {
            if (hostResolved) return null;
            var unhosted = placementType == "OneLevelBased";
            return new Dictionary<string, object?>
            {
                ["status"] = "Blocked",
                ["success"] = false,
                ["applied"] = false,
                ["verified"] = false,
                ["errorCode"] = "create_similar_host_required",
                ["error"] = "No host element was available for create-similar. No transaction was started.",
                ["exemplarElementId"] = exemplarId,
                ["requestedHostElementId"] = requestedHostId,
                ["familyPlacementType"] = placementType,
                ["correction"] = unhosted
                    ? "This is a level-based family. Use /revit/create-family-instance with its family/type, level, explicit position and rotation; verify the created instance."
                    : "Resolve a compatible host for this family's placement type before retrying. Do not invent a host or convert it to unhosted placement.",
                ["transaction"] = OperatorNativeTransactionReceipt.NotStarted()
            };
        }
    }
}
