using System;
using System.Collections.Generic;

namespace RevitBridge.Common
{
    // Source ranges come from the retained import ledger; values come from a new native read.
    // Neither this data nor a producer snapshot is itself a whole-task verification verdict.
    public sealed class DrawingSpecInspectionSegment
    {
        public string SourceId { get; set; } = "";
        public int Start { get; set; }
        public int Length { get; set; }
        public string Kind { get; set; } = "text";
        public long NoteId { get; set; }
        public string UniqueId { get; set; } = "";
        public long ViewId { get; set; }
    }

    public sealed class DrawingSpecObservedRange
    {
        public int Start { get; set; }
        public int Length { get; set; }
        public string Text { get; set; } = "";
        public string Bold { get; set; } = "";
        public string Italic { get; set; } = "";
        public string Underline { get; set; } = "";
        public string AllCaps { get; set; } = "";
        public string Superscript { get; set; } = "";
        public string Subscript { get; set; } = "";
    }

    public sealed class DrawingSpecObservedNote
    {
        public long Id { get; set; }
        public string UniqueId { get; set; } = "";
        public long OwnerViewId { get; set; }
        public string Text { get; set; } = "";
        public long TypeId { get; set; }
        public string TypeUniqueId { get; set; } = "";
        public string OwnerViewName { get; set; } = "";
        public string Font { get; set; } = "";
        public double TextSizeFt { get; set; }
        public int Color { get; set; }
        public bool TypeBold { get; set; }
        public bool TypeItalic { get; set; }
        public bool TypeUnderline { get; set; }
        public double WidthScale { get; set; }
        public int Background { get; set; }
        public int Page { get; set; }
        public double XPaperInches { get; set; }
        public double YPaperInches { get; set; }
        public double WidthPaperInches { get; set; }
        public double HeightPaperInches { get; set; }
        public List<DrawingSpecObservedRange> Ranges { get; set; } = new List<DrawingSpecObservedRange>();
    }

    public sealed class DrawingSpecInspectionIssue
    {
        public string Code { get; set; } = "";
        public string SourceId { get; set; } = "";
        public long? NoteId { get; set; }
        public int? Start { get; set; }
        public string Detail { get; set; } = "";
    }

    public sealed class DrawingSpecInspectionResult
    {
        public int SourceParagraphs { get; set; }
        public int SourceCharacters { get; set; }
        public int NativeNotes { get; set; }
        public int NativeRanges { get; set; }
        public int IssueCount { get; set; }
        public List<DrawingSpecInspectionIssue> Issues { get; } = new List<DrawingSpecInspectionIssue>();
        public bool SourceCoverageMatches { get; set; } = true;
        public bool NativeTextMatches { get; set; } = true;
        public bool NativeIdentityAndOwnershipMatches { get; set; } = true;
        public bool SourceFormattingMatches { get; set; } = true;
        public bool? InsideColumnBounds { get; set; }
        public bool? ReadingOrderMatches { get; set; }
        public bool VisualFidelityVerified => false;
        public bool SheetPlacementVerified => false;
        public bool WholeTaskVerified => false;
    }
}
