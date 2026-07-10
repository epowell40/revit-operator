namespace RevitBridge.Common
{
    public sealed class CadLinkPreflightCapabilityResponse
    {
        public string status { get; set; } = "Dry Run";
        public bool dryRun { get; set; } = true;
        public bool preflightOnly { get; set; } = true;
        public string targetMode { get; set; } = "view_then_sheet";
        public bool supportsOwnerViewSheetPlacement { get; set; } = true;
        public bool supportsDirectSheetImport { get; set; } = true;
        public bool supportsCadCategories { get; set; } = true;
        public bool supportsCustomScale { get; set; } = true;
        public bool supportsImportUnit { get; set; } = true;
        public string[] requiredApplyEvidence { get; set; } = new[]
        {
            "elementId",
            "ownerViewId",
            "sheetViewId",
            "viewportId",
            "viewportBox",
            "elementBoundingBoxInOwnerView",
            "cadCategories"
        };
    }

    public static class CadLinkPreflightCapability
    {
        public static CadLinkPreflightCapabilityResponse CreateResponse()
        {
            return new CadLinkPreflightCapabilityResponse();
        }
    }
}
