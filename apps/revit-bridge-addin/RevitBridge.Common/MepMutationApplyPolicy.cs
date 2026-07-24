using System;

namespace RevitBridge.Common
{
    /// <summary>
    /// Fail-closed apply semantics for existing-route MEP mutations.
    /// A write requires an explicit, internally consistent apply pair.
    /// </summary>
    public static class MepMutationApplyPolicy
    {
        public static bool ResolveShouldApply(bool apply, bool dryRun)
        {
            if (apply == dryRun)
            {
                throw new ArgumentException(
                    "apply and dryRun are contradictory. Use apply:true with dryRun:false to mutate, " +
                    "or apply:false with dryRun:true to preflight without changes.");
            }

            return apply;
        }
    }
}
