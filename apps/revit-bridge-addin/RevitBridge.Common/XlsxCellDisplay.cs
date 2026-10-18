using System;
using System.Globalization;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace RevitBridge.Common
{
    public static class XlsxCellDisplay
    {
        // A deliberately explicit formatter, not an Excel calculation engine.
        // Unsupported formats retain raw values and an issue; a renderer must
        // not claim source-format fidelity for those cells.
        public static XlsxCellDisplayValue Format(XlsxSourceCell cell, string numberFormat)
        {
            if (cell == null) throw new ArgumentNullException(nameof(cell));
            if (cell.ValueState == "uncached_formula") return Unsupported("[UNCACHED FORMULA]", "formula_cache_missing");
            if (cell.DataType == "e" || cell.ValueState == "cached_formula_error")
                return new XlsxCellDisplayValue { Text = cell.Text ?? cell.RawValue ?? "[SOURCE ERROR]" };
            if (cell.DataType == "b")
            {
                var boolean = cell.RawValue ?? cell.Text;
                return boolean == "1" ? new XlsxCellDisplayValue { Text = "TRUE" } : boolean == "0" ? new XlsxCellDisplayValue { Text = "FALSE" }
                    : Unsupported(boolean ?? "", "invalid_boolean_source_value");
            }
            var text = cell.Text ?? "";
            if (cell.DataType != "n" || text.Length == 0) return new XlsxCellDisplayValue { Text = text };
            if (!decimal.TryParse(cell.RawValue ?? text, NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
                return Unsupported(text, "numeric_value_outside_decimal_display_range");
            if (value == 0 && double.TryParse(cell.RawValue ?? text, NumberStyles.Float, CultureInfo.InvariantCulture, out var binary) && binary != 0)
                return Unsupported(text, "numeric_value_outside_decimal_display_range");
            var format = string.IsNullOrEmpty(numberFormat) ? "General" : numberFormat;
            if (format == "General") return new XlsxCellDisplayValue { Text = value.ToString("G29", CultureInfo.InvariantCulture) };
            if (format == "@") return new XlsxCellDisplayValue { Text = text };
            var sections = Sections(format);
            if (sections == null || sections.Length > 4) return Unsupported(text, "unsupported_number_format");
            int section = value > 0 ? 0 : value < 0 ? Math.Min(1, sections.Length - 1) : Math.Min(2, sections.Length - 1);
            var selected = sections[section];
            var syntax = Syntax(selected);
            if (syntax == null || !Regex.IsMatch(syntax, "^[#0,.;%()+ -]*$"))
                return Unsupported(text, "unsupported_number_format:" + format);
            if (selected.Length == 0) return new XlsxCellDisplayValue(); // Explicit Excel hidden-number section.
            if (!syntax.Any(c => c == '0' || c == '#'))
            {
                // A literal zero/negative section is valid, but must not hide
                // unparsed formatting directives or substitute another value.
                return new XlsxCellDisplayValue { Text = Literal(selected) };
            }
            int decimals = 0;var point = syntax.IndexOf('.');
            if (point >= 0) decimals = syntax.Skip(point + 1).TakeWhile(c => c == '#' || c == '0').Count();
            int percents = syntax.Count(c => c == '%');
            if (decimals > 20 || percents > 2 || syntax.Contains(",,") || syntax.Contains(",.") || Regex.IsMatch(syntax, "[0#],+(?:[^0#,.]*)$"))
                return Unsupported(text, "unsupported_number_format:" + format);
            try
            {
                // Excel display rounds halves away from zero. Pre-round so
                // framework-specific custom-format rounding cannot change it.
                decimal scaled = value;for (int n = 0; n < percents; n++) scaled *= 100;
                var rounded = decimal.Round(scaled, decimals, MidpointRounding.AwayFromZero);
                for (int n = 0; n < percents; n++) rounded /= 100;
                return new XlsxCellDisplayValue { Text = rounded.ToString(format, CultureInfo.InvariantCulture) };
            }
            catch (Exception error) when (error is FormatException || error is OverflowException)
            { return Unsupported(text, "unsupported_number_format:" + format); }
        }
        private static XlsxCellDisplayValue Unsupported(string text, string issue) => new XlsxCellDisplayValue { Text = text, Supported = false, Issue = issue };
        private static string[]? Sections(string format)
        {
            var result = new System.Collections.Generic.List<string>();var current = new StringBuilder();bool quote = false;
            for (int i = 0; i < format.Length; i++)
            {
                var c = format[i];current.Append(c);
                if (c == '\\' && i + 1 < format.Length) { current.Append(format[++i]);continue; }
                if (c == '"') quote = !quote;
                if (c == ';' && !quote) { current.Length--;result.Add(current.ToString());current.Clear(); }
            }
            if (quote) return null;result.Add(current.ToString());return result.ToArray();
        }
        private static string? Syntax(string format)
        {
            var result = new StringBuilder();bool quote = false;
            for (int i = 0; i < format.Length; i++)
            {
                var c = format[i];if (c == '"') { quote = !quote;continue; }
                if (c == '\\') { if (++i >= format.Length) return null;continue; }
                if (!quote) result.Append(c);
            }
            return quote ? null : result.ToString();
        }
        private static string Literal(string format)
        {
            var result = new StringBuilder();bool quote = false;
            for (int i = 0; i < format.Length; i++)
            {
                if (format[i] == '"') { quote = !quote;continue; }
                if (format[i] == '\\' && i + 1 < format.Length) { result.Append(format[++i]);continue; }
                if (quote || format[i] != ';') result.Append(format[i]);
            }
            return result.ToString();
        }
    }
}
