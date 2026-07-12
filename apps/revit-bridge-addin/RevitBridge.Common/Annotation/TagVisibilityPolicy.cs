namespace RevitBridge.Common.Annotation
{
    public sealed class TagVisibilityDecision
    {
        public string Status { get; set; } = "not_requested";
        public long OwnerViewId { get; set; }
        public string OwnerKind { get; set; } = "view";
        public bool WasHidden { get; set; }
        public bool WouldChange { get; set; }
        public bool ApplyChange { get; set; }
    }

    public static class TagVisibilityPolicy
    {
        public static TagVisibilityDecision Decide(
            bool requested,
            bool dryRun,
            long viewId,
            long? templateId,
            bool canHideCategory,
            bool isHidden)
        {
            var ownerId = templateId.GetValueOrDefault() > 0 ? templateId!.Value : viewId;
            var ownerKind = templateId.GetValueOrDefault() > 0 ? "view_template" : "view";
            if (!requested)
                return new TagVisibilityDecision { OwnerViewId = ownerId, OwnerKind = ownerKind };
            if (!canHideCategory)
                return new TagVisibilityDecision { Status = isHidden ? "unsupported" : "always_visible", OwnerViewId = ownerId, OwnerKind = ownerKind, WasHidden = isHidden };
            if (!isHidden)
                return new TagVisibilityDecision { Status = "already_visible", OwnerViewId = ownerId, OwnerKind = ownerKind };
            return new TagVisibilityDecision
            {
                Status = dryRun ? "would_show" : "show",
                OwnerViewId = ownerId,
                OwnerKind = ownerKind,
                WasHidden = true,
                WouldChange = true,
                ApplyChange = !dryRun
            };
        }
    }
}
