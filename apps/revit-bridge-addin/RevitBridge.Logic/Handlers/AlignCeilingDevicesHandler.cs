using RevitBridge.Common;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;

namespace RevitBridge.Logic.Handlers
{
    public class AlignCeilingDevicesHandler : IRequestHandler
    {
        public class Request
        {
            public Selection selection { get; set; }
            public Scope scope { get; set; }
            public GridAnchor grid_anchor { get; set; }
            public Rules rules { get; set; }
        }

        public class Selection
        {
            public List<int> ids { get; set; }
        }

        public class Scope
        {
            public string level_name { get; set; }
        }

        public class GridAnchor
        {
            public string method { get; set; } // "auto_api", "pick_point"
            public SimplePoint picked_point { get; set; }
        }

        public class SimplePoint
        {
            public double x { get; set; }
            public double y { get; set; }
            public double z { get; set; }
        }

        public class Rules
        {
            public double center_threshold_ratio { get; set; } = 0.8;
            public double snap_tolerance_ft { get; set; } = 0.5;
        }

        private class GridDef
        {
            public XYZ Origin { get; set; }
            public XYZ U { get; set; }
            public XYZ V { get; set; }
            public double USpacing { get; set; }
            public double VSpacing { get; set; }
            public bool IsValid { get; set; } = false;
        }

        public Task<object> Handle(Autodesk.Revit.UI.UIApplication app, string jsonData)
        {
            var req = JsonSerializer.Deserialize<Request>(jsonData);
            var doc = app.ActiveUIDocument.Document;

            var results = new
            {
                aligned_count = 0,
                skipped_count = 0,
                details = new List<string>()
            };

            int aligned = 0;
            int skipped = 0;

            using (Transaction t = new Transaction(doc, "Align Ceiling Devices"))
            {
                t.Start();

                // 1. Collect Elements
                List<Element> elementsToAlign = new List<Element>();
                if (req.selection != null && req.selection.ids != null && req.selection.ids.Count > 0)
                {
                    foreach (var id in req.selection.ids)
                    {
                        var el = doc.GetElement(RevitBridge.Common.ElementIdCompat.Create(id));
                        if (el != null) elementsToAlign.Add(el);
                    }
                }
                else
                {
                    // Fallback to scope or all in view? For safety, if no selection, return empty.
                    // Or implement "All on Level" if scope is provided.
                    if (req.scope != null && !string.IsNullOrEmpty(req.scope.level_name))
                    {
                        // Collect all lighting/terminals/sensors on level
                         var cats = new List<BuiltInCategory> { 
                            BuiltInCategory.OST_LightingFixtures, 
                            BuiltInCategory.OST_DuctTerminal, 
                            BuiltInCategory.OST_FireAlarmDevices,
                            BuiltInCategory.OST_Sprinklers
                        };
                        var filter = new ElementMulticategoryFilter(cats);
                        elementsToAlign = new FilteredElementCollector(doc)
                            .WherePasses(filter)
                            .WhereElementIsNotElementType()
                            .Where(e => e.LevelId != ElementId.InvalidElementId && doc.GetElement(e.LevelId).Name == req.scope.level_name)
                            .ToList();
                    }
                }

                // 2. Group by Host (Ceiling)
                var devicesByCeiling = elementsToAlign
                    .OfType<FamilyInstance>()
                    .Where(e => e.Host != null && (RevitBridge.Common.ElementIdCompat.GetValue(e.Host.Category.Id) == (int)BuiltInCategory.OST_Ceilings))
                    .GroupBy(e => e.Host.Id)
                    .ToList();

                foreach (var group in devicesByCeiling)
                {
                    var ceiling = doc.GetElement(group.Key) as Ceiling;
                    if (ceiling == null) continue;

                    // 3. Extract Grid
                    GridDef grid = GetCeilingGrid(ceiling, req.grid_anchor);
                    
                    if (!grid.IsValid)
                    {
                        skipped += group.Count();
                        results.details.Add($"Skipped Ceiling {ceiling.Id}: Could not detect grid.");
                        continue;
                    }

                    // 4. Align Devices
                    foreach (var device in group)
                    {
                        if (AlignDevice(device, grid, req.rules))
                        {
                            aligned++;
                        }
                        else
                        {
                            skipped++;
                        }
                    }
                }

                t.Commit();
            }

            return Task.FromResult<object>(new { aligned_count = aligned, skipped_count = skipped, details = results.details });
        }

