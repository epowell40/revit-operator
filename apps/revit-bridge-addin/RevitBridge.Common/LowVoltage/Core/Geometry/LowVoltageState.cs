using System;
using System.Collections.Generic;

namespace RevitBridge.Common.LowVoltage.Core.Geometry
{
    public class ViewState
    {
        public long? ViewId { get; set; }
        public string? ViewName { get; set; }
        public string? ViewType { get; set; }
        public long? LevelId { get; set; }
        public string? LevelName { get; set; }
        public string? PhaseName { get; set; }
        public BoundingBox2D? CropBox { get; set; }
    }

    public class ModelState
    {
        public ViewState View { get; set; } = new ViewState();
        public List<RoomState> Rooms { get; set; } = new List<RoomState>();
        public List<WallState> Walls { get; set; } = new List<WallState>();
        public List<OpeningState> Openings { get; set; } = new List<OpeningState>();
        public List<CeilingState> Ceilings { get; set; } = new List<CeilingState>();
        public List<EquipmentState> Equipment { get; set; } = new List<EquipmentState>();
        public List<FixtureState> Fixtures { get; set; } = new List<FixtureState>();
        public List<FamilyTypeState> FamilyTypes { get; set; } = new List<FamilyTypeState>();
    }

    public class BoundingBox2D
    {
        public double MinX { get; set; }
        public double MinY { get; set; }
        public double MaxX { get; set; }
        public double MaxY { get; set; }
    }

    public class Point3
    {
        public double X { get; set; }
        public double Y { get; set; }
        public double Z { get; set; }
    }

    public class RoomState
    {
        public long Id { get; set; }
        public string? Number { get; set; }
        public string? Name { get; set; }
        public string? Department { get; set; }
        public double Area { get; set; }
        public double? Height { get; set; }
        public List<Point3> BoundaryPolygon { get; set; } = new List<Point3>();
        public string? SemanticType { get; set; }
    }

    public class WallState
    {
        public long Id { get; set; }
        public Point3 Start { get; set; } = new Point3();
        public Point3 End { get; set; } = new Point3();
        public Point3 Orientation { get; set; } = new Point3();
        public bool IsHostable { get; set; }
        public double Thickness { get; set; }
    }

    public class OpeningState
    {
        public long Id { get; set; }
        public long HostWallId { get; set; }
        public string? OpeningType { get; set; }
        public Point3 Location { get; set; } = new Point3();
        public double? Width { get; set; }
        public string? Swing { get; set; }
    }

    public class CeilingState
    {
        public long Id { get; set; }
        public string? TypeName { get; set; }
        public double? Elevation { get; set; }
        public BoundingBox2D? Bounds { get; set; }
    }

    public class EquipmentState
    {
        public long Id { get; set; }
        public string? Category { get; set; }
        public string? FamilyName { get; set; }
        public string? TypeName { get; set; }
        public Point3 Location { get; set; } = new Point3();
        public string? SemanticType { get; set; }
    }

    public class FixtureState
    {
        public long Id { get; set; }
        public string? Category { get; set; }
        public string? FamilyName { get; set; }
        public string? TypeName { get; set; }
        public Point3 Location { get; set; } = new Point3();
        public string? SemanticType { get; set; }
    }

    public class FamilyTypeState
    {
        public long Id { get; set; }
        public string? Category { get; set; }
        public string? FamilyName { get; set; }
        public string? TypeName { get; set; }
        public bool IsActive { get; set; }
    }
}
