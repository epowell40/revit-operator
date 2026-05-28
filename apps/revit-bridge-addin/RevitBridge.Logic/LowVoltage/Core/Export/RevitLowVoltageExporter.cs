using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using Autodesk.Revit.DB.Architecture;
using RevitBridge.Common;
using RevitBridge.Common.LowVoltage.Core.Geometry;

namespace RevitBridge.Logic.LowVoltage.Core.Export
{
    public static class RevitLowVoltageExporter
    {
        public static ModelState Export(Document doc, View view)
        {
            var state = new ModelState
            {
                View = new ViewState
                {
                    ViewId = ElementIdCompat.GetValue(view.Id),
                    ViewName = view.Name,
                    ViewType = view.ViewType.ToString(),
                    LevelId = ElementIdCompat.GetValue((view as ViewPlan)?.GenLevel?.Id),
                    LevelName = (view as ViewPlan)?.GenLevel?.Name,
                    CropBox = view.CropBox == null ? null : new BoundingBox2D
                    {
                        MinX = view.CropBox.Min.X,
                        MinY = view.CropBox.Min.Y,
                        MaxX = view.CropBox.Max.X,
                        MaxY = view.CropBox.Max.Y
                    }
                }
            };

            var rooms = new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Rooms).OfClass(typeof(SpatialElement)).Cast<SpatialElement>().OfType<Room>();
            foreach (var room in rooms.Where(r => r.Area > 0))
            {
                var poly = GetRoomPolygon(room);
                state.Rooms.Add(new RoomState
                {
                    Id = ElementIdCompat.GetValue(room.Id),
                    Number = room.Number,
                    Name = room.Name,
                    Department = room.LookupParameter("Department")?.AsString(),
                    Area = room.Area,
                    Height = room.UnboundedHeight,
                    BoundaryPolygon = poly
                });
            }

            var walls = new FilteredElementCollector(doc, view.Id).OfClass(typeof(Wall)).Cast<Wall>();
            foreach (var wall in walls)
            {
                if (!(wall.Location is LocationCurve lc)) continue;
                var c = lc.Curve;
                var s = c.GetEndPoint(0);
                var e = c.GetEndPoint(1);
                state.Walls.Add(new WallState
                {
                    Id = ElementIdCompat.GetValue(wall.Id),
                    Start = ToPoint(s),
                    End = ToPoint(e),
                    Orientation = ToPoint(wall.Orientation),
                    IsHostable = wall.WallType.Kind != WallKind.Curtain,
                    Thickness = wall.Width
                });
            }

            var doors = new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Doors).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>();
            foreach (var d in doors)
            {
                var p = (d.Location as LocationPoint)?.Point;
                if (p == null) continue;
                state.Openings.Add(new OpeningState
                {
                    Id = ElementIdCompat.GetValue(d.Id),
                    HostWallId = ElementIdCompat.GetValue(d.Host?.Id),
                    OpeningType = "door",
                    Location = ToPoint(p),
                    Width = d.Symbol?.LookupParameter("Width")?.AsDouble(),
                    Swing = d.FacingOrientation?.Z >= 0 ? "default" : "flipped"
                });
            }

            var ceilings = new FilteredElementCollector(doc, view.Id).OfCategory(BuiltInCategory.OST_Ceilings).WhereElementIsNotElementType();
            foreach (var c in ceilings)
            {
                var bb = c.get_BoundingBox(view);
                state.Ceilings.Add(new CeilingState
                {
                    Id = ElementIdCompat.GetValue(c.Id),
                    TypeName = doc.GetElement(c.GetTypeId())?.Name,
                    Elevation = bb?.Min.Z,
                    Bounds = bb == null ? null : new BoundingBox2D { MinX = bb.Min.X, MinY = bb.Min.Y, MaxX = bb.Max.X, MaxY = bb.Max.Y }
                });
            }

            ExportFamilyInstances(doc, view, state);
            ExportFamilyTypes(doc, state);
            return state;
        }

        private static void ExportFamilyInstances(Document doc, View view, ModelState state)
        {
            var families = new FilteredElementCollector(doc, view.Id).OfClass(typeof(FamilyInstance)).Cast<FamilyInstance>();
            foreach (var fi in families)
            {
                var loc = (fi.Location as LocationPoint)?.Point;
                if (loc == null) continue;
                var category = fi.Category?.Name ?? "Unknown";
                if (category.IndexOf("furniture", StringComparison.OrdinalIgnoreCase) >= 0 || category.IndexOf("equipment", StringComparison.OrdinalIgnoreCase) >= 0)
                {
                    state.Equipment.Add(new EquipmentState { Id = ElementIdCompat.GetValue(fi.Id), Category = category, FamilyName = fi.Symbol?.FamilyName, TypeName = fi.Symbol?.Name, Location = ToPoint(loc) });
                }
                else
                {
                    state.Fixtures.Add(new FixtureState { Id = ElementIdCompat.GetValue(fi.Id), Category = category, FamilyName = fi.Symbol?.FamilyName, TypeName = fi.Symbol?.Name, Location = ToPoint(loc) });
                }
            }
        }

        private static void ExportFamilyTypes(Document doc, ModelState state)
        {
            foreach (FamilySymbol symbol in new FilteredElementCollector(doc).OfClass(typeof(FamilySymbol)).Cast<FamilySymbol>())
            {
                state.FamilyTypes.Add(new FamilyTypeState
                {
                    Id = ElementIdCompat.GetValue(symbol.Id),
                    Category = symbol.Category?.Name,
                    FamilyName = symbol.FamilyName,
                    TypeName = symbol.Name,
                    IsActive = symbol.IsActive
                });
            }
        }

        private static List<Point3> GetRoomPolygon(Room room)
        {
            var list = new List<Point3>();
            var boundary = room.GetBoundarySegments(new SpatialElementBoundaryOptions());
            if (boundary == null) return list;
            foreach (var segList in boundary)
            {
                foreach (var seg in segList)
                {
                    list.Add(ToPoint(seg.GetCurve().GetEndPoint(0)));
                }
            }

            return list;
        }

        private static Point3 ToPoint(XYZ xyz) => new Point3 { X = xyz.X, Y = xyz.Y, Z = xyz.Z };
    }
}
