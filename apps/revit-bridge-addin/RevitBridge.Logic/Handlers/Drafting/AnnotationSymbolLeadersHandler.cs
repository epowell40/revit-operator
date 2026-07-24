using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using Autodesk.Revit.DB;
using Autodesk.Revit.UI;
using RevitBridge.Common;

namespace RevitBridge.Logic.Handlers.Drafting
{
    public sealed class AnnotationSymbolLeadersHandler : IRequestHandler
    {
        public sealed class LeaderSpec
        {
            public List<double>? endXyz { get; set; }
            public List<double>? elbowXyz { get; set; }
        }

        public sealed class Params
        {
            public string? action { get; set; }
            public long elementId { get; set; }
            public List<LeaderSpec>? leaders { get; set; }
            public bool? dryRun { get; set; }
        }

        private sealed class LeaderSnapshot
        {
            public int index { get; set; }
            public string shape { get; set; } = "";
            public double[] anchorXyz { get; set; } = Array.Empty<double>();
            public double[] elbowXyz { get; set; } = Array.Empty<double>();
            public double[] endXyz { get; set; } = Array.Empty<double>();
        }

        public Task<object> Handle(UIApplication app, string jsonData)
        {
            var p = string.IsNullOrWhiteSpace(jsonData)
                ? new Params()
                : JsonSerializer.Deserialize<Params>(jsonData) ?? new Params();
            if (p.elementId <= 0)
                throw new InvalidOperationException("annotation-symbol-leaders.elementId is required.");

            var doc = app.ActiveUIDocument?.Document
                ?? throw new InvalidOperationException("No active Revit document.");
            var symbol = doc.GetElement(ElementIdCompat.Create(p.elementId)) as AnnotationSymbol
                ?? throw new InvalidOperationException(
                    $"Element {p.elementId} is not an Autodesk.Revit.DB.AnnotationSymbol.");

            var action = (p.action ?? "read").Trim().ToLowerInvariant();
            if (action == "read")
                return Task.FromResult<object>(BuildReadResult(symbol));
            if (action != "replace")
                throw new InvalidOperationException("annotation-symbol-leaders.action must be read or replace.");

            var requested = p.leaders ?? new List<LeaderSpec>();
            if (requested.Count > 16)
                throw new InvalidOperationException("annotation-symbol-leaders.leaders too large (max 16).");

            var resolved = requested
                .Select((leader, index) => new
                {
                    index,
                    end = ResolvePoint(leader.endXyz, $"leaders[{index}].endXyz"),
                    elbow = leader.elbowXyz == null
                        ? null
                        : ResolvePoint(leader.elbowXyz, $"leaders[{index}].elbowXyz")
                })
                .ToList();

            var before = ReadLeaders(symbol);
            var dryRun = p.dryRun ?? false;
            List<LeaderSnapshot> after;

            using (var tx = new Transaction(
                doc,
                dryRun ? "Replace Annotation Symbol Leaders (dry run)" : "Replace Annotation Symbol Leaders"))
            {
                tx.Start();
                try
                {
                    while (symbol.GetLeaders().Count > 0)
                        symbol.removeLeader();

                    foreach (var item in resolved)
                    {
                        symbol.addLeader();
                        doc.Regenerate();
                        var leaders = symbol.GetLeaders();
                        if (leaders.Count == 0)
                            throw new InvalidOperationException(
                                $"Annotation symbol {p.elementId} did not retain leader {item.index}.");

                        var leader = leaders[leaders.Count - 1];
                        leader.End = item.end;
                        if (item.elbow != null)
                            leader.Elbow = item.elbow;
                    }

                    doc.Regenerate();
                    after = ReadLeaders(symbol);
                    if (dryRun) tx.RollBack();
                    else tx.Commit();
                }
                catch
                {
                    if (tx.GetStatus() == TransactionStatus.Started)
                        tx.RollBack();
                    throw;
                }
            }

            var persisted = ReadLeaders(symbol);
            return Task.FromResult<object>(new
            {
                status = dryRun ? "Dry Run" : "Applied",
                dryRun,
                elementId = p.elementId,
                familyName = symbol.Symbol?.FamilyName,
                typeName = symbol.Symbol?.Name,
                before,
                after,
                persisted,
                rollbackVerified = dryRun ? Equivalent(before, persisted) : (bool?)null
            });
        }

        private static object BuildReadResult(AnnotationSymbol symbol)
        {
            return new
            {
                status = "Read",
                dryRun = false,
                elementId = ElementIdCompat.GetValue(symbol.Id),
                familyName = symbol.Symbol?.FamilyName,
                typeName = symbol.Symbol?.Name,
                leaders = ReadLeaders(symbol)
            };
        }

        private static List<LeaderSnapshot> ReadLeaders(AnnotationSymbol symbol)
        {
            return symbol.GetLeaders()
                .Select((leader, index) => new LeaderSnapshot
                {
                    index = index,
                    shape = leader.LeaderShape.ToString(),
                    anchorXyz = ToArray(leader.Anchor),
                    elbowXyz = ToArray(leader.Elbow),
                    endXyz = ToArray(leader.End)
                })
                .ToList();
        }

        private static XYZ ResolvePoint(List<double>? xyz, string field)
        {
            if (xyz == null || xyz.Count != 3 || xyz.Any(value => double.IsNaN(value) || double.IsInfinity(value)))
                throw new InvalidOperationException($"annotation-symbol-leaders.{field} must contain exactly 3 finite numbers in feet.");
            return new XYZ(xyz[0], xyz[1], xyz[2]);
        }

        private static double[] ToArray(XYZ point)
        {
            return new[] { point.X, point.Y, point.Z };
        }

        private static bool Equivalent(IReadOnlyList<LeaderSnapshot> expected, IReadOnlyList<LeaderSnapshot> actual)
        {
            if (expected.Count != actual.Count) return false;
            for (var i = 0; i < expected.Count; i++)
            {
                if (!string.Equals(expected[i].shape, actual[i].shape, StringComparison.OrdinalIgnoreCase)) return false;
                if (!Equivalent(expected[i].anchorXyz, actual[i].anchorXyz)) return false;
                if (!Equivalent(expected[i].elbowXyz, actual[i].elbowXyz)) return false;
                if (!Equivalent(expected[i].endXyz, actual[i].endXyz)) return false;
            }
            return true;
        }

        private static bool Equivalent(IReadOnlyList<double> expected, IReadOnlyList<double> actual)
        {
            if (expected.Count != actual.Count) return false;
            for (var i = 0; i < expected.Count; i++)
            {
                if (Math.Abs(expected[i] - actual[i]) > 1e-8) return false;
            }
            return true;
        }
    }
}
