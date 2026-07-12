using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.Annotation
{
    public static class TagCandidateProbePolicy
    {
        public static IReadOnlyList<TagPlacementCandidate> Select(
            IReadOnlyList<TagPlacementCandidate> rankedCandidates,
            int maxAttempts,
            int maxPredictedCollisionProbes = 4)
        {
            if (rankedCandidates == null) throw new ArgumentNullException(nameof(rankedCandidates));
            var bounded = rankedCandidates.Take(Math.Max(1, maxAttempts)).ToList();
            var collisionProbeLimit = Math.Max(0, maxPredictedCollisionProbes);
            return bounded
                .Where(candidate => candidate.CollisionFree)
                .Concat(bounded.Where(candidate => !candidate.CollisionFree).Take(collisionProbeLimit))
                .ToList();
        }
    }
}
