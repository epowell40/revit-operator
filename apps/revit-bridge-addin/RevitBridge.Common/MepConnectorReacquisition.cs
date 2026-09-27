using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    /// <summary>
    /// Reacquires a previously selected connector after an operation may trim its
    /// endpoint. Native identity is scoped to its original owner, not its old XYZ.
    /// Origin proximity is used only when native identity was unavailable.
    /// </summary>
    public static class MepConnectorReacquisition
    {
        public static T Resolve<T>(IEnumerable<T> candidates, long ownerId, long? capturedNativeId,
            Func<T, long> getOwnerId, Func<T, long?> getNativeId,
            Func<T, double> distanceFromOriginal, double originToleranceFt)
        {
            if (ownerId <= 0) throw new ArgumentException("A positive connector owner identity is required.");
            if (originToleranceFt <= 0 || double.IsNaN(originToleranceFt) || double.IsInfinity(originToleranceFt))
                throw new ArgumentException("Connector origin tolerance must be positive and finite.");

            var owned = candidates.Where(candidate => getOwnerId(candidate) == ownerId).ToList();
            if (capturedNativeId.HasValue)
            {
                var matches = owned.Where(candidate => getNativeId(candidate) == capturedNativeId).ToList();
                if (matches.Count != 1)
                    throw new InvalidOperationException($"Native branch connector {capturedNativeId.Value} could not be uniquely re-resolved on element {ownerId}.");
                return matches[0];
            }

            var nearest = owned.Select(candidate => new { candidate, distance = distanceFromOriginal(candidate) })
                .Where(row => !double.IsNaN(row.distance) && !double.IsInfinity(row.distance) && row.distance >= 0)
                .OrderBy(row => row.distance).FirstOrDefault();
            if (nearest == null)
                throw new InvalidOperationException("The branch connector could not be re-resolved.");
            if (nearest.distance > originToleranceFt)
                throw new InvalidOperationException("The branch connector moved beyond the allowed identity/origin guard.");
            return nearest.candidate;
        }
    }
}
