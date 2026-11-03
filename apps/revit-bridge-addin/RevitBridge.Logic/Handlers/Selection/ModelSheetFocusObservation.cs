using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers
{
    internal static class ModelSheetFocusObservation
    {
        private static double[] Point(XYZ p) => new[] {p.X,p.Y,p.Z};
        internal static XYZ[] Corners(BoundingBoxXYZ box) =>
            (from x in new[] {box.Min.X,box.Max.X} from y in new[] {box.Min.Y,box.Max.Y} from z in new[] {box.Min.Z,box.Max.Z}
             select box.Transform.OfPoint(new XYZ(x,y,z))).ToArray();

        internal static OperatorModelSheetFocus? Read(Document doc, ViewSheet sheet, Element element, IList<string> warnings)
        {
            var candidates=new List<OperatorModelSheetFocus>();var unresolved=false;
            var viewportIds=sheet.GetAllViewports();
            if(viewportIds.Count>128){warnings.Add("Sheet model focus exceeds 128 placed views; no association inferred.");return null;}
            foreach(var id in viewportIds)
            {
                try
                {
                    var viewport=doc.GetElement(id) as Viewport;
                    var view=viewport==null?null:doc.GetElement(viewport.ViewId) as View;
                    if(viewport==null||view==null||viewport.OwnerViewId!=sheet.Id){unresolved=true;continue;}
                    // Bound the collector to this requested existing ID, not a
                    // census or a name match. Collector membership isn't pixels.
                    using var filter=new ElementIdSetFilter(new List<ElementId>{element.Id});
                    using var collector=new FilteredElementCollector(doc,view.Id);
                    if(!collector.WherePasses(filter).Any())continue;
                    if(view.IsTemplate||view is View3D||!view.HasViewTransforms()||!viewport.HasViewportTransforms()||element.IsHidden(view))
                    {unresolved=true;continue;}
                    var box=element.get_BoundingBox(view);
                    if(box==null||!box.Enabled){unresolved=true;continue;}
                    var corners=Corners(box);
                    var regions=view.GetModelToProjectionTransforms();
                    // A split crop can map the same physical bbox into multiple
                    // regions. Refuse rather than selecting a convenient region.
                    try
                    {
                        if(regions.Count!=1){unresolved=true;continue;}
                        using var modelToProjection=regions[0].GetModelToProjectionTransform();
                        var projected=corners.Select(modelToProjection.OfPoint).ToArray();
                        using var boundary=regions[0].GetBoundary();
                        if(boundary==null && view.CropBoxActive){unresolved=true;continue;}
                        if(boundary!=null)
                        {
                            var curves=boundary.Take(33).ToArray();
                            if(curves.Length>32||curves.Any(c=>!(c is Line))){unresolved=true;continue;}
                            var polygon=curves.Select(c=>Point(modelToProjection.OfPoint(c.GetEndPoint(0)))).ToArray();
                            if(!OperatorModelSheetFocus.InsideConvexBoundary(projected.Select(Point).ToArray(),polygon)){unresolved=true;continue;}
                        }
                        using var toSheet=viewport.GetProjectionToSheetTransform();
                        var bounds=OperatorModelSheetFocus.Bounds(projected.Select(p=>Point(toSheet.OfPoint(new XYZ(p.X,p.Y,0)))));
                        candidates.Add(new OperatorModelSheetFocus{elementId=ElementIdCompat.GetValue(element.Id),elementUniqueId=element.UniqueId,
                            viewId=ElementIdCompat.GetValue(view.Id),viewUniqueId=view.UniqueId,viewportId=ElementIdCompat.GetValue(viewport.Id),viewportUniqueId=viewport.UniqueId,
                            sheetId=ElementIdCompat.GetValue(sheet.Id),sheetUniqueId=sheet.UniqueId,boundsMinXyz=bounds[0],boundsMaxXyz=bounds[1]});
                    }
                    finally{foreach(var region in regions)region.Dispose();}
                }
                catch(Exception ex){unresolved=true;warnings.Add($"Sheet model focus unavailable in viewport {ElementIdCompat.GetValue(id)}: {ex.Message}");}
            }
            return OperatorModelSheetFocus.Unique(ElementIdCompat.GetValue(sheet.Id),ElementIdCompat.GetValue(element.Id),candidates,unresolved);
        }
    }
}
