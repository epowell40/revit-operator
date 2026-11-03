using System;
using System.Collections.Generic;
using System.Linq;
using Autodesk.Revit.DB;
using RevitBridge.Common;
using RevitBridge.Common.FamilyEvolution;

namespace RevitBridge.Logic.Handlers
{
    // Family-owned geometry only. Never expands the active-project mutation graph
    // to accept arbitrary documents or treats generic geometry as MEP connectors.
    internal static class PrimitiveFamilyBuilder
    {
        private sealed class FamilyFailures : IFailuresPreprocessor
        {
            internal readonly List<string> Messages = new List<string>();
            public FailureProcessingResult PreprocessFailures(FailuresAccessor accessor)
            {
                var error = false;
                foreach (var failure in accessor.GetFailureMessages())
                {
                    Messages.Add(failure.GetDescriptionText());
                    if (failure.GetSeverity() == FailureSeverity.Warning) accessor.DeleteWarning(failure);
                    else error = true;
                }
                return error ? FailureProcessingResult.ProceedWithRollBack : FailureProcessingResult.Continue;
            }
        }
        private sealed class Body
        {
            public PrimitiveFamilyShape Shape = null!;
            public Extrusion Extrusion = null!;
            public Dictionary<string, FamilyParameter> Parameters = new Dictionary<string, FamilyParameter>();
        }

        internal static object Build(Document doc, PrimitiveFamilyDefinition definition)
        {
            definition.Validate();
            if (!doc.IsFamilyDocument || doc.OwnerFamily.IsInPlace || doc.OwnerFamily.IsCurtainPanelFamily)
                throw new InvalidOperationException("Basic geometry requires a loadable, non-adaptive model family template.");
            if (new FilteredElementCollector(doc).OfClass(typeof(GenericForm)).Any())
                throw new InvalidOperationException("Use an empty model family template; existing forms will not be replaced.");
            var plan = new FilteredElementCollector(doc).OfClass(typeof(ViewPlan)).Cast<ViewPlan>()
                .FirstOrDefault(v => !v.IsTemplate && v.ViewDirection.IsAlmostEqualTo(XYZ.BasisZ));
            if (plan == null) throw new InvalidOperationException("Template needs a horizontal family plan view.");
            var category = definition.category == "Mechanical Equipment" ? BuiltInCategory.OST_MechanicalEquipment
                : definition.category == "Electrical Equipment" ? BuiltInCategory.OST_ElectricalEquipment
                : definition.category == "Plumbing Fixtures" ? BuiltInCategory.OST_PlumbingFixtures
                : BuiltInCategory.OST_GenericModel;
            var bodies = new List<Body>();
            var failures = new FamilyFailures();
            using (var tx = new Transaction(doc, "Create adjustable generic family"))
            {
                tx.Start();
                tx.SetFailureHandlingOptions(tx.GetFailureHandlingOptions().SetFailuresPreprocessor(failures).SetClearAfterRollback(true));
                try
                {
                    doc.OwnerFamily.FamilyCategory = Category.GetCategory(doc, category);
                    var manager = doc.FamilyManager;
                    var types = manager.Types.Cast<FamilyType>().ToList();
                    manager.CurrentType = types.FirstOrDefault(t => t.Name == definition.typeName) ?? manager.NewType(definition.typeName);
                    foreach (var shape in definition.shapes)
                    {
                        var body = CreateBody(doc, plan, definition, shape);
                        bodies.Add(body);
                    }
                    doc.Regenerate();
                    // Flex native constraints, inspect the resulting form bounds, then
                    // roll back the probe. These are diagnostics, not independent proof.
                    using (var flex = new SubTransaction(doc))
                    {
                        flex.Start();
                        foreach (var body in bodies)
                            foreach (var dimension in body.Parameters)
                                manager.Set(dimension.Value, Size(body.Shape, dimension.Key) * 1.25);
                        doc.Regenerate();
                        foreach (var body in bodies) CheckBounds(body, 1.25);
                        flex.RollBack();
                    }
                    doc.Regenerate();
                    foreach (var body in bodies) CheckBounds(body, 1);
                    if (tx.Commit() != TransactionStatus.Committed)
                        throw new InvalidOperationException("Generic family creation did not commit: " + string.Join("; ", failures.Messages));
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started) tx.RollBack();
                    throw;
                }
            }
            return new
            {
                representation = "generic_basic_geometry", category = definition.category,
                typeName = definition.typeName, dimensionScope = definition.instanceDimensions ? "instance" : "type",
                flexDiagnostic = "native_bounds_checked_and_probe_rolled_back",
                nativeWarnings = failures.Messages.ToArray(),
                bodies = bodies.Select(b => new
                {
                    shapeId = b.Shape.id, kind = b.Shape.kind, elementId = ElementIdCompat.GetValue(b.Extrusion.Id),
                    parameters = b.Parameters.Select(p => new { name = p.Value.Definition.Name, valueFt = Size(b.Shape, p.Key) }).ToArray()
                }).ToArray(),
                note = "Generic representation; no manufacturer identity, ratings or MEP connectors are inferred. Custom schedule data must use schedulable shared/project parameters."
            };
        }

