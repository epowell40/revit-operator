using System.Collections.Generic;

namespace RevitBridge.Common
{
    public static class LegendCreationPreflight
    {
        // Only call after native source discovery and before any transaction.
        // A missing seed does not prove the requested Legend is impossible;
        // ordinary Revit UI creation remains available to the working owner.
        public static Dictionary<string, object?>? CheckSource(bool sourceResolved)
        {
            if (sourceResolved) return null;
            return new Dictionary<string, object?>
            {
                ["status"] = "Blocked",
                ["success"] = false,
                ["applied"] = false,
                ["verified"] = false,
                ["errorCode"] = "legend_source_required",
                ["error"] = "No existing non-template Legend was found. No transaction was started.",
                ["correction"] = "This endpoint duplicates an existing Legend. Create the first Legend through Revit's View > Legends > Legend command, then add editable detailing or use that Legend as the source. Do not substitute a Drafting view or key schedule for a requested Legend.",
                ["transaction"] = OperatorNativeTransactionReceipt.NotStarted()
            };
        }
    }
}