        private GridDef GetCeilingGrid(Ceiling ceiling, GridAnchor anchor)
        {
            // Method 1: Try Revit 2026 API (Reflection)
            // Ceiling.GetCeilingGridLines()
            // We skip this for now as we know we are likely on older runtime, but good to have placeholder.

            // Method 2: Geometry Extraction (Model Pattern Lines)
            var grid = ExtractGridFromGeometry(ceiling);
            if (grid.IsValid) return grid;

            // Method 3: Fallback (Pick Point or manual)
            if (anchor != null && anchor.picked_point != null)
            {
                // Construct grid from pick point + Material Fill Pattern spacing
                // This requires getting the FillPattern from the material.
                // return ConstructGridFromPick(ceiling, anchor.picked_point);
            }

            return new GridDef { IsValid = false };
        }

        private GridDef ExtractGridFromGeometry(Ceiling ceiling)
        {
            var def = new GridDef();
            
            // Get Geometry
            Options opt = new Options();
            opt.DetailLevel = ViewDetailLevel.Fine;
            // IncludeNonVisibleObjects sometimes exposes the pattern lines
            // But often they are just rendered on the face.
            // Some Revit versions expose pattern lines as 'Line' geometry in the element stream.
            
            GeometryElement geoElem = ceiling.get_Geometry(opt);
            if (geoElem == null) return def;

            List<Line> allLines = new List<Line>();
            Face bottomFace = null;

            foreach (var obj in geoElem)
            {
                if (obj is Solid solid)
                {
                    foreach (Face face in solid.Faces)
                    {
                        // Find bottom face
                        if (face is PlanarFace pf && pf.FaceNormal.IsAlmostEqualTo(new XYZ(0,0,-1)))
                        {
                            bottomFace = pf;
                        }
                    }
                }
                else if (obj is Line line)
                {
                    allLines.Add(line);
                }
            }
            
            // Note: If 'Line' objects are not in the top stream, we might need to look deeper or checks specific views.
            // Often, model patterns are not exposed as geometry lines in the API directly on the element unless Exploded.
            // However, let's try a robust fallback: FillPattern.
            
            if (allLines.Count < 2)
            {
               return TryGetGridFromMaterial(ceiling);
            }

            // If we found lines, process them to find U and V vectors and Spacing
            // (Simplification for prototype: Assume 90 degree grid aligned to X/Y or rotated)
            
            // TODO: Implement robust line clustering if lines are available.
            // Since we can't guarantee lines are exposed without "Explode" (which we can't do easily in API without transaction rollback tricks),
            // Let's rely on Material Extraction + Bounding Box Center or Face Center for Phase 1.
            
            return TryGetGridFromMaterial(ceiling);
        }

