namespace RevitBridge.Common
{
    public enum CategoryVisibilityMutationDisposition
    {
        Apply,
        AlreadyVisible,
        CannotHide
    }

    public static class CategoryVisibilityMutationPolicy
    {
        public static string? NormalizeDetailLevelOverride(string? value)
        {
            if (value == null) return null; // Omitted preserves the stored override.
            switch (value.Trim().ToLowerInvariant())
            {
                case "coarse": return "Coarse";
                case "medium": return "Medium";
                case "fine": return "Fine";
                case "undefined": return "Undefined"; // Revit: inherit view detail.
                default: throw new System.InvalidOperationException("visibility category detailLevel must be Coarse, Medium, Fine or Undefined (inherit view).");
            }
        }

        public static CategoryVisibilityMutationDisposition Decide(bool hideRequested, bool canCategoryBeHidden)
        {
            if (canCategoryBeHidden)
            {
                return CategoryVisibilityMutationDisposition.Apply;
            }

            return hideRequested
                ? CategoryVisibilityMutationDisposition.CannotHide
                : CategoryVisibilityMutationDisposition.AlreadyVisible;
        }
    }
}
