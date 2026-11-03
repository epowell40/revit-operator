using System;
using System.Collections.Generic;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;
using RevitBridge.Common.Annotation;

namespace RevitBridge.Logic.Handlers
{
    public class GetElementSummaryHandler : IRequestHandler
    {
        public class Params
        {
            // Back-compat: earlier clients used { ids: [...] }.
            public List<long> ids { get; set; }

            // Preferred: { elementIds: [...] } (matches other endpoints + Operator schema validator).
            public List<long> elementIds { get; set; }

            // Optional: evaluate bounding boxes in a specific view context (for sheet/view-space targeting).
            public long? viewId { get; set; }
            public bool includeElectricalCircuitMembership { get; set; }
            public int? electricalPanelSlotNumber { get; set; }
            public bool includeTagReferences { get; set; }
            public int? maxTagReferencesPerElement { get; set; }
            public List<long>? preservationScheduleIds { get; set; }
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = JsonSerializer.Deserialize<Params>(jsonData);
            var ids = p?.elementIds ?? p?.ids;
            if (ids == null) throw new ArgumentException("Missing 'elementIds' (or legacy 'ids').");
            var tagReferenceLimit = p.includeTagReferences ? TagReferenceReadPolicy.ValidateRequest(ids, p.maxTagReferencesPerElement) : 16;
            if (!p.includeTagReferences && p.maxTagReferencesPerElement.HasValue)
                throw new ArgumentException("maxTagReferencesPerElement requires includeTagReferences:true.");
            if (p?.includeElectricalCircuitMembership == true && (ids.Count == 0 || ids.Count > 200 || ids.Exists(id => id <= 0) || new HashSet<long>(ids).Count != ids.Count))
                throw new ArgumentException("Electrical membership reads require 1-200 positive exact elementIds.");
            if (p.preservationScheduleIds != null && p.includeElectricalCircuitMembership)
                throw new ArgumentException("Schedule preservation and electrical membership require separate read scopes.");
            if (p?.electricalPanelSlotNumber.HasValue == true &&
                (p.electricalPanelSlotNumber.Value <= 0 || !p.includeElectricalCircuitMembership))
                throw new ArgumentException("A positive electricalPanelSlotNumber requires includeElectricalCircuitMembership:true.");

            var doc = app.ActiveUIDocument?.Document;
            if (doc == null) throw new InvalidOperationException("No active document.");

            View viewForBbox = null;
            if (p?.viewId.HasValue == true && p.viewId.Value != 0)
            {
                viewForBbox = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(p.viewId.Value)) as View;
                if (viewForBbox == null) throw new InvalidOperationException($"View {p.viewId.Value} not found.");
            }

            var results = new List<object>(ids.Count);
            var electricalCircuits = new Dictionary<long, object>();
            foreach (var id in ids)
            {
                var elem = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                if (elem == null)
                {
                    results.Add(new { id, found = false, error = "Element not found" });
                    continue;
                }

                object bboxObj = null;
                try
                {
                    var bbox = elem.get_BoundingBox(viewForBbox);
                    if (bbox == null && viewForBbox != null)
                    {
                        // Fallback to model-space box when view-specific box is unavailable.
                        bbox = elem.get_BoundingBox(null);
                    }
                    if (bbox != null)
                    {
                        bboxObj = new
                        {
                            min = new { x = bbox.Min.X, y = bbox.Min.Y, z = bbox.Min.Z },
                            max = new { x = bbox.Max.X, y = bbox.Max.Y, z = bbox.Max.Z }
                        };
                    }
                }
                catch
                {
                    bboxObj = null;
                }

                object locationObj = null;
                try
                {
                    if (elem is IndependentTag tag)
                        locationObj = NativeTagHeadLocation.Read(tag).SummaryLocation();
                    else if (elem is TextNote textNote)
                        locationObj = NativeTextAnchorLocation.Read(textNote).SummaryLocation();
                    else if (elem.Location is LocationPoint lp)
                    {
                        var pt = lp.Point;
                        locationObj = new { type = "point", x = pt.X, y = pt.Y, z = pt.Z, rotationRadians = lp.Rotation };
                    }
                    else if (elem.Location is LocationCurve lc)
                    {
                        var curve = lc.Curve;
                        var p0 = curve.GetEndPoint(0);
                        var p1 = curve.GetEndPoint(1);
                        locationObj = new
                        {
                            type = "curve",
                            curveType = curve.GetType().Name,
                            p0 = new { x = p0.X, y = p0.Y, z = p0.Z },
                            p1 = new { x = p1.X, y = p1.Y, z = p1.Z }
                        };
                    }
                }
                catch
                {
                    locationObj = null;
                }

                var effectiveLevelId = HostedPlacementUtil.ReadInstanceLevelId(elem);
                var elementType = doc.GetElement(elem.GetTypeId()) as ElementType;
                results.Add(new
                {
                    id = RevitBridge.Common.ElementIdCompat.GetValue(elem.Id),
                    found = true,
                    uniqueId = elem.UniqueId,
                    className = elem.GetType().Name,
                    fullClassName = elem.GetType().FullName,
                    category = elem.Category?.Name,
                    name = elem.Name,
                    typeId = elem.GetTypeId() == ElementId.InvalidElementId ? (long?)null : ElementIdCompat.GetValue(elem.GetTypeId()),
                    familyName = (elementType as FamilySymbol)?.FamilyName,
                    typeName = elementType?.Name,
                    levelId = effectiveLevelId,
                    levelIdBasis = effectiveLevelId.HasValue ? "native_effective_level" : null,
                    levelName = effectiveLevelId.HasValue ? (doc.GetElement(ElementIdCompat.Create(effectiveLevelId.Value)) as Level)?.Name : null,
                    // Read properties from the requested element, not the
                    // optional view used to evaluate its bounding box. Creation
                    // verification needs the actual scale as well as identity.
                    viewType = elem is View summaryView ? summaryView.ViewType.ToString() : null,
                    viewScale = elem is View scaledView ? (int?)scaledView.Scale : null,
                    boundingBox = bboxObj,
                    location = locationObj,
                    electricalCircuitMembership = p?.includeElectricalCircuitMembership == true
                        ? NativeElectricalCircuitSummary.Read(doc, elem, p.electricalPanelSlotNumber, electricalCircuits) : null,
                    tagReferences = p.includeTagReferences ? NativeTagReferenceSummary.Read(doc, elem, tagReferenceLimit) : null,
                    viewIdUsed = viewForBbox != null ? (long?)RevitBridge.Common.ElementIdCompat.GetValue(viewForBbox.Id) : null
                });
            }

            if (p?.includeElectricalCircuitMembership == true)
                return Task.FromResult<object>(new { schema = "operator.electrical_membership_read.v1", complete = true,
                    requestedElementIds = ids, items = results, circuits = electricalCircuits.Values });
            if (p.preservationScheduleIds != null)
                return Task.FromResult(AnnotationSchedulePreservation.AttachRead(doc, new { result = results }, p.preservationScheduleIds));
            return Task.FromResult<object>(results);
        }
    }
}
