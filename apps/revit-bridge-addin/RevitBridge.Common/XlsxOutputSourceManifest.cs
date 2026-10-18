using System.Collections.Generic;

namespace RevitBridge.Common
{
    // Source facts only. Cached results are not recalculation or native import proof.
    public sealed class XlsxOutputSourceManifest
    {
        public string Schema { get; } = "operator.xlsx_output_source.v1";
        public string SourceSha256 { get; set; } = "";
        public bool CalculationPerformed { get; } = false;
        public bool NativeImportVerified { get; } = false;
        public List<XlsxSourceSheetIdentity> Worksheets { get; } = new List<XlsxSourceSheetIdentity>();
        public XlsxSourceSheet? SelectedSheet { get; set; }
        public Dictionary<string, string> FormattingParts { get; } = new Dictionary<string, string>();
        public List<string> ExternalLinkParts { get; } = new List<string>();
        public List<string> ActiveContentParts { get; } = new List<string>();
        public List<XlsxSourceIssue> Issues { get; } = new List<XlsxSourceIssue>();
    }
    public sealed class XlsxSourceSheetIdentity
    {
        public int Index { get; set; }
        public string Name { get; set; } = "";
        public string Part { get; set; } = "";
        public string State { get; set; } = "visible";
        public string Kind { get; set; } = "worksheet";
    }
    public sealed class XlsxSourceIssue
    {
        public string Code { get; set; } = "";
        public string Address { get; set; } = "";
    }
    public sealed class XlsxSourceSheet
    {
        public XlsxSourceSheetIdentity Identity { get; set; } = new XlsxSourceSheetIdentity();
        public string SourcePartSha256 { get; set; } = "";
        public string ReportedDimension { get; set; } = "";
        public double? DefaultRowHeightPoints { get; set; }
        public double? DefaultColumnWidthCharacters { get; set; }
        public string PrintContextXml { get; set; } = "";
        public XlsxSourceRange Bounds { get; set; } = new XlsxSourceRange();
        public List<XlsxSourceRow> Rows { get; } = new List<XlsxSourceRow>();
        public List<XlsxSourceColumn> Columns { get; } = new List<XlsxSourceColumn>();
        public List<XlsxSourceCell> Cells { get; } = new List<XlsxSourceCell>();
        public List<XlsxSourceRange> Merges { get; } = new List<XlsxSourceRange>();
        public int FormulaCount { get; set; }
        public int CachedErrorCount { get; set; }
        public int ErrorCellCount { get; set; }
        public int MissingFormulaCacheCount { get; set; }
    }
    public sealed class XlsxSourceRow
    {
        public int Index { get; set; }
        public double? HeightPoints { get; set; }
        public bool Hidden { get; set; }
        public int? StyleIndex { get; set; }
        public string PropertiesXml { get; set; } = "";
    }
    public sealed class XlsxSourceColumn
    {
        public int First { get; set; }
        public int Last { get; set; }
        public double? WidthCharacters { get; set; }
        public bool Hidden { get; set; }
        public int? StyleIndex { get; set; }
        public string PropertiesXml { get; set; } = "";
    }
    public sealed class XlsxSourceCell
    {
        public string Address { get; set; } = "";
        public int Row { get; set; }
        public int Column { get; set; }
        public int? StyleIndex { get; set; }
        public string DataType { get; set; } = "n";
        public string? RawValue { get; set; }
        public string? Text { get; set; }
        public string ValueState { get; set; } = "blank";
        public bool HasFormula { get; set; }
        public bool HasCachedValue { get; set; }
        public string? FormulaXml { get; set; }
        public string? RichTextXml { get; set; }
        public string SourceXml { get; set; } = "";
    }
    public sealed class XlsxSourceRange
    {
        public string Address { get; set; } = "";
        public int FirstRow { get; set; }
        public int LastRow { get; set; }
        public int FirstColumn { get; set; }
        public int LastColumn { get; set; }
    }
}