        private static Body CreateBody(Document doc, ViewPlan view, PrimitiveFamilyDefinition definition, PrimitiveFamilyShape shape)
        {
            var body = new Body { Shape = shape };
            var origin = new XYZ(shape.originFeet[0], shape.originFeet[1], shape.originFeet[2]);
            var angle = shape.rotationDegrees * Math.PI / 180;
            var x = new XYZ(Math.Cos(angle), Math.Sin(angle), 0);
            var y = new XYZ(-Math.Sin(angle), Math.Cos(angle), 0);
            var plane = SketchPlane.Create(doc, Plane.CreateByNormalAndOrigin(XYZ.BasisZ, origin));
            var profile = new CurveArray();
            if (shape.kind == "box")
            {
                var w = shape.widthFt!.Value; var d = shape.depthFt!.Value;
                var points = new[] { origin, origin + x * w, origin + x * w + y * d, origin + y * d };
                for (var i = 0; i < 4; i++) profile.Append(Line.CreateBound(points[i], points[(i + 1) % 4]));
            }
            else profile.Append(Arc.Create(origin, shape.diameterFt!.Value / 2, 0, 2 * Math.PI, x, y));
            var profiles = new CurveArrArray(); profiles.Append(profile);
            body.Extrusion = doc.FamilyCreate.NewExtrusion(true, profiles, plane, shape.heightFt);
            var height = AddLength(doc, definition, shape, "Height", shape.heightFt);
            body.Parameters.Add("Height", height);
            doc.FamilyManager.AssociateElementParameterToFamilyParameter(body.Extrusion.get_Parameter(BuiltInParameter.EXTRUSION_END_PARAM), height);
            doc.Regenerate();
            var curves = body.Extrusion.Sketch.Profile.Cast<CurveArray>().SelectMany(a => a.Cast<Curve>()).ToList();
            if (shape.kind == "box")
            {
                var w = shape.widthFt!.Value; var d = shape.depthFt!.Value;
                // Plane references are persistent family-owned geometry. Detached
                // profile Lines do not have usable native constraint references.
                var left = RefPlane(doc, view, origin, y, shape.id + " left");
                var right = RefPlane(doc, view, origin + x * w, y, shape.id + " right");
                var bottom = RefPlane(doc, view, origin, x, shape.id + " bottom");
                var top = RefPlane(doc, view, origin + y * d, x, shape.id + " top");
                left.Pinned = true; bottom.Pinned = true;
                doc.Regenerate();
                Align(doc, view, left, curves, origin, y);
                Align(doc, view, right, curves, origin + x * w, y);
                Align(doc, view, bottom, curves, origin, x);
                Align(doc, view, top, curves, origin + y * d, x);
                var width = AddLength(doc, definition, shape, "Width", w);
                var depth = AddLength(doc, definition, shape, "Length", d);
                Label(doc, view, left, right, origin - y, x, w, width);
                Label(doc, view, bottom, top, origin - x, y, d, depth);
                body.Parameters.Add("Width", width); body.Parameters.Add("Length", depth);
            }
            else
            {
                var arc = curves.OfType<Arc>().FirstOrDefault(c => c.Reference != null)
                    ?? throw new InvalidOperationException("Cylinder sketch has no native arc reference.");
                var diameter = AddLength(doc, definition, shape, "Diameter", shape.diameterFt!.Value);
                var radius = AddLength(doc, definition, shape, "Radius", shape.diameterFt.Value / 2);
                doc.FamilyManager.SetFormula(radius, definition.ParameterName(shape, "Diameter") + " / 2");
                doc.FamilyCreate.NewRadialDimension(view, arc.Reference, origin + x * shape.diameterFt.Value).FamilyLabel = radius;
                body.Parameters.Add("Diameter", diameter);
            }
            return body;
        }

