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

                var connectorsOut = new List<object>();
                try
                {
                    var idx = 0;
                    foreach (var c in MepSystemUtil.GetConnectors(e))
                    {
                        if (idx >= maxConn) break;
                        if (c == null) continue;

                        var origin = c.Origin;
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
                            else if (c.Shape == ConnectorProfileType.Rectangular)
                            {
                                size = new { kind = "rect", widthFt = c.Width, heightFt = c.Height };
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
                                            if (o.Id.IntegerValue == e.Id.IntegerValue) continue;
                                            if (!seen.Add(RevitBridge.Common.ElementIdCompat.GetValue(o.Id))) continue;
                                            refsOut.Add(new
                                            {
                                                ownerId = RevitBridge.Common.ElementIdCompat.GetValue(o.Id),
                                                ownerCategory = SelectionUtil.GetCategoryToken(o) ?? (o.Category?.Name ?? "None")
                                            });
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
                            origin = new[] { origin.X, origin.Y, origin.Z },
                            domain,
                            shape,
                            size,
                            coordinateSystem = cs,
                            connectedTo = refsOut
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
                    systemName = sys,
                    connectorCount = connectorsOut.Count,
                    connectors = connectorsOut
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
    }
}
