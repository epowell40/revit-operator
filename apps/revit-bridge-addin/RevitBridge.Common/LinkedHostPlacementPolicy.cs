using System;

namespace RevitBridge.Common
{
    public static class LinkedHostPlacementPolicy
    {
        public static void Validate(bool isLink, bool isWorkPlaneBased, long? linkedId)
        {
            if (isLink && (!linkedId.HasValue || linkedId.Value <= 0))
                throw new ArgumentException("A RevitLinkInstance host requires linkedHostElementId identifying the exact linked ceiling, floor or wall; the whole link is not a placement face.");
            if (linkedId.HasValue && (!isLink || !isWorkPlaneBased || linkedId.Value <= 0))
                throw new ArgumentException("Exact linked-face placement requires a positive linkedHostElementId, a RevitLinkInstance and a WorkPlaneBased family.");
        }

        public static bool Matches(long expectedLink, long expectedElement, long observedLink, long observedElement)
            => expectedLink > 0 && expectedElement > 0 && expectedLink == observedLink && expectedElement == observedElement;
    }
}
