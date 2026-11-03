using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    /// <summary>Holds unselected HVAC equipment/terminals fixed during a native move.</summary>
    internal sealed class ConnectedHvacMoveScope
    {
        private readonly Document _document;
        private readonly List<long> _elements = new List<long>();
        private readonly List<MepMoveEndpointState> _before = new List<MepMoveEndpointState>();
        private readonly List<MepMovePortState> _portsBefore = new List<MepMovePortState>();
        private readonly Dictionary<long, string> _identities = new Dictionary<long, string>();
        private readonly List<long> _temporarilyPinned = new List<long>();
        private object? _lastReport;

        public ConnectedHvacMoveScope(Document document, IEnumerable<long> requestedIds)
        {
            _document = document;
            var selected = new HashSet<long>(requestedIds);
            var pending = new Queue<long>(selected);
            var seen = new HashSet<long>();
            var references = 0;
            while (pending.Count > 0)
            {
                var id = pending.Dequeue();
                if (!seen.Add(id)) continue;
                if (seen.Count > 5000) throw new InvalidOperationException("HVAC move connected scope exceeds 5000 elements; use a bounded reroute instead.");
                var element = RequireElement(id);
                var connectors = HvacConnectors(element);
                if (connectors.Count == 0) continue;
                _elements.Add(id);
                _identities.Add(id, element.UniqueId);
                var fixedEndpoint = !selected.Contains(id) && IsEndpoint(element);
                if (fixedEndpoint) _before.Add(ReadEndpoint(element));
                foreach (var connector in connectors)
                {
                    var peers = PhysicalPeers(connector);
                    references += peers.Count;
                    if (references > 100000) throw new InvalidOperationException("HVAC move connector reference scope is too large; use a bounded reroute.");
                    _portsBefore.Add(ReadPort(id, connector, peers));
                    if (!fixedEndpoint)
                        foreach (var peer in peers) pending.Enqueue(ElementIdCompat.GetValue(peer.Owner.Id));
                }
            }
        }

        public void PinFixedEndpoints()
        {
            foreach (var endpoint in _before)
            {
                if (endpoint.Pinned) continue;
                RequireElement(endpoint.Id).Pinned = true;
                _temporarilyPinned.Add(endpoint.Id);
            }
            if (_temporarilyPinned.Count > 0) _document.Regenerate();
        }

        public void RestorePinsAndVerify()
        {
            foreach (var id in _temporarilyPinned) RequireElement(id).Pinned = false;
            _document.Regenerate();
            ReadAndVerify(false);
        }

        public object ReadAndVerify(bool persisted)
        {
            var after = _before.Select(x => ReadEndpoint(RequireIdentity(x.Id))).ToArray();
            var ports = _elements.SelectMany(id => HvacConnectors(RequireIdentity(id))
                .Select(c => ReadPort(id, c, PhysicalPeers(c)))).ToArray();
            var result = MepMovePreservation.Evaluate(_before, after, _portsBefore, ports);
            _lastReport = new
            {
                applicable = _elements.Count > 0, complete = result.Complete, preserved = result.Preserved,
                persisted, positionToleranceFeet = MepMovePreservation.PositionToleranceFeet,
                scannedElementCount = _elements.Count, protectedEndpointIds = _before.Select(x => x.Id).ToArray(),
                before = _before.Select(ReportEndpoint).ToArray(), after = after.Select(ReportEndpoint).ToArray(),
                changedEndpointIds = result.ChangedEndpointIds, changedConnectionPorts = result.ChangedPortKeys
            };
            if (!result.Preserved)
                throw new InvalidOperationException("HVAC move preservation failed: fixed endpoints or original physical connections changed. Endpoints: "
                    + string.Join(",", result.ChangedEndpointIds.Take(20)) + "; ports: " + string.Join(",", result.ChangedPortKeys.Take(20))
                    + ". Use a connected reroute that preserves endpoint positions; do not repeat an uncertain move.");
            return _lastReport;
        }

        public object? LastTransactionalReport => _lastReport;
        private static object ReportEndpoint(MepMoveEndpointState row) => new { id = row.Id, point = row.Point, rotation = row.Rotation, pinned = row.Pinned };
        private Element RequireElement(long id) => _document.GetElement(ElementIdCompat.Create(id))
            ?? throw new InvalidOperationException("HVAC move element unavailable: " + id);
        private Element RequireIdentity(long id)
        {
            var element = RequireElement(id);
            if (!_identities.TryGetValue(id, out var expected) || element.UniqueId != expected)
                throw new InvalidOperationException("HVAC move element identity changed: " + id);
            return element;
        }
        private static bool IsEndpoint(Element element)
        {
            var category = element.Category;
            if (category == null) return false;
            var id = ElementIdCompat.GetValue(category.Id);
            return element is FamilyInstance && (id == (long)BuiltInCategory.OST_DuctTerminal || id == (long)BuiltInCategory.OST_MechanicalEquipment);
        }
        private static MepMoveEndpointState ReadEndpoint(Element element)
        {
            if (!(element.Location is LocationPoint point))
                throw new InvalidOperationException("Fixed HVAC endpoint has no readable native insertion point: " + ElementIdCompat.GetValue(element.Id));
            return new MepMoveEndpointState { Id = ElementIdCompat.GetValue(element.Id),
                Point = new[] { point.Point.X, point.Point.Y, point.Point.Z }, Rotation = point.Rotation, Pinned = element.Pinned };
        }
        private static List<Connector> HvacConnectors(Element element)
        {
            ConnectorManager? manager = element is MEPCurve curve ? curve.ConnectorManager
                : element is FamilyInstance instance ? instance.MEPModel?.ConnectorManager : null;
            if (manager == null)
            {
                if (element is MEPCurve) throw new InvalidOperationException("MEP curve connector manager unavailable.");
                return new List<Connector>();
            }
            var result = new List<Connector>();
            foreach (Connector connector in manager.Connectors)
            {
                if (connector == null) throw new InvalidOperationException("Native HVAC connector enumeration is incomplete.");
                if (connector.ConnectorType != ConnectorType.Logical && connector.Domain == Domain.DomainHvac) result.Add(connector);
            }
            return result;
        }
        private static List<Connector> PhysicalPeers(Connector connector)
        {
            var refs = connector.AllRefs ?? throw new InvalidOperationException("HVAC connector references unavailable.");
            var result = new List<Connector>();
            foreach (Connector peer in refs)
            {
                if (peer == null || peer.Owner == null) throw new InvalidOperationException("Native HVAC reference enumeration is incomplete.");
                if (peer.Owner is MEPSystem || peer.ConnectorType == ConnectorType.Logical
                    || ElementIdCompat.GetValue(peer.Owner.Id) == ElementIdCompat.GetValue(connector.Owner.Id)) continue;
                if (peer.Domain != Domain.DomainHvac) throw new InvalidOperationException("Unexpected physical HVAC peer domain.");
                if (!connector.IsConnectedTo(peer)) continue;
                if (!ReferenceEquals(peer.Owner.Document, connector.Owner.Document) && !peer.Owner.Document.Equals(connector.Owner.Document))
                    throw new InvalidOperationException("HVAC connection crosses the active document boundary.");
                result.Add(peer);
            }
            return result;
        }
        private static MepMovePortState ReadPort(long id, Connector connector, List<Connector> peers)
        {
            if (!MepSystemUtil.TryGetNativeConnectorId(connector, out var nativeId))
                throw new InvalidOperationException("HVAC connector native identity unavailable: " + id);
            if (peers.Count == 0 && connector.IsConnected)
                throw new InvalidOperationException("HVAC physical connection cannot be established from a complete native peer read: " + id + ":" + nativeId);
            return new MepMovePortState { ElementId = id, ConnectorId = nativeId, Connected = peers.Count > 0 };
        }
    }
}
