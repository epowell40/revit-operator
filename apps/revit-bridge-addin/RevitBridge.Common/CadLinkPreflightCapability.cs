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
        public string defaultColorMode { get; set; } = "preserve";
        public string[] colorModes { get; set; } = new[] { "preserve", "black_and_white", "invert" };
        public bool fallsBackFromLinkToImport { get; set; } = false;
        public string[] requiredApplyEvidence { get; set; } = new[]
        {
            "elementId",
            "elementUniqueId",
            "sourceSha256",
            "isLinked",
            "colorMode",
            "totalTransformScale",
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
