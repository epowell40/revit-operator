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
