using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.MEP
{
    public class GetConnectorsHandler : IRequestHandler
    {
        public sealed class Params
        {
            public List<long> elementIds { get; set; } = new List<long>();
            public bool includeAllRefs { get; set; } = true;
            public bool includeCoordinateSystem { get; set; } = true;
            public bool includeFlexGeometry { get; set; } = true;
            public int maxConnectorsPerElement { get; set; } = 64;
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData) ? new Params() : (JsonSerializer.Deserialize<Params>(jsonData) ?? new Params());
            var ids = (p.elementIds ?? new List<long>()).Where(x => x > 0).Distinct().ToList();
            if (ids.Count == 0) throw new ArgumentException("elementIds is required and must be a non-empty array.");
            if (ids.Count > 5000) throw new ArgumentException("elementIds too large (max 5000).");

            var uidoc = app.ActiveUIDocument;
            if (uidoc == null) throw new InvalidOperationException("No active UI document.");
            var doc = uidoc.Document;

            var warnings = new List<string>();
            var results = new List<object>();

            var maxConn = p.maxConnectorsPerElement <= 0 ? 64 : Math.Min(p.maxConnectorsPerElement, 512);

            foreach (var id in ids)
            {
                var e = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (e == null)
                {
                    results.Add(new { id, ok = false, error = "Element not found." });
                    continue;
                }

                var catToken = SelectionUtil.GetCategoryToken(e) ?? (e.Category?.Name ?? "None");
                var sys = MepSystemUtil.TryGetSystemName(e);
                var typeId = TryGetPositiveElementId(e.GetTypeId());
                var typeName = typeId.HasValue
                    ? (doc.GetElement(ElementIdCompat.Create(typeId.Value))?.Name ?? e.Name)
                    : e.Name;
                var createdPhaseId = TryGetPositiveElementId(e.CreatedPhaseId);
                var flexGeometry = p.includeFlexGeometry ? TryGetFlexGeometry(e) : null;

                var connectorsOut = new List<object>();
                try
                {
                    var idx = 0;
                    foreach (var c in MepSystemUtil.GetConnectors(e))
                    {
                        if (idx >= maxConn) break;
                        if (c == null) continue;
                        var hasNativeConnectorId = MepSystemUtil.TryGetNativeConnectorId(c, out var nativeConnectorId);

                        var origin = TryGetConnectorOrigin(c);
                        var shape = c.Shape.ToString();
                        var domain = "";
                        try { domain = c.Domain.ToString(); } catch { domain = ""; }

                        object? size = null;
                        try
                        {
                            if (c.Shape == ConnectorProfileType.Round)
                            {
                                var d = 2.0 * c.Radius;
                                size = new { kind = "round", radiusFt = c.Radius, diameterFt = d };
                            }
                            else if (c.Shape == ConnectorProfileType.Rectangular ||
                                     c.Shape == ConnectorProfileType.Oval)
                            {
                                size = new
                                {
                                    kind = c.Shape == ConnectorProfileType.Oval ? "oval" : "rect",
                                    widthFt = c.Width,
                                    heightFt = c.Height
                                };
                            }
                        }
                        catch { size = null; }

                        object? cs = null;
                        if (p.includeCoordinateSystem)
                        {
                            try
                            {
                                var t = c.CoordinateSystem;
                                if (t != null)
                                {
                                    cs = new
                                    {
                                        origin = new[] { t.Origin.X, t.Origin.Y, t.Origin.Z },
                                        basisX = new[] { t.BasisX.X, t.BasisX.Y, t.BasisX.Z },
                                        basisY = new[] { t.BasisY.X, t.BasisY.Y, t.BasisY.Z },
                                        basisZ = new[] { t.BasisZ.X, t.BasisZ.Y, t.BasisZ.Z }
                                    };
                                }
                            }
                            catch { cs = null; }
                        }

                        var refsOut = new List<object>();
                        var physicalRefsOut = new List<object>();
                        if (p.includeAllRefs)
                        {
                            var seen = new HashSet<long>();
                            try
                            {
                                ConnectorSet? refs = null;
                                try { refs = c.AllRefs; } catch { refs = null; }
                                if (refs != null)
                                {
                                    foreach (Connector r in refs)
                                    {
                                        try
                                        {
                                            var o = r?.Owner;
                                            if (o == null) continue;
                                            if (o.Id == null) continue;
                                            if (RevitBridge.Common.ElementIdCompat.GetValue(o.Id) == RevitBridge.Common.ElementIdCompat.GetValue(e.Id)) continue;
                                            if (!seen.Add(RevitBridge.Common.ElementIdCompat.GetValue(o.Id))) continue;
                                            var ownerCategory = SelectionUtil.GetCategoryToken(o) ?? (o.Category?.Name ?? "None");
                                            var isMepSystem = o is MEPSystem;
                                            var reference = new
                                            {
                                                ownerId = RevitBridge.Common.ElementIdCompat.GetValue(o.Id),
                                                ownerCategory,
                                                isMepSystem,
                                                isPhysicalElement = !isMepSystem
                                            };
                                            refsOut.Add(reference);
                                            if (!isMepSystem) physicalRefsOut.Add(reference);
                                        }
                                        catch
                                        {
                                            // ignore per-ref failures
                                        }
                                    }
                                }
                            }
                            catch
                            {
                                // ignore allrefs failures
                            }
                        }

                        connectorsOut.Add(new
                        {
                            index = idx,
                            connectorId = hasNativeConnectorId ? nativeConnectorId : idx,
                            connectorIdBasis = hasNativeConnectorId ? "revit_native_connector_id" : "enumeration_index_with_origin_guard_required",
                            origin,
                            domain,
                            shape,
                            connectorType = TryGetConnectorPropertyValue(c, "ConnectorType"),
                            direction = TryGetConnectorPropertyValue(c, "Direction"),
                            isConnected = TryGetConnectorPropertyValue(c, "IsConnected"),
                            systemClassification = TryGetConnectorSystemClassification(c),
                            electrical = new
                            {
                                systemType = TryGetConnectorPropertyValue(c, "ElectricalSystemType"),
                                voltageInternal = TryGetConnectorPropertyValue(c, "Voltage"),
                                poles = TryGetConnectorPropertyValue(c, "NumberOfPoles"),
                                apparentLoadInternal = TryGetConnectorPropertyValue(c, "ApparentLoad"),
                                trueLoadInternal = TryGetConnectorPropertyValue(c, "TrueLoad"),
                                powerFactor = TryGetConnectorPropertyValue(c, "PowerFactor"),
                                loadClassification = TryGetConnectorPropertyValue(c, "LoadClassification")
                            },
                            size,
                            coordinateSystem = cs,
                            connectedTo = refsOut,
                            physicalConnectedTo = physicalRefsOut,
                            physicalConnectionCount = physicalRefsOut.Count,
                            isPhysicallyConnected = physicalRefsOut.Count > 0
                        });
                        idx++;
                    }
                }
                catch (Exception ex)
                {
                    results.Add(new { id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id), ok = false, category = catToken, name = e.Name, systemName = sys, error = ex.Message });
                    continue;
                }

                results.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(e.Id),
                    ok = true,
                    category = catToken,
                    name = e.Name,
                    typeId,
                    typeName,
                    createdPhaseId,
                    systemName = sys,
                    connectorCount = connectorsOut.Count,
                    connectors = connectorsOut,
                    flexGeometry
                });
            }

            return Task.FromResult<object>(new
            {
                status = "Ok",
                requestedCount = ids.Count,
                results,
                warnings
            });
        }

        private static long? TryGetPositiveElementId(ElementId? id)
        {
            if (id == null) return null;
            try
            {
                var value = ElementIdCompat.GetValue(id);
                return value > 0 ? value : (long?)null;
            }
            catch { return null; }
        }

        private static object? TryGetConnectorOrigin(Connector connector)
        {
            try
            {
                var origin = connector.Origin;
                return new[] { origin.X, origin.Y, origin.Z };
            }
            catch
            {
                // Logical electrical connectors do not expose a physical origin. They are
                // still essential to circuit and panel diagnostics, so retain the connector
                // with a null origin instead of failing the entire owning element.
                return null;
            }
        }

        private static object? TryGetConnectorPropertyValue(Connector connector, string propertyName)
        {
            try
            {
                var property = connector.GetType().GetProperty(propertyName);
                var value = property?.GetValue(connector, null);
                if (value == null) return null;
                if (value is ElementId elementId) return ElementIdCompat.GetValue(elementId);
                if (value is Enum) return value.ToString();
                if (value is string || value is bool || value is int || value is long || value is double || value is float || value is decimal)
                    return value;
                return value.ToString();
            }
            catch
            {
                return null;
            }
        }

        private static string TryGetConnectorSystemClassification(Connector connector)
        {
            if (connector == null) return "";
            foreach (var propertyName in new[] { "DuctSystemType", "PipeSystemType", "ElectricalSystemType" })
            {
                try
                {
                    var property = connector.GetType().GetProperty(propertyName);
                    var value = property?.GetValue(connector, null);
                    var text = value?.ToString() ?? "";
                    if (!string.IsNullOrWhiteSpace(text) && !string.Equals(text, "UndefinedSystemType", StringComparison.OrdinalIgnoreCase))
                        return text;
                }
                catch
                {
                    // Continue through the cross-discipline property fallbacks.
                }
            }
            return "";
        }

        private static object? TryGetFlexGeometry(Element element)
        {
            if (element is Autodesk.Revit.DB.Mechanical.FlexDuct flexDuct)
            {
                return BuildFlexGeometry(
                    "duct",
                    flexDuct.Points,
                    flexDuct.StartTangent,
                    flexDuct.EndTangent);
            }
            if (element is Autodesk.Revit.DB.Plumbing.FlexPipe flexPipe)
            {
                return BuildFlexGeometry(
                    "pipe",
                    flexPipe.Points,
                    flexPipe.StartTangent,
                    flexPipe.EndTangent);
            }
            return null;
        }

        private static object BuildFlexGeometry(
            string kind,
            IList<XYZ> points,
            XYZ startTangent,
            XYZ endTangent)
        {
            return new
            {
                kind,
                points = (points ?? new List<XYZ>())
                    .Select(point => new[] { point.X, point.Y, point.Z })
                    .ToList(),
                startTangent = new[] { startTangent.X, startTangent.Y, startTangent.Z },
                endTangent = new[] { endTangent.X, endTangent.Y, endTangent.Z }
            };
        }
    }
}
