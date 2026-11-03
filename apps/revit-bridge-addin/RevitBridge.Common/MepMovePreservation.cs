using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common
{
    public sealed class MepMoveEndpointState
    {
        public long Id { get; set; }
        public double[] Point { get; set; } = Array.Empty<double>();
        public double Rotation { get; set; }
        public bool Pinned { get; set; }
    }

    public sealed class MepMovePortState
    {
        public long ElementId { get; set; }
        public long ConnectorId { get; set; }
        public bool Connected { get; set; }
        public string Key => ElementId + ":" + ConnectorId;
    }

    public sealed class MepMovePreservationResult
    {
        public bool Complete { get; set; }
        public long[] ChangedEndpointIds { get; set; } = Array.Empty<long>();
        public string[] ChangedPortKeys { get; set; } = Array.Empty<string>();
        public bool Preserved => Complete && ChangedEndpointIds.Length == 0 && ChangedPortKeys.Length == 0;
    }

    /// <summary>Checks fixed native endpoint geometry as well as physical connection state.</summary>
    public static class MepMovePreservation
    {
        public const double PositionToleranceFeet = 0.000001;

        public static MepMovePreservationResult Evaluate(
            IReadOnlyList<MepMoveEndpointState> before, IReadOnlyList<MepMoveEndpointState> after,
            IReadOnlyList<MepMovePortState> portsBefore, IReadOnlyList<MepMovePortState> portsAfter)
        {
            if (!ValidEndpoints(before) || !ValidEndpoints(after) || !ValidPorts(portsBefore) || !ValidPorts(portsAfter))
                return new MepMovePreservationResult { Complete = false };
            var current = after.ToDictionary(x => x.Id);
            var currentPorts = portsAfter.ToDictionary(x => x.Key);
            var complete = before.Count == after.Count && before.All(x => current.ContainsKey(x.Id))
                && portsBefore.Count == portsAfter.Count && portsBefore.All(x => currentPorts.ContainsKey(x.Key));
            var changed = before.Where(x => current.TryGetValue(x.Id, out var y) &&
                (DistanceSquared(x.Point, y.Point) > PositionToleranceFeet * PositionToleranceFeet
                || Math.Abs(Math.IEEERemainder(y.Rotation - x.Rotation, 2 * Math.PI)) > 0.0000001
                || x.Pinned != y.Pinned)).Select(x => x.Id).OrderBy(x => x).ToArray();
            var changedPorts = portsBefore.Where(x => currentPorts.TryGetValue(x.Key, out var y) && x.Connected != y.Connected)
                .Select(x => x.Key).OrderBy(x => x, StringComparer.Ordinal).ToArray();
            return new MepMovePreservationResult { Complete = complete, ChangedEndpointIds = changed, ChangedPortKeys = changedPorts };
        }

        private static bool Finite(double value) => !double.IsNaN(value) && !double.IsInfinity(value);
        private static bool ValidEndpoints(IReadOnlyList<MepMoveEndpointState> rows) => rows != null
            && rows.All(x => x != null && x.Id > 0 && x.Point != null && x.Point.Length == 3 && x.Point.All(Finite) && Finite(x.Rotation))
            && rows.Select(x => x.Id).Distinct().Count() == rows.Count;
        private static bool ValidPorts(IReadOnlyList<MepMovePortState> rows) => rows != null
            && rows.All(x => x != null && x.ElementId > 0 && x.ConnectorId >= 0)
            && rows.Select(x => x.Key).Distinct(StringComparer.Ordinal).Count() == rows.Count;
        private static double DistanceSquared(double[] a, double[] b) =>
            (a[0] - b[0]) * (a[0] - b[0]) + (a[1] - b[1]) * (a[1] - b[1]) + (a[2] - b[2]) * (a[2] - b[2]);
    }
}
