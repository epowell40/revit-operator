using System;
using System.Collections.Generic;
using System.Linq;

namespace RevitBridge.Common.FamilyEvolution
{
    // Values are explicitly internal feet; this contract does not infer product
    // dimensions, engineering ratings, connectors or manufacturer provenance.
    public sealed class PrimitiveFamilyShape
    {
        public string id { get; set; } = "body";
        public string kind { get; set; } = "box";
        public double? widthFt { get; set; }
        public double? depthFt { get; set; }
        public double? diameterFt { get; set; }
        public double heightFt { get; set; }
        public double[] originFeet { get; set; } = new double[] { 0, 0, 0 };
        public double rotationDegrees { get; set; }
    }

    public sealed class PrimitiveFamilyDefinition
    {
        public string category { get; set; } = "Generic Models";
        public string typeName { get; set; } = "Generic";
        public bool instanceDimensions { get; set; } = true;
        public List<PrimitiveFamilyShape> shapes { get; set; } = new List<PrimitiveFamilyShape>();

        public void Validate()
        {
            if (!new[] { "Generic Models", "Mechanical Equipment", "Electrical Equipment", "Plumbing Fixtures" }.Contains(category))
                throw new ArgumentException("Unsupported generic family category.");
            if (string.IsNullOrWhiteSpace(typeName) || typeName.Length > 100 || typeName.Any(char.IsControl)
                || typeName.IndexOfAny(new[] { '\\', '/', ':', '{', '}', '[', ']', '|', ';', '<', '>', '?', '`', '~' }) >= 0)
                throw new ArgumentException("A valid family type name is required.");
            if (shapes == null || shapes.Count < 1 || shapes.Count > 16)
                throw new ArgumentException("Supply one to sixteen basic family shapes.");
            var ids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var shape in shapes)
            {
                if (shape == null || string.IsNullOrEmpty(shape.id) || shape.id.Length > 40
                    || !Letter(shape.id[0]) || shape.id.Any(c => !Letter(c) && (c < '0' || c > '9') && c != '_') || !ids.Add(shape.id))
                    throw new ArgumentException("Shape IDs must be distinct simple parameter prefixes.");
                if (shape.kind != "box" && shape.kind != "cylinder") throw new ArgumentException("Shape kind must be box or cylinder.");
                Length(shape.heightFt);
                if (shape.kind == "box")
                {
                    if (!shape.widthFt.HasValue || !shape.depthFt.HasValue || shape.diameterFt.HasValue)
                        throw new ArgumentException("A box needs widthFt/depthFt, without diameterFt.");
                    Length(shape.widthFt.Value); Length(shape.depthFt.Value);
                }
                else
                {
                    if (!shape.diameterFt.HasValue || shape.widthFt.HasValue || shape.depthFt.HasValue)
                        throw new ArgumentException("A cylinder needs diameterFt, without widthFt/depthFt.");
                    Length(shape.diameterFt.Value);
                }
                if (shape.originFeet == null || shape.originFeet.Length != 3 || shape.originFeet.Any(v => !Finite(v) || Math.Abs(v) > 10000)
                    || !Finite(shape.rotationDegrees) || Math.Abs(shape.rotationDegrees) > 360)
                    throw new ArgumentException("Supply a finite bounded origin and rotation.");
            }
        }

        public string ParameterName(PrimitiveFamilyShape shape, string dimension) =>
            shapes.Count == 1 ? dimension : shape.id + "_" + dimension;

        private static bool Finite(double n) => !double.IsNaN(n) && !double.IsInfinity(n);
        private static bool Letter(char c) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
        private static void Length(double n)
        {
            if (!Finite(n) || n < 1.0 / 192.0 || n > 1000)
                throw new ArgumentException("Family dimensions must be finite, between 1/16 inch and 1000 feet.");
        }
    }
}