        private static FamilyParameter AddLength(Document doc, PrimitiveFamilyDefinition definition, PrimitiveFamilyShape shape, string name, double value)
        {
            var parameterName = definition.ParameterName(shape, name);
            if (doc.FamilyManager.get_Parameter(parameterName) != null)
                throw new InvalidOperationException("Template already has parameter " + parameterName + "; use an empty generic template.");
            var p = doc.FamilyManager.AddParameter(parameterName, GroupTypeId.Geometry, SpecTypeId.Length, definition.instanceDimensions);
            doc.FamilyManager.Set(p, value);
            return p;
        }

        private static ReferencePlane RefPlane(Document doc, View view, XYZ point, XYZ tangent, string name)
        {
            var plane = doc.FamilyCreate.NewReferencePlane(point - tangent * 2, point + tangent * 2, XYZ.BasisZ, view);
            plane.Name = name;
            return plane;
        }

        private static void Align(Document doc, View view, ReferencePlane plane, List<Curve> curves, XYZ point, XYZ tangent)
        {
            var match = curves.OfType<Line>().Single(c => c.Direction.CrossProduct(tangent).GetLength() < 1e-8
                && (c.GetEndPoint(0) - point).CrossProduct(tangent).GetLength() < 1e-7);
            doc.FamilyCreate.NewAlignment(view, plane.GetReference(), match.Reference);
        }

        private static void Label(Document doc, View view, ReferencePlane a, ReferencePlane b, XYZ origin, XYZ direction, double length, FamilyParameter parameter)
        {
            var references = new ReferenceArray(); references.Append(a.GetReference()); references.Append(b.GetReference());
            doc.FamilyCreate.NewLinearDimension(view, Line.CreateBound(origin, origin + direction * length), references).FamilyLabel = parameter;
        }

        private static double Size(PrimitiveFamilyShape shape, string name) => name == "Height" ? shape.heightFt
            : name == "Width" ? shape.widthFt!.Value : name == "Length" ? shape.depthFt!.Value : shape.diameterFt!.Value;

        private static void CheckBounds(Body body, double factor)
        {
            var bounds = body.Extrusion.get_BoundingBox(null) ?? throw new InvalidOperationException("Generic form has no bounding box.");
            var size = bounds.Max - bounds.Min;
            var angle = body.Shape.rotationDegrees * Math.PI / 180;
            var expectedX = body.Shape.kind == "box"
                ? (Math.Abs(Math.Cos(angle)) * body.Shape.widthFt!.Value + Math.Abs(Math.Sin(angle)) * body.Shape.depthFt!.Value) * factor
                : body.Shape.diameterFt!.Value * factor;
            var expectedY = body.Shape.kind == "box"
                ? (Math.Abs(Math.Sin(angle)) * body.Shape.widthFt!.Value + Math.Abs(Math.Cos(angle)) * body.Shape.depthFt!.Value) * factor
                : body.Shape.diameterFt!.Value * factor;
            if (Math.Abs(size.X - expectedX) > 1e-5 || Math.Abs(size.Y - expectedY) > 1e-5
                || Math.Abs(size.Z - body.Shape.heightFt * factor) > 1e-5)
                throw new InvalidOperationException("Native generic geometry did not follow its dimension parameters: " + body.Shape.id);
        }
    }
}