        private GridDef TryGetGridFromMaterial(Ceiling ceiling)
        {
             var def = new GridDef();
             
             // Get Top Layer (Finish)
             // Ceiling.GetType -> CompoundStructure
             var type = ceiling.Document.GetElement(ceiling.GetTypeId()) as CeilingType;
             if (type == null) return def;
             
             var structure = type.GetCompoundStructure();
             if (structure == null) return def;
             
             // Layers are ordered Bottom to Top? Or Top to Bottom?
             // Ceiling is usually looking up. Finish is at the bottom (Exterior).
             // We need the layer with the Surface Pattern.
             
             foreach (var layer in structure.GetLayers())
             {
                 var matId = layer.MaterialId;
                 if (matId == ElementId.InvalidElementId) continue;
                 
                 var mat = ceiling.Document.GetElement(matId) as Material;
                 if (mat == null) continue;
                 
                 var patternId = mat.SurfaceForegroundPatternId;
                 if (patternId == ElementId.InvalidElementId) continue;
                 
                 var patternElem = ceiling.Document.GetElement(patternId) as FillPatternElement;
                 var pattern = patternElem?.GetFillPattern();
                 
                 if (pattern != null && pattern.Target == FillPatternTarget.Model) // Must be Model Pattern
                 {
                     var grids = pattern.GetFillGrids();
                     if (grids.Count > 0) // Crosshatch has 2
                     {
                         // We found a model pattern.
                         // Problem: We know the Spacing, but not the Origin relative to the Element.
                         // The "Pattern Origin" is usually the Bottom Left of the bounding box of the face, or element origin.
                         // We will assume "Center of Face" alignment or "Element Origin" alignment for now.
                         // A common default for ceilings is "Center" or "Origin".
                         
                         // Let's assume standard 2x2 or 2x4.
                         var g1 = grids[0];
                         // Convert internal units (feet)
                         
                         def.USpacing = Math.Abs(g1.Offset); // Offset is usually spacing for lines
                         if (def.USpacing < 0.001) def.USpacing = 2.0; // Default 2x2
                         
                         def.VSpacing = 2.0;
                         if (grids.Count > 1) {
                             def.VSpacing = Math.Abs(grids[1].Offset);
                         } else {
                              // If parallel lines, maybe 2x4? Assume 2x2 for single grid?
                              // Or maybe it's just one direction (planks).
                              def.VSpacing = def.USpacing;
                         }
                         
                         // Orientation
                         // Basic assumption: Grid aligns with Element local coordinate system
                         // Using Bounding Box for origin estimate
                         var bb = ceiling.get_BoundingBox(null);
                         def.Origin = (bb.Min + bb.Max) * 0.5; // Center
                         def.U = XYZ.BasisX;
                         def.V = XYZ.BasisY;
                         
                         // If the ceiling is rotated, we need to find the rotation.
                         // Use the first long edge of the ceiling face.
                         // (Skipped for brevity, assuming axis-aligned for V1)
                         
                         def.IsValid = true;
                         return def;
                     }
                 }
             }
             
             return def;
        }

        private bool AlignDevice(Element device, GridDef grid, Rules rules)
        {
            var lp = device.Location as LocationPoint;
            if (lp == null) return false;

            XYZ current = lp.Point;

            // Project to Grid Space relative to Origin
            XYZ diff = current - grid.Origin;
            double u = diff.DotProduct(grid.U);
            double v = diff.DotProduct(grid.V);

            // Normalize to Tile Coordinates (0..1)
            double u_tile = u / grid.USpacing;
            double v_tile = v / grid.VSpacing;

            // Find Center of nearest tile
            // Tile indices
            double u_idx = Math.Round(u_tile);
            double v_idx = Math.Round(v_tile);

            // Target in Grid Coords (Center of tile? or Corner?)
            // If the device is small, we want Center (Index + 0.0?).
            // Wait, round gives nearest integer. So 0.5 becomes 1.0 or 0.0.
            // If we want center, we want the half-integers? 
            // Usually tiles are defined by lines at integers. So Center is X.5.
            // But if we use Round(), we are snapping to Lines (Corners).
            
            // Logic:
            // "Center in nearest tile" -> Target is X.5, Y.5
            // "Snap to nearest boundary" -> Target is X.0, Y.0
            
            // Detect if we want Center or Corner
            // Simple heuristic: If currently close to integer, snap to corner. If close to .5, snap to center.
            
            double u_rem = u_tile - Math.Floor(u_tile); // 0..1
            double v_rem = v_tile - Math.Floor(v_tile); // 0..1
            
            double target_u_local = 0;
            double target_v_local = 0;

            // Check U
            if (Math.Abs(u_rem - 0.5) < 0.25) target_u_local = Math.Floor(u_tile) + 0.5; // Closer to center
            else target_u_local = Math.Round(u_tile); // Closer to line

            // Check V
            if (Math.Abs(v_rem - 0.5) < 0.25) target_v_local = Math.Floor(v_tile) + 0.5;
            else target_v_local = Math.Round(v_tile);

            // Reconstruct Target
            XYZ targetPos = grid.Origin + (grid.U * (target_u_local * grid.USpacing)) + (grid.V * (target_v_local * grid.VSpacing));
            
            // Keep Z
            targetPos = new XYZ(targetPos.X, targetPos.Y, current.Z);

            // Check tolerance
            if (targetPos.DistanceTo(current) > rules.snap_tolerance_ft)
            {
                return false; // Too far, unsafe
            }

            // Move
            XYZ moveVec = targetPos - current;
            if (moveVec.GetLength() > 0.001)
            {
                ElementTransformUtils.MoveElement(device.Document, device.Id, moveVec);
                return true;
            }

            return false;
        }
    }
}


