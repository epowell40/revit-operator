using System.Collections.Generic;

namespace RevitBridge.Common
{
    // Source data only. Neither reading this manifest nor resolving numbering verifies a Revit import.
    public sealed class DrawingSpecSourceManifest
    {
        public string Schema { get; } = "operator.drawing_spec_source.v1";
        public string SourceSha256 { get; set; } = "";
        public bool NativeLayoutQualified { get; } = false;
        public bool BodyTextComplete { get; set; } = true;
        public List<DrawingSpecBlock> Blocks { get; } = new List<DrawingSpecBlock>();
        public List<DrawingSpecSourcePart> Parts { get; } = new List<DrawingSpecSourcePart>();
        public List<DrawingSpecWarning> Warnings { get; } = new List<DrawingSpecWarning>();
    }

    public sealed class DrawingSpecSourcePart
    {
        public string Path { get; set; } = "";
        public string Sha256 { get; set; } = "";
        public long Bytes { get; set; }
        // Retained only for source structure/styles/numbering/running matter. Never prompt-inject this archive.
        public string? Xml { get; set; }
    }

    public sealed class DrawingSpecWarning
    {
        public string Code { get; set; } = "";
        public string SourcePath { get; set; } = "";
    }

    public sealed class DrawingSpecBlock
    {
        public string SourcePath { get; set; } = "";
        public string ContentSha256 { get; set; } = "";
        public string Kind { get; set; } = "";
        public string? StyleId { get; set; }
        public string Text { get; set; } = "";
        public string? NumberingMarker { get; set; }
        public string NumberingSuffix { get; set; } = "";
        public int? NumberingLevel { get; set; }
        public string PropertiesXml { get; set; } = "";
        public List<DrawingSpecRun> Runs { get; } = new List<DrawingSpecRun>();
        public List<DrawingSpecBlock> Children { get; } = new List<DrawingSpecBlock>();
    }

    public sealed class DrawingSpecRun
    {
        public string Text { get; set; } = "";
        public string PropertiesXml { get; set; } = "";
    }
}
