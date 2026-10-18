using System.Collections.Generic;

namespace RevitBridge.Common
{
    // Printed inches and typographic points, never model coordinates. This is a
    // deterministic source/layout contract; native creation and readback are separate.
    public sealed class XlsxTableLayoutOptions
    {
        public XlsxSourceRange? Range { get; set; }
        public double PageWidthInches { get; set; } = 37;
        public double PageHeightInches { get; set; } = 25;
        public double PaddingPoints { get; set; } = .5;
        public double MinimumTextPoints { get; set; } = 6.75;
        public double MaximumDigitWidthPixels { get; set; }
        public int RepeatHeaderRows { get; set; }
        public bool WrapOverflow { get; set; } = true;
    }
    public sealed class XlsxTableLayoutPlan
    {
        public string Schema { get; } = "operator.xlsx_table_layout.v1";
        public string SourceSha256 { get; set; } = "";
        public string Worksheet { get; set; } = "";
        public XlsxSourceRange Range { get; set; } = new XlsxSourceRange();
        public XlsxTableLayoutOptions Options { get; set; } = new XlsxTableLayoutOptions();
        public bool CalculationPerformed { get; } = false;
        public bool NativeImportVerified { get; } = false;
        public int MeasurementRequests { get; set; }
        public List<XlsxTablePage> Pages { get; } = new List<XlsxTablePage>();
        public List<XlsxTableCellCoverage> Coverage { get; } = new List<XlsxTableCellCoverage>();
        public List<XlsxSourceIssue> Issues { get; } = new List<XlsxSourceIssue>();
        public List<int> ExpandedRows { get; } = new List<int>();
        public List<string> EnlargedTextCells { get; } = new List<string>();
        public Dictionary<int, XlsxTableCellStyle> Styles { get; } = new Dictionary<int, XlsxTableCellStyle>();
    }
    public sealed class XlsxTablePage
    {
        public int Index { get; set; }
        public int RowBand { get; set; }
        public int ColumnBand { get; set; }
        public double WidthInches { get; set; }
        public double HeightInches { get; set; }
        public List<int> PrimaryRows { get; } = new List<int>();
        public List<int> RepeatedRows { get; } = new List<int>();
        public List<int> Columns { get; } = new List<int>();
        public List<XlsxTableCellFrame> Cells { get; } = new List<XlsxTableCellFrame>();
        public List<XlsxTableBorderSegment> Borders { get; } = new List<XlsxTableBorderSegment>();
    }
    public sealed class XlsxTableCellCoverage
    {
        public string Address { get; set; } = "";
        // selected_visible, hidden_row, hidden_column, merged_covered, outside_range
        public string State { get; set; } = "";
        public string AnchorAddress { get; set; } = "";
        public int? PrimaryPage { get; set; }
    }
    public sealed class XlsxTableCellFrame
    {
        public string Address { get; set; } = "";
        public int Row { get; set; }
        public int Column { get; set; }
        public XlsxSourceRange Range { get; set; } = new XlsxSourceRange();
        public double XInches { get; set; }
        public double YInches { get; set; }
        public double WidthInches { get; set; }
        public double HeightInches { get; set; }
        public bool RepeatedHeader { get; set; }
        public bool WrapText { get; set; }
        public double RenderFontPoints { get; set; }
        public double MinimumTextPoints { get; set; }
        public string Text { get; set; } = "";
        public string ValueState { get; set; } = "blank";
        public string SourceDataType { get; set; } = "n";
        public string? SourceRichTextXml { get; set; }
        public int StyleIndex => Style.Index;
        [System.Text.Json.Serialization.JsonIgnore]
        public XlsxTableCellStyle Style { get; set; } = new XlsxTableCellStyle();
    }
    public sealed class XlsxTableCellStyle
    {
        public int Index { get; set; }
        public string FontFamily { get; set; } = "";
        public double FontPoints { get; set; }
        public bool Bold { get; set; }
        public bool Italic { get; set; }
        public bool Underline { get; set; }
        public bool Strike { get; set; }
        public string VerticalScript { get; set; } = "baseline";
        public string Foreground { get; set; } = "#000000";
        public string? Background { get; set; }
        public string Horizontal { get; set; } = "general";
        public string Vertical { get; set; } = "bottom";
        public bool Wrap { get; set; }
        public int Rotation { get; set; }
        public int Indent { get; set; }
        public string NumberFormat { get; set; } = "General";
        public Dictionary<string, XlsxTableBorder> Borders { get; } = new Dictionary<string, XlsxTableBorder>();
        public string SourceStyleXml { get; set; } = "";
        public List<string> Unsupported { get; } = new List<string>();
    }
    public sealed class XlsxTableBorder
    {
        public string Style { get; set; } = "";
        public string Color { get; set; } = "#000000";
    }
    public sealed class XlsxTableBorderSegment
    {
        public double X1 { get; set; }
        public double Y1 { get; set; }
        public double X2 { get; set; }
        public double Y2 { get; set; }
        public string Style { get; set; } = "";
        public string Color { get; set; } = "#000000";
    }
    public sealed class XlsxTableTextMeasurement
    {
        public double WidthInches { get; set; }
        public double HeightInches { get; set; }
    }
    public sealed class XlsxCellDisplayValue
    {
        public string Text { get; set; } = "";
        public bool Supported { get; set; } = true;
        public string? Issue { get; set; }
    }
}
