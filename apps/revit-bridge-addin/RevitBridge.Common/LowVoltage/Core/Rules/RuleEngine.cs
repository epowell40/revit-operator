using System.Collections.Generic;
using RevitBridge.Common.LowVoltage.Core.Geometry;
using RevitBridge.Common.LowVoltage.Core.Graphs;
using RevitBridge.Common.LowVoltage.Core.Diagnostics;
using RevitBridge.Common.LowVoltage.Core.Placement;

namespace RevitBridge.Common.LowVoltage.Core.Rules
{
    public class LayoutContext
    {
        public string Discipline { get; set; } = string.Empty;
        public ModelState State { get; set; } = new ModelState();
        public SpaceGraph Graph { get; set; } = new SpaceGraph();
        public List<CandidatePoint> Candidates { get; set; } = new List<CandidatePoint>();
        public object? DisciplineProfile { get; set; }
        public string? TaskContext { get; set; }
        public DiagnosticReport Diagnostics { get; set; } = new DiagnosticReport();
    }

    public interface ILowVoltageRuleEngine
    {
        LayoutResult Evaluate(LayoutContext context);
    }
}
